import { z } from 'zod';

export class ProtocolError extends Error {
  constructor(
    message: string,
    public status = 400,
    public kind = 'invalid_request_error',
  ) {
    super(message);
  }
}
export const object = z.record(z.string(), z.unknown());
const cache = { cache_control: object.optional() };
const text = z.object({ type: z.literal('text'), text: z.string(), ...cache }).strict();
const source = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('base64'),
      media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      data: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal('url'), url: z.url() }).strict(),
]);
const image = z.object({ type: z.literal('image'), source, ...cache }).strict();
const toolUse = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: object,
    ...cache,
  })
  .strict();
const toolResult = z
  .object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().min(1),
    content: z.union([z.string(), z.array(z.union([text, image]))]).optional(),
    is_error: z.boolean().optional(),
    ...cache,
  })
  .strict();
const thinking = z
  .object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() })
  .strict();
const redacted = z
  .object({ type: z.literal('redacted_thinking'), data: z.string().min(1) })
  .strict();
export const blockSchema = z.union([text, image, toolUse, toolResult, thinking, redacted]);
export type Block = z.infer<typeof blockSchema>;
export const requestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().optional(),
    system: z.union([z.string(), z.array(text)]).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.union([z.string(), z.array(blockSchema)]),
          })
          .strict(),
      )
      .min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            input_schema: object,
            ...cache,
          })
          .strict(),
      )
      .optional(),
    tool_choice: z
      .discriminatedUnion('type', [
        z
          .object({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() })
          .strict(),
        z
          .object({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() })
          .strict(),
        z.object({ type: z.literal('none') }).strict(),
        z
          .object({
            type: z.literal('tool'),
            name: z.string().min(1),
            disable_parallel_tool_use: z.boolean().optional(),
          })
          .strict(),
      ])
      .optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    thinking: z
      .discriminatedUnion('type', [
        z
          .object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() })
          .strict(),
        z.object({ type: z.literal('adaptive') }).strict(),
        z.object({ type: z.literal('disabled') }).strict(),
      ])
      .optional(),
    output_config: z
      .object({
        effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
        format: object.optional(),
      })
      .strict()
      .optional(),
    metadata: z.object({ user_id: z.string().optional() }).strict().optional(),
    // Explicitly rejected below: Responses does not implement Anthropic stop sequences/top_k.
    stop_sequences: z.array(z.string()).optional(),
    top_k: z.number().optional(),
  })
  .strict();
export type MessagesRequest = z.infer<typeof requestSchema>;
export type JsonObject = Record<string, unknown>;
export type ReasoningItem = {
  type: 'reasoning';
  id?: string;
  summary: { type: 'summary_text'; text: string }[];
  encrypted_content?: string | null;
  content?: { type: 'reasoning_text'; text: string }[];
  status?: 'in_progress' | 'completed' | 'incomplete';
};
export const reasoningSchema = z
  .object({
    type: z.literal('reasoning'),
    id: z.string().min(1).optional(),
    summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() }).strict()),
    encrypted_content: z.string().nullable().optional(),
    content: z
      .array(z.object({ type: z.literal('reasoning_text'), text: z.string() }).strict())
      .optional(),
    status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
  })
  .strict();
export function parseRequest(value: unknown): MessagesRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success)
    throw new ProtocolError(
      `Invalid Messages request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data;
}
export function upstreamError(message: string): never {
  throw new ProtocolError(message, 502, 'api_error');
}
export function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return upstreamError('Upstream returned a non-object');
  return value as JsonObject;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string') return upstreamError(`Missing or invalid ${label}`);
  return value;
}
