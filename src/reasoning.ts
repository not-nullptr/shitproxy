import { ProtocolError, reasoningSchema, type ReasoningItem, type Block } from './protocol.js';
// A versioned transport envelope, never a decryption key or a provider signature.
const PREFIX = 'spx:reasoning:v1:';
export function encodeReasoning(item: ReasoningItem): string {
  const parsed = reasoningSchema.safeParse(item);
  if (!parsed.success) throw new ProtocolError('Invalid upstream reasoning item', 502, 'api_error');
  return PREFIX + Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}
export function decodeReasoning(value: string): ReasoningItem {
  if (!value.startsWith(PREFIX))
    throw new ProtocolError(
      'Foreign or unsupported reasoning signature: cannot replay provider state across protocols',
    );
  const encoded = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new ProtocolError('Malformed reasoning envelope');
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('Noncanonical encoding');
    return reasoningSchema.parse(
      JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new ProtocolError('Malformed reasoning envelope');
  }
}
export function reasoningToBlock(item: ReasoningItem): Block {
  const visible = [
    ...item.summary.map((p) => p.text),
    ...(item.content ?? []).map((p) => p.text),
  ].join('\n');
  return item.summary.length || item.content?.length
    ? { type: 'thinking', thinking: visible, signature: encodeReasoning(item) }
    : { type: 'redacted_thinking', data: encodeReasoning(item) };
}
export function blockToReasoning(
  block: Extract<Block, { type: 'thinking' | 'redacted_thinking' }>,
): ReasoningItem {
  if (block.type === 'redacted_thinking') return decodeReasoning(block.data);
  if (block.signature) {
    const item = decodeReasoning(block.signature);
    const expected = reasoningToBlock(item);
    if (expected.type !== 'thinking' || expected.thinking !== block.thinking)
      throw new ProtocolError('Reasoning text was modified after it was returned');
    return item;
  }
  // Plain unsigned summaries have no opaque state; preserve them as a reasoning summary.
  return { type: 'reasoning', summary: [{ type: 'summary_text', text: block.thinking }] };
}
