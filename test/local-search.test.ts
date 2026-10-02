import { it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  prepareLocalSearch,
  replayLocalSearches,
  LocalSearchLoop,
  localSearchEvents,
} from '../src/local-search.js';
import { toResponses, toMessage } from '../src/translate.js';
import { translateStream, sse } from '../src/stream.js';
import type { JsonObject } from '../src/protocol.js';
const native = { type: 'web_search_20250305', name: 'web_search' };
const request = (extra: any = {}) => ({
  model: 'opencode/glm-5.3-flash',
  max_tokens: 200,
  messages: [{ role: 'user', content: 'news' }],
  tools: [native],
  ...extra,
});
const signal = new AbortController().signal;
const search = vi.fn(async () => [
  { url: 'https://example.com/news', title: 'News', snippet: 'Fresh news', date: '2026-10-02' },
]);
const plan = (extra: any = {}) => {
  const req = request(extra);
  return prepareLocalSearch(req, toResponses(req), search)!;
};
const call = (id = '1', args = JSON.stringify({ query: 'latest news' })) => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: `call_${id}`,
  name: 'web_search',
  arguments: args,
  status: 'completed',
});
const text = {
  type: 'message',
  id: 'm',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'News answer', annotations: [] }],
};
const response = (output: any[], extra: any = {}) => ({
  id: 'r',
  status: 'completed',
  output,
  usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
  ...extra,
});
const loop = (extra: any = {}) => new LocalSearchLoop(plan(extra), search, signal);
async function collect<T>(source: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}
const stream = (events: any[]) =>
  new Response(events.map(sse).join(''), { headers: { 'content-type': 'text/event-stream' } });
