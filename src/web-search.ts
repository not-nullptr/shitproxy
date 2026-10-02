import { z } from 'zod';
import { ProtocolError, record, upstreamError, type Block, type JsonObject } from './protocol.js';

const PREFIX = 'spx:websearch:v1:';
const CITATION = 'spx:citation:v1:';
const source = z
  .object({ type: z.literal('url').optional(), url: z.string(), title: z.string().optional() })
  .passthrough();
const search = z
  .object({
    type: z.literal('web_search_call'),
    id: z.string().min(1),
    status: z.enum(['completed', 'failed', 'incomplete']),
    action: z
      .discriminatedUnion('type', [
        z
          .object({
            type: z.literal('search'),
            query: z.string().optional(),
            queries: z.array(z.string()).optional(),
            sources: z.array(source).optional(),
          })
          .passthrough(),
        z.object({ type: z.literal('open_page'), url: z.string() }).passthrough(),
        z
          .object({ type: z.literal('find_in_page'), url: z.string(), pattern: z.string() })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();
const annotation = z
  .object({
    type: z.literal('url_citation'),
    url: z.string(),
    title: z.string(),
    start_index: z.number().int().nonnegative(),
    end_index: z.number().int().nonnegative(),
  })
  .strict();
function encode(prefix: string, value: unknown): string {
  return prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decode(prefix: string, value: string): unknown {
  try {
    if (!value.startsWith(prefix)) throw new Error();
    const encoded = value.slice(prefix.length),
      bytes = Buffer.from(encoded, 'base64url');
    if (!encoded || bytes.toString('base64url') !== encoded) throw new Error();
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProtocolError('Malformed web search replay metadata');
  }
}
export function searchInput(value: unknown): JsonObject {
  const item = record(value),
    action = item.action === undefined ? undefined : record(item.action);
  if (!action) return {};
  if (action.type === 'search')
    return {
      query: action.query ?? (Array.isArray(action.queries) ? action.queries.join('\n') : ''),
    };
  if (action.type === 'open_page') return { query: action.url };
  if (action.type === 'find_in_page') return { query: `${action.pattern} ${action.url}` };
  return upstreamError('Unsupported web search action');
}
export function searchBlocks(value: unknown): Block[] {
  const parsed = search.safeParse(value);
  if (!parsed.success) return upstreamError('Invalid upstream web search call');
  const item = parsed.data;
  if (item.status === 'completed' && !item.action)
    return upstreamError('Completed web search has no action');
  const sources = item.action?.type === 'search' ? (item.action.sources ?? []) : [];
  return [
    { type: 'server_tool_use', id: item.id, name: 'web_search', input: searchInput(item) },
    {
      type: 'web_search_tool_result',
      tool_use_id: item.id,
      content:
        item.status === 'completed'
          ? sources.map((s) => ({
              type: 'web_search_result',
              url: s.url,
              title: s.title ?? s.url,
              encrypted_content: encode(PREFIX, s),
            }))
          : { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    },
    { type: 'redacted_thinking', data: encode(PREFIX, item) },
  ];
}
export function hasSearchEnvelope(block: Block): boolean {
  return block.type === 'redacted_thinking' && block.data.startsWith(PREFIX);
}
export function replaySearch(data: string): JsonObject {
  const parsed = search.safeParse(decode(PREFIX, data));
  if (!parsed.success) throw new ProtocolError('Malformed web search replay metadata');
  return parsed.data;
}
export function citations(
  value: unknown,
  text: string,
): Extract<Block, { type: 'text' }>['citations'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return upstreamError('Invalid upstream annotations');
  return value.map((v) => {
    const parsed = annotation.safeParse(v);
    if (!parsed.success) return upstreamError('Unsupported upstream annotations');
    const a = parsed.data;
    if (a.end_index < a.start_index || a.end_index > text.length)
      return upstreamError('Invalid citation text range');
    return {
      type: 'web_search_result_location',
      url: a.url,
      title: a.title,
      cited_text: text.slice(a.start_index, a.end_index),
      encrypted_index: encode(CITATION, a),
    };
  });
}
export function replayCitations(block: Extract<Block, { type: 'text' }>): JsonObject[] {
  return (block.citations ?? []).map((c) => {
    if (!c.encrypted_index.startsWith(CITATION))
      throw new ProtocolError('Native Anthropic citations cannot be replayed through Responses');
    const parsed = annotation.safeParse(decode(CITATION, c.encrypted_index));
    if (!parsed.success) throw new ProtocolError('Malformed web search citation metadata');
    const a = parsed.data;
    if (
      a.url !== c.url ||
      a.title !== c.title ||
      a.end_index < a.start_index ||
      a.end_index > block.text.length ||
      block.text.slice(a.start_index, a.end_index) !== c.cited_text
    )
      throw new ProtocolError('Web search citation was modified after translation');
    return a;
  });
}

export function shiftCitation(citation: unknown, offset: number): JsonObject {
  const c = record(citation);
  const a = annotation.parse(decode(CITATION, String(c.encrypted_index)));
  return {
    ...c,
    encrypted_index: encode(CITATION, {
      ...a,
      start_index: a.start_index + offset,
      end_index: a.end_index + offset,
    }),
  };
}
