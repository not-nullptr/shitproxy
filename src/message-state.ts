import { z } from 'zod';
import { ProtocolError, object, type Block } from './protocol.js';
const PREFIX = 'spx:message:v1:';
const schema = z
  .object({
    type: z.literal('message'),
    role: z.literal('assistant'),
    id: z.string().min(1),
    status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
    phase: z.enum(['commentary', 'final_answer']).nullable(),
    content: z.array(
      z.union([
        z
          .object({
            type: z.literal('output_text'),
            text: z.string(),
            annotations: z.array(object).optional(),
            logprobs: z.array(object).optional(),
          })
          .strict(),
        z.object({ type: z.literal('refusal'), refusal: z.string() }).strict(),
      ]),
    ),
  })
  .strict();
export type ReplayMessage = z.infer<typeof schema>;
export function hasMessageEnvelope(
  block: Block,
): block is Extract<Block, { type: 'redacted_thinking' }> {
  return block.type === 'redacted_thinking' && block.data.startsWith(PREFIX);
}
export function messageEnvelope(value: unknown): Block {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ProtocolError('Invalid upstream message metadata', 502, 'api_error');
  return {
    type: 'redacted_thinking',
    data: PREFIX + Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url'),
  };
}
export function replayMessage(data: string): ReplayMessage {
  try {
    if (!data.startsWith(PREFIX)) throw new Error();
    const encoded = data.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error();
    return schema.parse(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
  } catch {
    throw new ProtocolError('Malformed assistant message metadata envelope');
  }
}
export function visibleMessageParts(message: ReplayMessage) {
  return message.content.map((p) => ({
    type: 'output_text',
    text: p.type === 'output_text' ? p.text : p.refusal,
    annotations: [],
  }));
}