const turn = (items: any[], deltas = false) => [
  { type: 'response.created', response: { id: 'r' } },
  ...items.flatMap((item, i) => [
    {
      type: 'response.output_item.added',
      output_index: i,
      item: { ...item, ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) },
    },
    ...(deltas && item.type === 'function_call'
      ? [
          {
            type: 'response.function_call_arguments.delta',
            output_index: i,
            item_id: item.id,
            delta: item.arguments,
          },
        ]
      : []),
    { type: 'response.output_item.done', output_index: i, item },
  ]),
  { type: 'response.completed', response: response(items) },
];
it('only opts in when a native definition is present on a local route', () => {
  for (const model of ['openai/gpt-5']) {
    const req = request({ model });
    expect(prepareLocalSearch(req, toResponses(req), search)).toBeUndefined();
  }
  const req = request({ tools: [{ name: 'web_search', input_schema: { type: 'object' } }] });
  expect(prepareLocalSearch(req, toResponses(req), search)).toBeUndefined();
  const p = plan({ tool_choice: { type: 'tool', name: 'web_search' } });
  expect(p.body.tool_choice).toEqual({ type: 'function', name: 'web_search' });
  expect(p.body.tools).toMatchObject([{ type: 'function', name: 'web_search' }]);
  expect(p.body.include).not.toContain('web_search_call.action.sources');
  expect(p.body).not.toHaveProperty('max_tool_calls');
});
it('requires backend and rejects unsupported location explicitly', () => {
  const r = request();
  expect(() => prepareLocalSearch(r, toResponses(r))).toThrow(/KAGI_SESSION/);
  expect(() =>
    plan({ tools: [{ ...native, user_location: { type: 'approximate', country: 'GB' } }] }),
  ).toThrow(/user_location/);
});
it.each(['auto', 'none', 'any'])('accepts %s tool choice', (type) =>
  expect(plan({ tool_choice: { type } }).body).toBeDefined(),
);
it('executes search and continues with preserved function history', async () => {
  const p = plan({ tool_choice: { type: 'tool', name: 'web_search' } }),
    l = new LocalSearchLoop(p, search, signal);
  const first = await l.json(response([call()]));
  expect(first.next?.tool_choice).toBe('auto');
  expect(first.next?.max_output_tokens).toBe(195);
  expect((first.next?.input as any[]).slice(-2)).toEqual([
    call(),
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: expect.stringContaining('Fresh news'),
    },
  ]);
  const last = await l.json(response([text]));
  expect(last.next).toBeUndefined();
  expect(last.response.usage).toEqual({
    input_tokens: 20,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
  });
  expect(last.response.output).toHaveLength(2);
  const message = toMessage(last.response, 'glm');
  expect(message.stop_reason).toBe('end_turn');
  const replay = toResponses(
    request({
      messages: [
        { role: 'assistant', content: message.content },
        { role: 'user', content: 'more' },
      ],
    }),
  );
  replayLocalSearches(replay);
  expect((replay.input as any[]).slice(0, 2)).toEqual((first.next?.input as any[]).slice(-2));
});
it('preserves other functions while handling native search', async () => {
  const l = loop();
  const other = { ...call('2'), name: 'calc' };
  const result = await l.json(response([call(), other]));
  expect(result.next).toBeUndefined();
  expect(toMessage(result.response, 'glm').stop_reason).toBe('tool_use');
  expect((result.response.output as any[])[1]).toEqual(other);
});
it('enforces max uses and removes search on continuation', async () => {
  const l = loop({ tools: [{ ...native, max_uses: 1 }] });
  const first = await l.json(response([call()]));
  expect(first.next?.tools).toEqual([]);
  const second = await l.json(response([call('2')]));
  expect((second.response.output as any[])[1].spx_error).toBe('max_uses_exceeded');
  expect(
    (toMessage(second.response, 'glm').content as any[]).find(
      (b) => b.type === 'web_search_tool_result' && !Array.isArray(b.content),
    ).content.error_code,
  ).toBe('max_uses_exceeded');
});
it.each(['{', '{}', '{"query":""}', '{"query":12}', '{"query":"q","extra":1}'])(
  'reports invalid arguments %s',
  async (args) => {
    const r = await loop().execute(call('1', args));
    expect(r.spx_error).toBe('invalid_input');
  },
);
it('redacts backend errors and distinguishes cancellation', async () => {
  const backend = async () => {
    throw new Error('PERSONAL AUTH SECRET');
  };
  const l = new LocalSearchLoop(plan(), backend, signal);
  const r = await l.execute(call());
  expect(JSON.stringify(r)).not.toContain('PERSONAL AUTH SECRET');
  expect(r.spx_error).toBe('unavailable');
  const c = new AbortController();
  c.abort();
  await expect(new LocalSearchLoop(plan(), backend, c.signal).execute(call())).rejects.toThrow(
    /interrupted/,
  );
});
it('reapplies domain restrictions to backend results', async () => {
  const p = plan({ tools: [{ ...native, allowed_domains: ['good.com'] }] });
  const l = new LocalSearchLoop(
    p,
    async () => [{ url: 'https://evil.com', title: 'Bad', snippet: 'bad' }],
    signal,
  );
  expect((await l.execute(call())).action).toEqual({
    type: 'search',
    query: 'latest news',
    sources: [],
  });
});
it('stops at output budget and incomplete upstream responses', async () => {
  expect((await loop({ max_tokens: 5 }).json(response([call()]))).response.status).toBe(
    'incomplete',
  );
  expect(
    (
      await loop().json(
        response([call()], {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      )
    ).next,
  ).toBeUndefined();
});
it.each([
  { usage: { output_tokens: -1 } },
  { usage: { input_tokens: 1.2 } },
  { usage: { input_tokens_details: { cached_tokens: -1 } } },
  { output: undefined },
])(
  'rejects bad response %j',
  async (extra) => await expect(loop().json(response([], extra))).rejects.toThrow(),
);
it('rejects malformed or foreign replay metadata', () => {
  for (const item of [{ type: 'web_search_call' }, { type: 'web_search_call', spx_local: {} }])
    expect(() => replayLocalSearches({ input: [item] })).toThrow();
});
it('rejects malformed calls and duplicate call IDs', async () => {
  const l = loop();
  await expect(l.execute({ ...call(), call_id: undefined })).rejects.toThrow();
  await l.execute(call());
  await expect(l.execute(call())).rejects.toThrow(/Duplicate/);
});
it('bounds repeated search rounds', async () => {
  const l = loop({ max_tokens: 10000, tools: [{ ...native, max_uses: 20 }] });
  for (let i = 0; i < 15; i++) await l.json(response([call(String(i))]));
  await expect(l.json(response([call('15')]))).rejects.toThrow(/limit/);
});
it('handles arbitrary Unicode queries without escaping corruption', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
      async (query) => {
        const backend = vi.fn(async (_query: string) => []);
        const l = new LocalSearchLoop(plan(), backend, signal);
        await l.execute(call('1', JSON.stringify({ query })));
        expect(backend.mock.calls[0]?.[0]).toBe(query.trim());
      },
    ),
    { numRuns: 100 },
  );
});
it('joins streamed generations with one lifecycle and ordinary tool preservation', async () => {
  const l = loop(),
    send = vi.fn(async () => stream(turn([text])));
  const events = await collect(
    translateStream(localSearchEvents(stream(turn([call()], true)), l, send), 'glm'),
  );
  expect(events.filter((e) => e.type === 'message_start')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'message_stop')).toHaveLength(1);
  expect(
    events
      .filter((e) => e.type === 'content_block_start')
      .map((e) => (e.content_block as any).type),
  ).toEqual(['server_tool_use', 'web_search_tool_result', 'redacted_thinking', 'text']);
  expect(send).toHaveBeenCalledOnce();
  expect(events.find((e) => (e.delta as any)?.type === 'text_delta')?.delta).toEqual({
    type: 'text_delta',
    text: 'News answer',
  });
});
it.each([true, false])('fills terminal-only/missing-done snapshots %s', async (only) => {
  const events = only
    ? [{ type: 'response.completed', response: response([call()]) }]
    : turn([call()]).filter((e) => e.type !== 'response.output_item.done');
  const result = await collect(
    translateStream(
      localSearchEvents(stream(events), loop(), async () =>
        stream([{ type: 'response.completed', response: response([text]) }]),
      ),
      'glm',
    ),
  );
  expect(result.at(-1)?.type).toBe('message_stop');
});
it('forwards text before generation completion or search execution', async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        enc.encode(
          sse({ type: 'response.created', response: { id: 'r' } }) +
            sse({
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...text, content: [] },
            }) +
            sse({
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: 'm',
              content_index: 0,
              delta: 'Live',
            }),
        ),
      );
      await wait;
      controller.enqueue(
        enc.encode(
          sse({
            type: 'response.completed',
            response: response([
              { ...text, content: [{ type: 'output_text', text: 'Live', annotations: [] }] },
            ]),
          }),
        ),
      );
      controller.close();
    },
  });
  const iterator = translateStream(
    localSearchEvents(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      loop(),
      async () => {
        throw new Error();
      },
    ),
    'glm',
  )[Symbol.asyncIterator]();
  let found = false;
  for (let i = 0; i < 5; i++) {
    const e = await iterator.next();
    if ((e.value?.delta as any)?.text === 'Live') {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
  release();
  while (!(await iterator.next()).done) {}
});
it.each(
  [
    [],
    [{ type: 'response.created', response: { id: 'r' } }],
    [
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: response([], { id: 'different' }) },
    ],
    [
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.added', output_index: -1, item: call() },
    ],
    [
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.completed', response: response([], { status: 'incomplete' }) },
    ],
    [
      { type: 'response.completed', response: response([]) },
      { type: 'response.created', response: { id: 'r' } },
    ],
  ].map((events) => ({ events })),
)(
  'rejects broken streamed lifecycle %j',
  async ({ events }) =>
    await expect(
      collect(localSearchEvents(stream(events), loop(), async () => stream([]))),
    ).rejects.toThrow(),
);
it('rejects non-SSE and excessive stream data', async () => {
  await expect(
    collect(localSearchEvents(new Response('html'), loop(), async () => stream([]))),
  ).rejects.toThrow(/SSE/);
  await expect(
    collect(localSearchEvents(stream(turn([])), loop(), async () => stream([]), { maxBytes: 1 })),
  ).rejects.toThrow(/size/);
});
it.each(['id', 'arguments'])('rejects changed search %s', async (field) => {
  const events = turn([call()], true);
  (events[2] as any).item;
  const done = events.find((e) => e.type === 'response.output_item.done')! as any;
  done.item = { ...done.item, [field]: 'changed' };
  await expect(
    collect(localSearchEvents(stream(events), loop(), async () => stream([]))),
  ).rejects.toThrow();
});
it('does not intercept a translated tool without the native definition', () =>
  expect(
    prepareLocalSearch(request({ tools: [] }), { tools: [{ type: 'web_search' }] }, search),
  ).toBeUndefined());
