import {
  hasMessageEnvelope,
  messageEnvelope,
  replayMessage,
  visibleMessageParts,
} from './message-state.js';
import {
  ProtocolError,
  parseRequest,
  record,
  string,
  upstreamError,
  reasoningSchema,
  type Block,
  type JsonObject,
  type MessagesRequest,
} from './protocol.js';
import { blockToReasoning, reasoningToBlock } from './reasoning.js';
import {
  citations,
  replayCitations,
  hasSearchEnvelope,
  replaySearch,
  searchBlocks,
} from './web-search.js';
export function inputPart(
  block: Extract<Block, { type: 'text' | 'image' }>,
  role: 'user' | 'assistant' | 'system' | 'developer' = 'user',
): JsonObject {
  if (block.type === 'text') {
    if (role !== 'assistant' && block.citations !== undefined)
      throw new ProtocolError('Citations require assistant role');
    return role === 'assistant'
      ? { type: 'output_text', text: block.text, annotations: replayCitations(block) }
      : { type: 'input_text', text: block.text };
  }
  if (role !== 'user')
    throw new ProtocolError('Image content requires user role on the Responses path');
  const src = block.source;
  if (src.type === 'url' && !/^https?:\/\//.test(src.url))
    throw new ProtocolError('Image URLs must use HTTP or HTTPS');
  return {
    type: 'input_image',
    image_url: src.type === 'url' ? src.url : `data:${src.media_type};base64,${src.data}`,
  };
}
export function toResponses(value: unknown): JsonObject {
  const req = parseRequest(value);
  if (req.top_k !== undefined) throw new ProtocolError('top_k has no Responses equivalent');
  if (req.stop_sequences?.length)
    throw new ProtocolError('stop_sequences has no Responses equivalent');
  if (Array.isArray(req.system) && req.system.some((b) => b.citations !== undefined))
    throw new ProtocolError('Citations require assistant role');
  const input: JsonObject[] = [];
  if (req.system !== undefined)
    input.push({
      role: 'system',
      content: [
        {
          type: 'input_text',
          text:
            typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n'),
        },
      ],
    });
  const calls = new Set<string>(),
    results = new Set<string>();
  const searches = new Map<
    string,
    {
      block: Extract<Block, { type: 'server_tool_use' }>;
      index: number;
      replayed?: boolean;
      results?: Extract<Block, { type: 'web_search_tool_result' }>;
    }
  >();
  // Routers fronting a chat-completions provider cannot represent image content
  // inside a function call output: they drop the tool message, leaving the
  // assistant tool_calls message unanswered and the provider rejecting the
  // request ("insufficient tool messages following tool_calls message"). Tool
  // results may carry images, so hold them back and replay them as a user
  // message placed after the contiguous run of tool outputs. A user message
  // must never interleave the tool outputs, or the same provider check fails.
  const pendingImages: JsonObject[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    // The tool replies are empty (an image cannot ride inside a function call
    // output here), so the model otherwise reads the tool results as "the tool
    // returned nothing" and never connects the trailing user images to the
    // calls. One leading hint text covers them all; per-image labels make the
    // model read each label as the (empty) tool output instead.
    input.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<tool_call_result>Images are attached to this message</tool_call_result>',
        },
        ...pendingImages.splice(0),
      ],
    });
  };
  for (const message of req.messages) {
    const blocks: Block[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content;
    // Claude Desktop's Code client appends a system token-budget update after
    // each tool round trip. The DeepSeek route hoists system messages into the
    // prefix, invalidating the entire conversation cache on every update.
    // Send the counter as user content so routers cannot hoist it as an
    // instruction role. Only demote this exact informational counter, never general
    // system instructions. Native Anthropic requests bypass this translator.
    // Do not gate on model names: Desktop uses opaque router aliases that hide
    // the provider (for example claude-fable-subrouter-compat-v3-...).
    const role =
      message.role === 'system' &&
      blocks.length === 1 &&
      blocks[0]?.type === 'text' &&
      /^<total_tokens>\d+ tokens left<\/total_tokens>$/.test(blocks[0].text)
        ? 'user'
        : message.role;
    let content: JsonObject[] = [];
    const flush = () => {
      if (content.length) {
        input.push({ role, content });
        content = [];
      }
    };
    for (const block of blocks) {
      // Buffer held-back images until the run of tool outputs ends.
      if (block.type !== 'tool_result') flushImages();
      if (block.type === 'text' || block.type === 'image') {
        content.push(inputPart(block, message.role));
        continue;
      }
      if (block.type === 'redacted_thinking' && hasSearchEnvelope(block)) {
        if (message.role !== 'assistant')
          throw new ProtocolError('Web search history requires assistant role');
        const replay = replaySearch(block.data),
          previous = searches.get(replay.id as string);
        if (!previous?.results || previous.replayed)
          throw new ProtocolError('Web search metadata has no preceding search/result pair');
        const expected = searchBlocks(replay);
        if (
          JSON.stringify([previous.block, previous.results]) !==
          JSON.stringify(expected.slice(0, 2))
        )
          throw new ProtocolError('Web search history was modified after translation');
        previous.replayed = true;
        input[previous.index] = replay;
        continue;
      }
      if (hasMessageEnvelope(block)) {
        if (message.role !== 'assistant')
          throw new ProtocolError('Assistant message metadata requires assistant role');
        const replay = replayMessage(block.data);
        if (JSON.stringify(content) !== JSON.stringify(visibleMessageParts(replay)))
          throw new ProtocolError(
            'Assistant message text was modified after metadata was returned',
          );
        input.push(replay);
        content = [];
        continue;
      }
      flush();
      if (block.type === 'server_tool_use') {
        if (message.role !== 'assistant')
          throw new ProtocolError('Web search history requires assistant role');
        if (searches.has(block.id) || calls.has(block.id))
          throw new ProtocolError('Duplicate tool call ID');
        if (typeof block.input.query !== 'string' && Object.keys(block.input).length !== 0)
          throw new ProtocolError('Web search history requires a query');
        searches.set(block.id, { block, index: input.length });
        input.push({
          type: 'web_search_call',
          id: block.id,
          status: 'completed',
          action: { type: 'search', query: block.input.query ?? '', sources: [] },
        });
      } else if (block.type === 'web_search_tool_result') {
        const previous = searches.get(block.tool_use_id);
        if (message.role !== 'assistant' || !previous || previous.results)
          throw new ProtocolError('Invalid web search result history');
        previous.results = block;
        const item = input[previous.index]!;
        if (Array.isArray(block.content))
          record(item.action).sources = block.content.map((s) => ({
            type: 'url',
            url: s.url,
            title: s.title,
          }));
        else item.status = 'failed';
      } else if (block.type === 'tool_use') {
        if (message.role !== 'assistant')
          throw new ProtocolError('tool_use requires assistant role');
        if (calls.has(block.id) || searches.has(block.id))
          throw new ProtocolError('Duplicate tool call ID');
        calls.add(block.id);
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === 'tool_result') {
        if (message.role !== 'user') throw new ProtocolError('tool_result requires user role');
        if (!calls.has(block.tool_use_id))
          throw new ProtocolError('Tool result has no preceding call');
        if (results.has(block.tool_use_id)) throw new ProtocolError('Duplicate tool result');
        results.add(block.tool_use_id);
        const parts = typeof block.content === 'string' ? undefined : (block.content ?? []);
        const images = (parts ?? []).filter((b) => b.type === 'image');
        let output: string | JsonObject[];
        if (typeof block.content === 'string') output = block.content;
        else if (images.length) {
          // Keep only the text as the tool reply; an image-only result still
          // needs a non-empty reply so the tool call is answered.
          const text = parts!.filter((b) => b.type === 'text').map((b) => inputPart(b));
          output = text.length ? text : '';
        } else output = parts!.map((b) => inputPart(b));
        for (const image of images) pendingImages.push(inputPart(image));
        if (block.is_error)
          output =
            typeof output === 'string'
              ? `[tool_error]\n${output}`
              : [{ type: 'input_text', text: '[tool_error]' }, ...output];
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
      } else {
        if (message.role !== 'assistant')
          throw new ProtocolError('Reasoning history requires assistant role');
        input.push(blockToReasoning(block));
      }
    }
    flush();
  }
  flushImages();
  for (const search of searches.values())
    if (!search.results) throw new ProtocolError('Web search history has no result');
  const out: JsonObject = {
    model: req.model,
    input,
    max_output_tokens: req.max_tokens,
    stream: req.stream ?? false,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  for (const field of ['temperature', 'top_p'] as const)
    if (req[field] !== undefined) out[field] = req[field];
  if (req.tools) {
    const names = new Set<string>();
    out.tools = req.tools.map((t) => {
      if (names.has(t.name)) throw new ProtocolError('Duplicate tool name');
      names.add(t.name);
      if ('type' in t) {
        if (t.allowed_domains !== undefined && t.blocked_domains !== undefined)
          throw new ProtocolError(
            'Web search accepts allowed_domains or blocked_domains, not both',
          );
        if (t.max_uses !== undefined) out.max_tool_calls = t.max_uses;
        (out.include as string[]).push('web_search_call.action.sources');
        return {
          type: 'web_search',
          ...(t.user_location && { user_location: t.user_location }),
          ...((t.allowed_domains || t.blocked_domains) && {
            filters: {
              ...(t.allowed_domains && { allowed_domains: t.allowed_domains }),
              ...(t.blocked_domains && { blocked_domains: t.blocked_domains }),
            },
          }),
        };
      }
      return {
        type: 'function',
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: t.input_schema,
        strict: false,
      };
    });
  }
  if (req.tool_choice) {
    const t = req.tool_choice;
    if ((t.type === 'any' || t.type === 'tool') && !req.tools?.length)
      throw new ProtocolError('Forced tool choice requires tools');
    if (t.type === 'tool' && !req.tools?.some((tool) => tool.name === t.name))
      throw new ProtocolError('tool_choice names an undefined tool');
    out.tool_choice =
      t.type === 'tool'
        ? req.tools?.some((tool) => tool.name === t.name && 'type' in tool)
          ? { type: 'web_search' }
          : { type: 'function', name: t.name }
        : t.type === 'any'
          ? 'required'
          : t.type;
    if ('disable_parallel_tool_use' in t && t.disable_parallel_tool_use !== undefined)
      out.parallel_tool_calls = !t.disable_parallel_tool_use;
  }
  if (req.thinking?.type === 'enabled' && req.thinking.budget_tokens >= req.max_tokens)
    throw new ProtocolError('thinking budget_tokens must be below max_tokens');
  if (req.thinking?.type === 'disabled' && req.output_config?.effort)
    throw new ProtocolError('Cannot combine disabled thinking and reasoning effort');
  if ((req.thinking && req.thinking.type !== 'disabled') || req.output_config?.effort) {
    const budget = req.thinking?.type === 'enabled' ? req.thinking.budget_tokens : undefined;
    out.reasoning = {
      effort:
        req.output_config?.effort === 'max'
          ? 'xhigh'
          : (req.output_config?.effort ??
            (budget === undefined
              ? 'medium'
              : budget < 2048
                ? 'low'
                : budget < 8192
                  ? 'medium'
                  : 'high')),
      summary: 'auto',
    };
  }
  if (req.output_config?.format) {
    const f = req.output_config.format;
    if (f.type !== 'json_schema' || !f.schema)
      throw new ProtocolError('Only json_schema output format is supported');
    out.text = {
      format: { type: 'json_schema', name: 'response', schema: f.schema, strict: true },
    };
  }
  if (req.metadata?.user_id) out.safety_identifier = req.metadata.user_id;
  return out;
}
export function outputBlocks(value: unknown): Block[] {
  const item = record(value);
  if (item.type === 'web_search_call') return searchBlocks(item);
  if (item.type === 'reasoning') {
    const parsed = reasoningSchema.safeParse(item);
    if (!parsed.success) return upstreamError('Invalid upstream reasoning item');
    return [reasoningToBlock(parsed.data)];
  }
  if (item.type === 'function_call') {
    let args: unknown;
    try {
      args = JSON.parse(string(item.arguments, 'function arguments'));
    } catch {
      return upstreamError('Invalid function call JSON');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args))
      return upstreamError('Function call arguments must be an object');
    return [
      {
        type: 'tool_use',
        id: string(item.call_id, 'call_id'),
        name: string(item.name, 'function name'),
        input: args as JsonObject,
      },
    ];
  }
  if (item.type === 'message') {
    if (item.role !== 'assistant' || !Array.isArray(item.content))
      return upstreamError('Invalid upstream assistant message');
    const blocks: Block[] = item.content.map((p) => {
      const part = record(p);
      if (part.type === 'output_text') {
        const text = string(part.text, 'output text'),
          refs = citations(part.annotations, text);
        return { type: 'text', text, ...(refs?.length && { citations: refs }) };
      }
      if (part.type === 'refusal') return { type: 'text', text: string(part.refusal, 'refusal') };
      return upstreamError(`Unsupported upstream content type: ${part.type}`);
    });
    if (item.phase !== undefined) blocks.push(messageEnvelope(item));
    return blocks;
  }
  return upstreamError(`Unsupported upstream output type: ${item.type}`);
}
export function usage(value: unknown): JsonObject {
  if (value === undefined || value === null) return { input_tokens: 0, output_tokens: 0 };
  const u = record(value);
  const count = (v: unknown) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      return upstreamError('Invalid upstream token usage');
    return v;
  };
  const cached = u.input_tokens_details
    ? count(record(u.input_tokens_details).cached_tokens ?? 0)
    : 0;
  const total = count(u.input_tokens ?? 0);
  if (cached > total) return upstreamError('Cached tokens exceed input tokens');
  return {
    input_tokens: total - cached,
    output_tokens: count(u.output_tokens ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}
export function toMessage(value: unknown, model: string): JsonObject {
  const response = record(value);
  if (!Array.isArray(response.output))
    return upstreamError('Upstream response has no output array');
  if (response.status === 'failed' || response.error)
    return upstreamError('Upstream Responses generation failed');
  if (response.status !== 'completed' && response.status !== 'incomplete')
    return upstreamError('Upstream response is not terminal');
  const content = response.output.flatMap(outputBlocks);
  let stop = 'end_turn';
  if (response.status === 'incomplete') {
    const reason = record(response.incomplete_details).reason;
    if (reason === 'max_output_tokens') stop = 'max_tokens';
    else if (reason === 'content_filter') stop = 'refusal';
    else return upstreamError(`Unsupported incomplete reason: ${reason}`);
  } else if (content.some((b) => b.type === 'tool_use')) stop = 'tool_use';
  else if (
    response.output.some((v) => {
      const i = record(v);
      return (
        i.type === 'message' &&
        Array.isArray(i.content) &&
        i.content.some((p) => record(p).type === 'refusal')
      );
    })
  )
    stop = 'refusal';
  return {
    id: string(response.id, 'response id'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usage(response.usage),
  };
}
