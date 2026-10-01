import {
  ProtocolError,
  record,
  string,
  upstreamError,
  type Block,
  type JsonObject,
} from './protocol.js';
import { outputBlocks, toMessage } from './translate.js';

export type SseEvent = { event?: string; data: string };
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array>,
  maxFrameBytes = 8 * 1024 * 1024,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf8', { fatal: true });
  let buffer = '',
    data: string[] = [],
    event: string | undefined,
    frameSize = 0;
  function line(raw: string): SseEvent | undefined {
    frameSize += Buffer.byteLength(raw, 'utf8') + 1;
    if (frameSize > maxFrameBytes) upstreamError('SSE frame exceeds configured size limit');
    if (raw === '') {
      const result = data.length ? { event, data: data.join('\n') } : undefined;
      data = [];
      event = undefined;
      frameSize = 0;
      return result;
    }
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  function* drain(final = false): Generator<SseEvent> {
    while (true) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const i = match.index;
      if (buffer[i] === '\r' && i === buffer.length - 1 && !final) break;
      const width = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + width);
      const value = line(raw);
      if (value) yield value;
    }
    if (Buffer.byteLength(buffer, 'utf8') + frameSize > maxFrameBytes)
      upstreamError('SSE frame exceeds configured size limit');
  }
  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      yield* drain();
    }
    buffer += decoder.decode();
    yield* drain(true);
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    return upstreamError('Invalid or interrupted upstream SSE stream');
  }
  // SSE requires a blank line to dispatch; an unterminated final frame is discarded.
}
export function sse(event: JsonObject): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
type Part = {
  index: number;
  text: string;
  kind: 'text' | 'thinking' | 'tool_use';
  closed: boolean;
};
type State = {
  item: JsonObject;
  parts: Map<number, Part>;
  done: boolean;
  final?: unknown;
  summaryIndex?: number;
};
async function* translateOrderedStream(
  events: AsyncIterable<SseEvent>,
  model: string,
): AsyncGenerator<JsonObject> {
  let started = false,
    terminal = false,
    nextIndex = 0,
    responseId: string | undefined;
  const states = new Map<number, State>();
  const start = (response: JsonObject): JsonObject => {
    started = true;
    responseId = string(response.id, 'response id');
    return {
      type: 'message_start',
      message: {
        id: string(response.id, 'response id'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  };
  const open = (state: State, key: number, block: Block, kind: Part['kind']): JsonObject => {
    if (state.parts.has(key)) return upstreamError('Duplicate stream content part');
    const part: Part = { index: nextIndex++, text: '', kind, closed: false };
    state.parts.set(key, part);
    return { type: 'content_block_start', index: part.index, content_block: block };
  };
  const delta = (part: Part, text: string): JsonObject => {
    if (part.closed) return upstreamError('Delta after content block closed');
    part.text += text;
    return {
      type: 'content_block_delta',
      index: part.index,
      delta:
        part.kind === 'tool_use'
          ? { type: 'input_json_delta', partial_json: text }
          : part.kind === 'thinking'
            ? { type: 'thinking_delta', thinking: text }
            : { type: 'text_delta', text },
    };
  };
  const close = (part: Part): JsonObject => {
    part.closed = true;
    return { type: 'content_block_stop', index: part.index };
  };
  function* finish(state: State, item: unknown): Generator<JsonObject> {
    if (state.done) return upstreamError('Duplicate completed output item');
    const blocks = outputBlocks(item);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      let part = state.parts.get(i);
      if (block.type === 'redacted_thinking') {
        if (part) return upstreamError('Reasoning summary disappeared at completion');
        yield { type: 'content_block_start', index: nextIndex, content_block: block };
        yield { type: 'content_block_stop', index: nextIndex++ };
        continue;
      }
      if (block.type !== 'text' && block.type !== 'thinking' && block.type !== 'tool_use')
        return upstreamError('Unsupported stream block');
      const kind = block.type;
      if (!part) {
        yield open(
          state,
          i,
          kind === 'text'
            ? { type: 'text', text: '' }
            : kind === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : {
                  type: 'tool_use',
                  id: (block as Extract<Block, { type: 'tool_use' }>).id,
                  name: (block as Extract<Block, { type: 'tool_use' }>).name,
                  input: {},
                },
          kind,
        );
        part = state.parts.get(i)!;
      }
      if (part.kind !== kind) return upstreamError('Upstream changed content type');
      if (
        block.type === 'tool_use' &&
        (state.item.call_id !== block.id || state.item.name !== block.name)
      )
        return upstreamError('Tool call identity changed during streaming');
      const full =
        block.type === 'text'
          ? block.text
          : block.type === 'thinking'
            ? block.thinking
            : string(record(item).arguments, 'arguments');
      if (!full.startsWith(part.text))
        return upstreamError('Final output disagrees with streamed deltas');
      const tail = full.slice(part.text.length);
      if (tail) yield delta(part, tail);
      if (block.type === 'thinking')
        yield {
          type: 'content_block_delta',
          index: part.index,
          delta: { type: 'signature_delta', signature: block.signature },
        };
      yield close(part);
    }
    if (state.parts.size > blocks.length)
      return upstreamError('Final output dropped content parts');
    state.done = true;
    state.final = item;
  }
  for await (const frame of events) {
    if (terminal) {
      if (frame.data === '[DONE]') continue;
      return upstreamError('Event after stream completion');
    }
    if (frame.data === '[DONE]')
      return upstreamError('Stream ended without a terminal Responses event');
    let event: JsonObject;
    try {
      event = record(JSON.parse(frame.data));
    } catch {
      return upstreamError('Malformed upstream SSE JSON');
    }
    const type = string(event.type, 'event type');
    if (frame.event && frame.event !== type)
      return upstreamError('SSE event name disagrees with payload');
    if (type === 'error' || type === 'response.failed')
      return upstreamError('Upstream Responses stream failed');
    if (type === 'response.created' || type === 'response.in_progress') {
      if (!started) yield start(record(event.response));
      continue;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = record(event.response);
      if (responseId !== undefined && response.id !== responseId)
        return upstreamError('Response ID changed during streaming');
      if (response.status !== (type === 'response.completed' ? 'completed' : 'incomplete'))
        return upstreamError('Terminal event status mismatch');
      const finalMessage = toMessage(response, model);
      if (!started) yield start(response);
      const output = response.output as unknown[];
      for (let i = 0; i < output.length; i++) {
        const item = record(output[i]);
        let state = states.get(i);
        if (!state) {
          state = { item, parts: new Map(), done: false };
          states.set(i, state);
        }
        if (!state.done) yield* finish(state, item);
        else if (JSON.stringify(outputBlocks(state.final)) !== JSON.stringify(outputBlocks(item)))
          return upstreamError('Terminal response disagrees with completed item');
      }
      if ([...states.keys()].some((i) => i >= output.length))
        return upstreamError('Terminal response dropped an output item');
      yield {
        type: 'message_delta',
        delta: { stop_reason: finalMessage.stop_reason, stop_sequence: null },
        usage: finalMessage.usage,
      };
      yield { type: 'message_stop' };
      terminal = true;
      continue;
    }
    if (!started) return upstreamError('Output event before response.created');
    if (type === 'response.output_item.added') {
      const idx = event.output_index;
      if (typeof idx !== 'number' || !Number.isSafeInteger(idx) || idx < 0 || states.has(idx))
        return upstreamError('Invalid or duplicate output index');
      const item = record(event.item);
      string(item.id, 'output item id');
      const state: State = { item, parts: new Map(), done: false };
      states.set(idx, state);
      if (item.type === 'function_call')
        yield open(
          state,
          0,
          {
            type: 'tool_use',
            id: string(item.call_id, 'call_id'),
            name: string(item.name, 'function name'),
            input: {},
          },
          'tool_use',
        );
      else if (item.type !== 'message' && item.type !== 'reasoning')
        return upstreamError(`Unsupported streaming output item: ${item.type}`);
      continue;
    }
    if (type === 'response.output_item.done') {
      const state = states.get(event.output_index as number);
      if (!state) return upstreamError('Completed unknown output item');
      if (record(event.item).id !== state.item.id) return upstreamError('Output item ID changed');
      yield* finish(state, event.item);
      continue;
    }
    if (
      [
        'response.output_text.delta',
        'response.refusal.delta',
        'response.function_call_arguments.delta',
        'response.reasoning_summary_text.delta',
        'response.reasoning_text.delta',
      ].includes(type)
    ) {
      const state = states.get(event.output_index as number);
      if (!state || state.done) return upstreamError('Delta for unknown or completed output item');
      if (event.item_id !== state.item.id) return upstreamError('Delta item ID mismatch');
      const reasoning = type.includes('reasoning');
      const tool = type.includes('function_call');
      if (state.item.type !== (reasoning ? 'reasoning' : tool ? 'function_call' : 'message'))
        return upstreamError('Delta type does not match output item');
      const key = tool || reasoning ? 0 : event.content_index;
      if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0)
        return upstreamError('Invalid content index');
      if (!state.parts.has(key) && key > state.parts.size)
        return upstreamError('Out-of-order content parts are unsupported');
      if (!state.parts.has(key))
        yield open(
          state,
          key,
          reasoning
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
          reasoning ? 'thinking' : 'text',
        );
      const part = state.parts.get(key)!;
      if (reasoning) {
        const summaryIndex =
          type === 'response.reasoning_text.delta'
            ? 1000000 + (event.content_index as number)
            : (event.summary_index as number);
        if (!Number.isSafeInteger(summaryIndex) || summaryIndex < 0)
          return upstreamError('Invalid reasoning part index');
        if (state.summaryIndex !== undefined && summaryIndex !== state.summaryIndex) {
          if (summaryIndex < state.summaryIndex)
            return upstreamError('Interleaved reasoning parts are unsupported');
          yield delta(part, '\n');
        }
        state.summaryIndex = summaryIndex;
      }
      yield delta(part, string(event.delta, 'delta'));
      continue;
    }
    // These lifecycle events carry redundant snapshots; output_item.done is authoritative.
    if (
      [
        'response.content_part.added',
        'response.content_part.done',
        'response.output_text.done',
        'response.refusal.done',
        'response.function_call_arguments.done',
        'response.reasoning_summary_part.added',
        'response.reasoning_summary_part.done',
        'response.reasoning_summary_text.done',
        'response.reasoning_text.done',
      ].includes(type)
    )
      continue;
    return upstreamError(`Unsupported Responses streaming event: ${type}`);
  }
  if (!terminal) return upstreamError('Upstream stream interrupted before completion');
}

/** Keep Anthropic block order equal to the canonical Responses output order.
 * Parallel upstream tools can interleave; later items wait for earlier items.
 * Bound the entire upstream event budget so tiny deltas cannot grow memory forever.
 */
async function* orderedEvents(
  events: AsyncIterable<SseEvent>,
  maxBytes: number,
): AsyncGenerator<SseEvent> {
  let next = 0,
    total = 0,
    sawStart = false;
  const pending = new Map<number, SseEvent[]>(),
    added = new Set<number>();
  function* dispatch(frame: SseEvent): Generator<SseEvent> {
    const event = JSON.parse(frame.data);
    if (event.type === 'response.output_item.added') added.add(event.output_index);
    yield frame;
    if (event.type === 'response.output_item.done' && event.output_index === next) next++;
  }
  function* drain(): Generator<SseEvent> {
    while (pending.has(next)) {
      const frames = pending.get(next)!;
      pending.delete(next);
      for (const frame of frames) yield* dispatch(frame);
    }
  }
  for await (const frame of events) {
    total += Buffer.byteLength(frame.data, 'utf8');
    if (total > maxBytes) return upstreamError('Responses stream exceeds configured size limit');
    let event: any;
    try {
      event = JSON.parse(frame.data);
    } catch {
      yield frame;
      continue;
    }
    if (!event || typeof event !== 'object') {
      yield frame;
      continue;
    }
    if (event.type === 'response.created' || event.type === 'response.in_progress') sawStart = true;
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (!sawStart) {
        yield { data: JSON.stringify({ type: 'response.created', response: event.response }) };
        sawStart = true;
      }
      if (Array.isArray(event.response?.output)) {
        const output = event.response.output;
        while (next < output.length) {
          yield* drain();
          if (next >= output.length) break;
          // Some compatible routers omit output_item.done; the terminal snapshot closes it.
          if (!added.has(next))
            yield* dispatch({
              data: JSON.stringify({
                type: 'response.output_item.added',
                output_index: next,
                item: output[next],
              }),
            });
          yield* dispatch({
            data: JSON.stringify({
              type: 'response.output_item.done',
              output_index: next,
              item: output[next],
            }),
          });
        }
        if (pending.size) return upstreamError('Terminal response dropped a buffered output item');
      }
      yield frame;
      continue;
    }
    const index = event.output_index;
    if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index > next) {
      const queue = pending.get(index) ?? [];
      queue.push(frame);
      pending.set(index, queue);
      continue;
    }
    yield* dispatch(frame);
    yield* drain();
  }
}
export async function* translateStream(
  events: AsyncIterable<SseEvent>,
  model: string,
  maxStreamBytes = 128 * 1024 * 1024,
): AsyncGenerator<JsonObject> {
  // Claude clients consume one content block at a time. Responses can start
  // another part before output_item.done closes the preceding part.
  let active: number | undefined;
  const pending: JsonObject[] = [];
  function* dispatch(event: JsonObject): Generator<JsonObject> {
    if (event.type === 'content_block_start') active = event.index as number;
    yield event;
    if (event.type === 'content_block_stop') active = undefined;
  }
  for await (const event of translateOrderedStream(orderedEvents(events, maxStreamBytes), model)) {
    if (typeof event.index === 'number' && active !== undefined && event.index !== active) {
      pending.push(event);
      continue;
    }
    yield* dispatch(event);
    while (pending.length && (active === undefined || pending[0]!.index === active)) {
      yield* dispatch(pending.shift()!);
    }
  }
  if (pending.length || active !== undefined)
    return upstreamError('Stream ended with an unfinished content block');
}
