import type { JsonObject } from './protocol.js';
function obj(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}
function preview(value: unknown) {
  return typeof value === 'string'
    ? { length: value.length, preview: value.slice(0, 80) }
    : undefined;
}
function item(value: unknown): JsonObject {
  const v = obj(value);
  return {
    type: v.type,
    phase: v.phase,
    summary: Array.isArray(v.summary) ? v.summary.map((p) => preview(obj(p).text)) : undefined,
    content: Array.isArray(v.content)
      ? v.content.map((p) => {
          const part = obj(p);
          return { type: part.type, ...preview(part.text ?? part.refusal) };
        })
      : undefined,
  };
}
/** Diagnostic allowlist: never serialize raw events, arguments, signatures or envelopes. */
export function traceShape(value: unknown): JsonObject {
  const v = obj(value),
    delta = obj(v.delta),
    block = obj(v.content_block),
    response = obj(v.response);
  return {
    type: v.type,
    index: v.index,
    output_index: v.output_index,
    content_index: v.content_index,
    summary_index: v.summary_index,
    delta_type: delta.type,
    delta:
      typeof v.delta === 'string'
        ? [
            'response.output_text.delta',
            'response.refusal.delta',
            'response.reasoning_summary_text.delta',
            'response.reasoning_text.delta',
          ].includes(String(v.type))
          ? preview(v.delta)
          : undefined
        : preview(delta.text ?? delta.thinking),
    item: v.item ? item(v.item) : undefined,
    block_type: block.type,
    state_carrier:
      block.type === 'redacted_thinking' && typeof block.data === 'string'
        ? block.data.startsWith('spx:message:')
          ? 'message'
          : 'reasoning'
        : undefined,
    output: Array.isArray(response.output) ? response.output.map(item) : undefined,
  };
}