it('allows hosted history on OpenAI and replays local history across model switches', async () => {
  const hosted = { type: 'web_search_call', id: 'w' };
  const body = { input: [hosted] };
  replayLocalSearches(body, true);
  expect(body.input).toEqual([hosted]);
  const item = await loop().execute(call());
  const replay: any = { input: [item] };
  replayLocalSearches(replay, true);
  expect(replay.input.map((i: any) => i.type)).toEqual(['function_call', 'function_call_output']);
});
it('refuses a search generated despite tool_choice none', async () =>
  await expect(
    new LocalSearchLoop(plan({ tool_choice: { type: 'none' } }), search, signal).execute(call()),
  ).rejects.toThrow(/tool_choice/));
it('streams external tool calls alongside locally executed search without continuing', async () => {
  const send = vi.fn(async () => stream([]));
  const other = { ...call('2'), name: 'calc' };
  const events = await collect(
    translateStream(localSearchEvents(stream(turn([call(), other])), loop(), send), 'glm'),
  );
  expect(send).not.toHaveBeenCalled();
  expect(events.find((e) => e.type === 'message_delta')?.delta).toMatchObject({
    stop_reason: 'tool_use',
  });
  expect(
    events
      .filter((e) => e.type === 'content_block_start')
      .map((e) => (e.content_block as any).type),
  ).toContain('tool_use');
});
it('rejects search delta ID/type mismatches and duplicate completion', async () => {
  const modified = (update: (events: any[]) => void) => {
    const events = turn([call()], true);
    update(events);
    return collect(localSearchEvents(stream(events), loop(), async () => stream([])));
  };
  await expect(modified((events) => (events[2].item_id = 'wrong'))).rejects.toThrow(/ID/);
  await expect(modified((events) => (events[2].delta = 123))).rejects.toThrow(/delta/);
  await expect(modified((events) => events.splice(4, 0, events[3]))).rejects.toThrow(/Duplicate/);
  await expect(modified((events) => events.splice(4, 0, events[2]))).rejects.toThrow(/after/);
});
it('rejects changed terminal search metadata or dropped items', async () => {
  for (const mutate of [
    (e: any[]) => {
      e.at(-1).response.output = [{ ...call(), arguments: '{}' }];
    },
    (e: any[]) => {
      e.at(-1).response.output = [];
    },
  ]) {
    const events = turn([call()], true);
    mutate(events);
    await expect(
      collect(localSearchEvents(stream(events), loop(), async () => stream([]))),
    ).rejects.toThrow();
  }
});
it('handles redundant argument completion and DONE sentinels', async () => {
  const events = turn([call()], true);
  events.splice(3, 0, {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: 'fc_1',
    arguments: call().arguments,
  } as any);
  const first = new Response(events.map(sse).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
  const result = await collect(
    translateStream(
      localSearchEvents(first, loop(), async () => stream(turn([text]))),
      'glm',
    ),
  );
  expect(result.at(-1)?.type).toBe('message_stop');
});
it('rejects premature DONE', async () =>
  await expect(
    collect(
      localSearchEvents(
        new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        loop(),
        async () => stream([]),
      ),
    ),
  ).rejects.toThrow(/interrupted/));
