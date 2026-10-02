import { it, expect } from 'vitest';
import { toResponses, outputBlocks, toMessage } from '../src/translate.js';
import {
  citations,
  replayCitations,
  replaySearch,
  searchBlocks,
  searchInput,
  shiftCitation,
} from '../src/web-search.js';
import { translateStream } from '../src/stream.js';
const req = (extra: any = {}) => ({
  model: 'glm',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'news' }],
  ...extra,
});
const tool = { type: 'web_search_20250305', name: 'web_search' };
const call = {
  type: 'web_search_call',
  id: 'ws_1',
  status: 'completed',
  action: {
    type: 'search',
    query: 'news',
    sources: [{ type: 'url', url: 'https://example.com', title: 'News' }],
  },
};
const a = {
  type: 'url_citation',
  url: 'https://example.com',
  title: 'News',
  start_index: 0,
  end_index: 4,
};
it('maps search with filters location limits and forced choice', () => {
  const result = toResponses(
    req({
      tools: [
        {
          ...tool,
          max_uses: 3,
          allowed_domains: ['example.com'],
          user_location: { type: 'approximate', country: 'GB' },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
  );
  expect(result.tools).toEqual([
    {
      type: 'web_search',
      filters: { allowed_domains: ['example.com'] },
      user_location: { type: 'approximate', country: 'GB' },
    },
  ]);
  expect(result.max_tool_calls).toBe(3);
  expect(result.tool_choice).toEqual({ type: 'web_search' });
  expect(result.include).toContain('web_search_call.action.sources');
});
it('maps blocked domains alongside custom functions', () =>
  expect(
    toResponses(
      req({
        tools: [
          { ...tool, blocked_domains: ['bad.com'] },
          { name: 'calc', input_schema: { type: 'object' } },
        ],
      }),
    ).tools,
  ).toEqual([
    { type: 'web_search', filters: { blocked_domains: ['bad.com'] } },
    { type: 'function', name: 'calc', parameters: { type: 'object' }, strict: false },
  ]));
it.each([
  { ...tool, allowed_domains: [], blocked_domains: [] },
  { ...tool, max_uses: 0 },
  { ...tool, type: 'web_search_20260209' },
  { ...tool, allowed_callers: ['code_execution'] },
  { ...tool, name: 'other' },
])('rejects unsupported definition %j', (t) =>
  expect(() => toResponses(req({ tools: [t] }))).toThrow(),
);
it('round trips exact search and annotated phased answer', () => {
  const message = {
    type: 'message',
    id: 'm',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'News today', annotations: [a] }],
  };
  const converted = toMessage({ id: 'r', status: 'completed', output: [call, message] }, 'glm');
  expect(converted.stop_reason).toBe('end_turn');
  expect(
    toResponses(req({ messages: [{ role: 'assistant', content: converted.content }] })).input,
  ).toEqual([call, message]);
});
it.each(['failed', 'incomplete'])('represents %s search errors', (status) => {
  const b = searchBlocks({ ...call, status });
  expect((b[1] as any).content.error_code).toBe('unavailable');
  expect(replaySearch((b[2] as any).data)).toEqual({ ...call, status });
});
it.each([
  { type: 'open_page', url: 'https://example.com' },
  { type: 'find_in_page', url: 'https://example.com', pattern: 'hello' },
  { type: 'search', queries: ['one', 'two'] },
  { type: 'search' },
])('round trips action %j', (action) => {
  const item = { ...call, action };
  const blocks = searchBlocks(item);
  expect(toResponses(req({ messages: [{ role: 'assistant', content: blocks }] })).input).toEqual([
    item,
  ]);
});
it('supports missing titles and failed calls without actions', () => {
  expect(
    (searchBlocks({ ...call, action: { type: 'search', sources: [{ url: 'u' }] } })[1] as any)
      .content[0].title,
  ).toBe('u');
  expect(searchInput({})).toEqual({});
  expect(searchBlocks({ type: 'web_search_call', id: 'w', status: 'failed' })).toHaveLength(3);
});
it.each([
  { ...call, action: undefined },
  { ...call, status: 'searching' },
  { ...call, id: '' },
  { ...call, action: { type: 'other' } },
])('rejects invalid output %j', (item) => expect(() => searchBlocks(item)).toThrow());
it.each(['spx:websearch:v1:!', 'spx:websearch:v1:e30', 'wrong', 'spx:websearch:v1:_w'])(
  'rejects malformed replay %s',
  (data) => expect(() => replaySearch(data)).toThrow(),
);
it('rejects missing duplicate modified or wrong-role search history', () => {
  const blocks = searchBlocks(call);
  for (const content of [
    [blocks[0]],
    [blocks[1]],
    [blocks[2]],
    [...blocks, blocks[2]],
    [blocks[0], blocks[1], blocks[1]],
    [{ ...blocks[0], input: { query: 'changed' } }, ...blocks.slice(1)],
  ])
    expect(() => toResponses(req({ messages: [{ role: 'assistant', content }] }))).toThrow();
  expect(() => toResponses(req({ messages: [{ role: 'user', content: blocks }] }))).toThrow();
});
it('replays basic native search history without proxy metadata', () =>
  expect(
    toResponses(req({ messages: [{ role: 'assistant', content: searchBlocks(call).slice(0, 2) }] }))
      .input,
  ).toEqual([call]));
it('checks citations and shifts offsets for repaired answer prefixes', () => {
  const refs = citations([a], 'News today')!;
  const block: any = { type: 'text', text: 'News today', citations: refs };
  expect(replayCitations(block)).toEqual([a]);
  const shifted = shiftCitation(refs[0], 3);
  expect(replayCitations({ ...block, text: 'Hi News today', citations: [shifted] })).toEqual([
    { ...a, start_index: 3, end_index: 7 },
  ]);
  expect(() => replayCitations({ ...block, text: 'Changed' })).toThrow();
  expect(() =>
    replayCitations({ ...block, citations: [{ ...refs[0], encrypted_index: 'foreign' }] }),
  ).toThrow();
  expect(citations(undefined, '')).toBeUndefined();
});
it.each([
  {},
  [{}],
  [{ ...a, start_index: -1 }],
  [{ ...a, start_index: 5, end_index: 4 }],
  [{ ...a, end_index: 99 }],
])('rejects malformed annotations %j', (value) =>
  expect(() => citations(value, 'News today')).toThrow(),
);
it('streams search activity before completion and emits citations', async () => {
  const msg = {
    type: 'message',
    id: 'm',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'News today', annotations: [a] }],
  };
  async function* frames() {
    for (const e of [
      { type: 'response.created', response: { id: 'r' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
      },
      { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.output_item.added', output_index: 1, item: { ...msg, content: [] } },
      { type: 'response.output_item.done', output_index: 1, item: msg },
      {
        type: 'response.completed',
        response: { id: 'r', status: 'completed', output: [call, msg] },
      },
    ])
      yield { data: JSON.stringify(e) };
  }
  const events = [];
  for await (const e of translateStream(frames(), 'glm')) events.push(e);
  const starts = events.filter((e) => e.type === 'content_block_start');
  expect(starts.map((e) => (e.content_block as any).type)).toEqual([
    'server_tool_use',
    'web_search_tool_result',
    'redacted_thinking',
    'text',
  ]);
  expect(events.some((e) => (e.delta as any)?.type === 'citations_delta')).toBe(true);
  expect(events.filter((e) => e.type === 'content_block_stop')).toHaveLength(4);
});
import { repairAnswerPrefix } from '../src/answer-prefix.js';
it('preserves citation offsets and phase metadata after prefix repair', async () => {
  const citation = citations([a], 'News')![0];
  const phase = outputBlocks({
    type: 'message',
    id: 'm',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'News', annotations: [a] }],
  })[1];
  const start = (index: number, content_block: any) => ({
    type: 'content_block_start',
    index,
    content_block,
  });
  const stop = (index: number) => ({ type: 'content_block_stop', index });
  async function* source() {
    yield* [
      start(0, { type: 'thinking', thinking: '', signature: '' }),
      stop(0),
      start(1, { type: 'text', text: '' }),
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi ' } },
      stop(1),
      start(2, { type: 'thinking', thinking: '', signature: '' }),
      stop(2),
      start(3, { type: 'text', text: '' }),
      { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'News' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation } },
      stop(3),
      start(4, phase),
      stop(4),
      { type: 'message_stop' },
    ];
  }
  const events = [];
  for await (const e of repairAnswerPrefix(source())) events.push(e);
  const c = (events.find((e) => (e.delta as any)?.type === 'citations_delta')!.delta as any)
    .citation;
  const metadata = events.find(
    (e) => (e.content_block as any)?.type === 'redacted_thinking',
  )!.content_block;
  const input = toResponses(
    req({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi News', citations: [c] }, metadata],
        },
      ],
    }),
  ).input as any[];
  expect(input[0].content[0].annotations).toEqual([{ ...a, start_index: 3, end_index: 7 }]);
});
it('replays failed search without an action', () => {
  const item = { type: 'web_search_call', id: 'w', status: 'failed' };
  expect(
    toResponses(req({ messages: [{ role: 'assistant', content: searchBlocks(item) }] })).input,
  ).toEqual([item]);
});
