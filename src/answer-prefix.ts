import type { JsonObject } from './protocol.js';
import { shiftCitation } from './web-search.js';
import { messageEnvelope, replayMessage } from './message-state.js';

/** Repair an answer prefix overtaking trailing reasoning fragments.
 * The opening answer is buffered until reasoning resumes, a barrier or the end
 * of the response arrives, or the hold window elapses. Reasoning streams
 * immediately; the held prefix and later answer fragments merge into one block.
 */
export async function* repairAnswerPrefix(
  source: AsyncIterable<JsonObject>,
  timeoutMs = 200,
): AsyncGenerator<JsonObject> {
  const iterator = source[Symbol.asyncIterator]();
  const indexes = new Map<number, number>();
  let nextIndex = 0;
  let thinkingSeen = false,
    eligible = true,
    holdingIndex: number | undefined;
  let held: JsonObject[] = [],
    repaired = false;
  let mergedText: number | undefined;
  let mergedValue = '';
  const textOffsets = new Map<number, number>();
  let mergedCitations: JsonObject[] = [];
  let activeReasoning: number | undefined,
    expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: Promise<'timeout'> | undefined;
  let pending: Promise<IteratorResult<JsonObject>> | undefined;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
    deadline = undefined;
  };
  function* closeMerged(): Generator<JsonObject> {
    if (mergedText !== undefined) {
      yield { type: 'content_block_stop', index: mergedText };
      mergedText = undefined;
      mergedValue = '';
      mergedCitations = [];
    }
  }
  function* emit(event: JsonObject): Generator<JsonObject> {
    if (event.type === 'content_block_start') {
      let block = event.content_block as JsonObject;
      if (
        mergedText !== undefined &&
        block.type === 'redacted_thinking' &&
        String(block.data).startsWith('spx:message:')
      ) {
        // The final phase belongs to the repaired, joined answer. Keep its
        // identity/status/phase, including the prefix in its replayable text.
        const original = replayMessage(block.data as string);
        block = messageEnvelope({
          ...original,
          content: [{ type: 'output_text', text: mergedValue, annotations: mergedCitations }],
        }) as JsonObject;
        event = { ...event, content_block: block };
      }
      if (block.type === 'text' && repaired) {
        textOffsets.set(event.index as number, mergedValue.length);
        if (mergedText !== undefined) {
          indexes.set(event.index as number, mergedText);
          return;
        }
        mergedText = nextIndex;
      } else yield* closeMerged();
      indexes.set(event.index as number, nextIndex++);
    }
    if (event.type === 'message_delta' || event.type === 'message_stop') yield* closeMerged();
    if (typeof event.index === 'number') {
      const index = indexes.get(event.index)!;
      let delta = event.delta as JsonObject | undefined;
      if (index === mergedText && delta?.type === 'citations_delta') {
        const citation = shiftCitation(delta.citation, textOffsets.get(event.index) ?? 0);
        delta = { ...delta, citation };
        event = { ...event, delta };
        const encoded = String(citation.encrypted_index).slice('spx:citation:v1:'.length);
        mergedCitations.push(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
      }
      if (index === mergedText && delta?.type === 'text_delta') mergedValue += delta.text;
      if (event.type === 'content_block_stop' && index === mergedText) return;
      yield { ...event, index };
    } else yield event;
  }
  function* release(): Generator<JsonObject> {
    cancelTimer();
    eligible = false;
    holdingIndex = undefined;
    expired = false;
    for (const event of held) yield* emit(event);
    held = [];
  }
  try {
    while (true) {
      pending ??= iterator.next();
      const result = deadline ? await Promise.race([pending, deadline]) : await pending;
      if (result === 'timeout') {
        cancelTimer();
        if (activeReasoning === undefined) yield* release();
        else expired = true;
        continue;
      }
      pending = undefined;
      if (result.done) {
        yield* release();
        yield* closeMerged();
        return;
      }
      const event = result.value;
      if (event.type === 'content_block_start') {
        const block = event.content_block as JsonObject;
        if (
          block.type === 'thinking' ||
          (block.type === 'redacted_thinking' &&
            !String(block.data).startsWith('spx:message:') &&
            !String(block.data).startsWith('spx:websearch:'))
        ) {
          thinkingSeen = true;
          activeReasoning = event.index as number;
          if (held.length) repaired = true;
          holdingIndex = undefined;
        } else if (block.type === 'text' && eligible && thinkingSeen) {
          holdingIndex = event.index as number;
          if (!deadline)
            deadline = new Promise((resolve) => {
              timer = setTimeout(() => resolve('timeout'), timeoutMs);
            });
        } else {
          // Tool calls and phase metadata are barriers; never move history across them.
          yield* release();
          if (block.type === 'tool_use' || block.type === 'redacted_thinking') {
            repaired = false;
            thinkingSeen = false;
            eligible = true;
          }
        }
      }
      if (typeof event.index === 'number' && event.index === holdingIndex) {
        held.push(event);
        continue;
      }
      if (event.type === 'message_delta' || event.type === 'message_stop') yield* release();
      yield* emit(event);
      if (event.type === 'content_block_stop' && event.index === activeReasoning) {
        activeReasoning = undefined;
        if (expired) yield* release();
      }
    }
  } finally {
    cancelTimer();
    // The HTTP owner aborts the upstream body on disconnect. Do not wait for a
    // pending network read here, but consume any eventual rejection.
    void iterator.return?.().catch(() => {});
  }
}
