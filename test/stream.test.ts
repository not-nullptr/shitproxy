import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseSse, translateStream, sse, type SseEvent } from '../src/stream.js';
import { toMessage } from '../src/translate.js';
import type { JsonObject, ReasoningItem } from '../src/protocol.js';
async function* chunks(bytes: Uint8Array, sizes: number[]) {
  let offset = 0,
    i = 0;
  while (offset < bytes.length) {
    const n = sizes[i++ % sizes.length]!;
    yield bytes.slice(offset, offset + n);
    offset += n;
  }
}
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of input) out.push(value);
  return out;
}
const created = { type: 'response.created', response: { id: 'resp_1' } };
const textItem = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'Hello 🌎\n世界', annotations: [] }],
};
const complete = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    status: 'completed',
    output,
    usage: { input_tokens: 25, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } },
    ...extra,
  },
});
const added = (item: unknown, output_index = 0) => ({
  type: 'response.output_item.added',
  output_index,
  item,
});
const done = (item: unknown, output_index = 0) => ({
  type: 'response.output_item.done',
  output_index,
  item,
});
async function* frames(events: unknown[]) {
  for (const event of events) yield { data: JSON.stringify(event) };
}
const run = (events: unknown[]) => collect(translateStream(frames(events), 'exact/model'));
function assemble(events: JsonObject[]): any {
  const message = structuredClone(events.find((e) => e.type === 'message_start')!.message) as any;
  for (const event of events) {
    const index = event.index as number;
    if (event.type === 'content_block_start')
      message.content[index] = structuredClone(event.content_block);
    if (event.type === 'content_block_delta') {
      const delta = event.delta as any,
        block = message.content[index];
      if (delta.type === 'text_delta') block.text += delta.text;
      if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      if (delta.type === 'signature_delta')
        block.signature = (block.signature ?? '') + delta.signature;
      if (delta.type === 'input_json_delta') block.json = (block.json ?? '') + delta.partial_json;
    }
    if (event.type === 'content_block_stop' && message.content[index].type === 'tool_use') {
      const block = message.content[index];
      block.input = JSON.parse(block.json ?? '{}');
      delete block.json;
    }
    if (event.type === 'message_delta') {
      Object.assign(message, event.delta);
      Object.assign(message.usage, event.usage);
    }
  }
  return message;
}
describe('SSE byte framing', () => {
  const source =
    ': keepalive\r\nevent: sample\r\ndata: {"a":"世界🌎"}\r\ndata: second\r\n\r\nid: 1\nretry: 4\ndata: next\n\n';
  it.each([1, 2, 3, 4, 7, 64, 1024])('chunk size %s', async (size) =>
    expect(await collect(parseSse(chunks(Buffer.from(source), [size])))).toEqual([
      { event: 'sample', data: '{"a":"世界🌎"}\nsecond' },
      { event: undefined, data: 'next' },
    ]),
  );
  it('every single split boundary', async () => {
    const bytes = Buffer.from(source);
    for (let i = 1; i < bytes.length; i++) {
      async function* split() {
        yield bytes.subarray(0, i);
        yield bytes.subarray(i);
      }
      expect(await collect(parseSse(split()))).toHaveLength(2);
    }
  });
  it.each(['\n', '\r', '\r\n'])('line endings %j', async (nl) =>
    expect(
      await collect(parseSse(chunks(Buffer.from(['event: x', 'data: y', '', ''].join(nl)), [1]))),
    ).toEqual([{ event: 'x', data: 'y' }]),
  );
  it('BOM accepted', async () =>
    expect(await collect(parseSse(chunks(Buffer.from('\ufeffdata: x\n\n'), [1])))).toEqual([
      { event: undefined, data: 'x' },
    ]));
  it('colonless data field', async () =>
    expect(await collect(parseSse(chunks(Buffer.from('data\n\n'), [1])))).toEqual([
      { event: undefined, data: '' },
    ]));
  it('only one optional space removed', async () =>
    expect(await collect(parseSse(chunks(Buffer.from('data:  x\n\n'), [1])))).toEqual([
      { event: undefined, data: ' x' },
    ]));
  it('discards unterminated frame', async () =>
    expect(await collect(parseSse(chunks(Buffer.from('data: x\n'), [1])))).toEqual([]));
  it.each([
    'data: ' + 'x'.repeat(200) + '\n\n',
    'data: ' + 'x'.repeat(200),
    'event: ' + 'x'.repeat(200) + '\n',
  ])(
    'bounds frame memory',
    async (source) =>
      await expect(collect(parseSse(chunks(Buffer.from(source), [1]), 100))).rejects.toThrow(
        /limit/,
      ),
  );
  it('rejects invalid UTF8', async () =>
    await expect(collect(parseSse(chunks(new Uint8Array([0xff, 0xfe]), [1])))).rejects.toThrow(
      /Invalid/,
    ));
  it('rejects truncated UTF8', async () =>
    await expect(collect(parseSse(chunks(new Uint8Array([0xf0, 0x9f]), [1])))).rejects.toThrow(
      /Invalid/,
    ));
  it('transport interruption', async () => {
    async function* broken() {
      yield Buffer.from('data: x\n\n');
      throw new Error('socket reset');
    }
    await expect(collect(parseSse(broken()))).rejects.toThrow(/interrupted/);
  });
  it('SSE serializer escapes injection', () => {
    const encoded = sse({ type: 'text', text: '\n\nevent: malicious\ndata: secret' });
    expect(encoded.split('\n')).toHaveLength(4);
    expect(JSON.parse(encoded.split('\n')[1]!.slice(6)).text).toContain('malicious');
  });
});
describe('stream translation golden cases', () => {
  const textEvents = [
    created,
    added({ ...textItem, content: [] }),
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: 'Hello ',
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      item_id: 'msg_1',
      content_index: 0,
      delta: '🌎\n世界',
    },
    done(textItem),
    complete([textItem]),
  ];
  it('matches buffered text including usage', async () =>
    expect(assemble(await run(textEvents))).toEqual(
      toMessage(complete([textItem]).response, 'exact/model'),
    ));
  it('text arrives before upstream completion', async () => {
    const iterator = translateStream(frames(textEvents), 'm');
    expect((await iterator.next()).value!.type).toBe('message_start');
    expect((await iterator.next()).value!.type).toBe('content_block_start');
    expect((await iterator.next()).value).toMatchObject({
      type: 'content_block_delta',
      delta: { text: 'Hello ' },
    });
    await iterator.return(undefined);
  });
  it('does not duplicate text at done', async () => {
    const events = await run(textEvents);
    expect(
      events
        .filter((e) => e.type === 'content_block_delta')
        .map((e) => (e.delta as any).text)
        .join(''),
    ).toBe(textItem.content[0]!.text);
  });
  it('fills missing final suffix', async () =>
    expect(assemble(await run(textEvents.filter((_, i) => i !== 3))).content[0].text).toBe(
      textItem.content[0]!.text,
    ));
  it('terminal-only snapshot fallback', async () =>
    expect(assemble(await run([complete([textItem])]))).toEqual(
      toMessage(complete([textItem]).response, 'exact/model'),
    ));
  it('missing item.done recovered at terminal', async () =>
    expect(
      assemble(await run(textEvents.filter((e) => e.type !== 'response.output_item.done'))),
    ).toEqual(toMessage(complete([textItem]).response, 'exact/model')));
  it('empty output', async () =>
    expect((await run([created, complete([])])).map((e) => e.type)).toEqual([
      'message_start',
      'message_delta',
      'message_stop',
    ]));
  it.each(
    [
      [],
      [{ type: 'summary_text', text: 'summary' }],
      [
        { type: 'summary_text', text: 'one' },
        { type: 'summary_text', text: 'two' },
      ],
    ].map((summary) => ({ summary })),
  )('reasoning summary $summary', async ({ summary }) => {
    const item: ReasoningItem & { id: string } = {
      type: 'reasoning',
      id: 'rs_1',
      summary: summary as ReasoningItem['summary'],
      encrypted_content: 'opaque+/==',
    };
    const deltas = summary.map((p, summary_index) => ({
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      item_id: 'rs_1',
      summary_index,
      delta: p.text,
    }));
    const events = await run([
      created,
      added({ ...item, summary: [], encrypted_content: undefined }),
      ...deltas,
      done(item),
      complete([item]),
    ]);
    expect(assemble(events)).toEqual(toMessage(complete([item]).response, 'exact/model'));
    if (summary.length) {
      const signature = events.findIndex((e) => (e.delta as any)?.type === 'signature_delta');
      expect(events[signature + 1]!.type).toBe('content_block_stop');
    }
  });
  it('plaintext reasoning_text supported', async () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'plain' }],
    };
    expect(
      assemble(
        await run([
          created,
          added({ ...item, content: [] }),
          {
            type: 'response.reasoning_text.delta',
            output_index: 0,
            item_id: 'rs_1',
            content_index: 0,
            delta: 'plain',
          },
          done(item),
          complete([item]),
        ]),
      ),
    ).toEqual(toMessage(complete([item]).response, 'exact/model'));
  });
  it('plaintext plus summary in same reasoning item', async () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'sum' }],
      content: [{ type: 'reasoning_text', text: 'raw' }],
    };
    expect(
      assemble(
        await run([
          created,
          added({ ...item, summary: [], content: [] }),
          {
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            item_id: 'rs_1',
            summary_index: 0,
            delta: 'sum',
          },
          {
            type: 'response.reasoning_text.delta',
            output_index: 0,
            item_id: 'rs_1',
            content_index: 0,
            delta: 'raw',
          },
          done(item),
          complete([item]),
        ]),
      ),
    ).toEqual(toMessage(complete([item]).response, 'exact/model'));
  });
  it('tool arguments fragmented and Unicode', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'Task',
      arguments: '{"prompt":"世界","a":[1,true,null]}',
    };
    const events = await run([
      created,
      added({ ...item, arguments: '' }),
      ...Array.from(item.arguments).map((delta) => ({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta,
      })),
      done(item),
      complete([item]),
    ]);
    expect(assemble(events)).toEqual(toMessage(complete([item]).response, 'exact/model'));
  });
  it('parallel calls interleaved', async () => {
    const a = {
        type: 'function_call',
        id: 'fc_a',
        call_id: 'a',
        name: 'Task',
        arguments: '{"x":1}',
      },
      b = { ...a, id: 'fc_b', call_id: 'b', arguments: '{"x":2}' };
    const events = await run([
      created,
      added({ ...a, arguments: '' }),
      added({ ...b, arguments: '' }, 1),
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc_b',
        delta: '{"x":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_a',
        delta: '{"x":',
      },
      done(a),
      done(b, 1),
      complete([a, b]),
    ]);
    expect(assemble(events)).toEqual(toMessage(complete([a, b]).response, 'exact/model'));
  });
  it('multiple message content parts', async () => {
    const item = {
      ...textItem,
      content: [
        { type: 'output_text', text: 'a' },
        { type: 'output_text', text: 'b' },
      ],
    };
    expect(
      assemble(
        await run([
          created,
          added({ ...item, content: [] }),
          ...['a', 'b'].map((delta, content_index) => ({
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index,
            delta,
          })),
          done(item),
          complete([item]),
        ]),
      ),
    ).toEqual(toMessage(complete([item]).response, 'exact/model'));
  });
  it('refusal stream', async () => {
    const item = { ...textItem, content: [{ type: 'refusal', refusal: 'no' }] };
    expect(
      assemble(
        await run([
          created,
          added({ ...item, content: [] }),
          {
            type: 'response.refusal.delta',
            output_index: 0,
            item_id: 'msg_1',
            content_index: 0,
            delta: 'no',
          },
          done(item),
          complete([item]),
        ]),
      ),
    ).toEqual(toMessage(complete([item]).response, 'exact/model'));
  });
  it('incomplete max_tokens stream', async () => {
    const event = {
      ...complete([textItem], {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
      type: 'response.incomplete',
    };
    expect(assemble(await run([created, event])).stop_reason).toBe('max_tokens');
  });
  it.each([
    'response.content_part.added',
    'response.content_part.done',
    'response.output_text.done',
    'response.refusal.done',
    'response.function_call_arguments.done',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.done',
    'response.reasoning_text.done',
  ])('redundant %s accepted', async (type) =>
    expect(assemble(await run([created, { type }, complete([textItem])])).content[0].text).toBe(
      textItem.content[0]!.text,
    ),
  );
  it('in_progress can start stream', async () =>
    expect((await run([{ ...created, type: 'response.in_progress' }, complete([])]))[0]!.type).toBe(
      'message_start',
    ));
  it('duplicate response lifecycle does not duplicate message_start', async () =>
    expect(
      (await run([created, { ...created, type: 'response.in_progress' }, complete([])])).filter(
        (e) => e.type === 'message_start',
      ),
    ).toHaveLength(1));
  it('arbitrary Unicode text / byte boundaries (200 examples)', async () =>
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'grapheme' }),
        fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 10 }),
        async (text, sizes) => {
          const item = { ...textItem, content: [{ type: 'output_text', text }] };
          const raw = [
            created,
            added({ ...item, content: [] }),
            {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: 'msg_1',
              content_index: 0,
              delta: text,
            },
            done(item),
            complete([item]),
          ]
            .map(sse)
            .join('');
          expect(
            assemble(
              await collect(
                translateStream(parseSse(chunks(Buffer.from(raw), sizes)), 'exact/model'),
              ),
            ),
          ).toEqual(toMessage(complete([item]).response, 'exact/model'));
        },
      ),
      { numRuns: 200, seed: 718 },
    ));
});
describe('stream errors never fake completion', () => {
  it.each(
    [
      [],
      [created],
      [created, { type: 'error' }],
      [created, { type: 'response.failed' }],
      [{ type: 'response.output_text.delta', delta: 'x' }],
      [created, { type: 'unknown' }],
      [created, added({ type: 'web_search_call', id: 'x' })],
      [created, added({ ...textItem, content: [] }), added({ ...textItem, content: [] })],
      [created, { type: 'response.output_item.added', output_index: -1, item: textItem }],
      [created, { type: 'response.output_item.done', output_index: 0, item: textItem }],
      [created, added({ ...textItem, content: [] }), done({ ...textItem, id: 'changed' })],
      [
        created,
        added({ ...textItem, content: [] }),
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'wrong',
          content_index: 0,
          delta: 'x',
        },
      ],
      [
        created,
        added({ ...textItem, content: [] }),
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          content_index: -1,
          delta: 'x',
        },
      ],
      [
        created,
        added({ ...textItem, content: [] }),
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'msg_1',
          delta: 'x',
        },
      ],
      [
        created,
        added({ ...textItem, content: [] }),
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          content_index: 0,
          delta: 1,
        },
      ],
      [
        created,
        added({ ...textItem, content: [] }),
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          content_index: 0,
          delta: 'wrong',
        },
        done(textItem),
      ],
      [created, added({ ...textItem, content: [] }), done(textItem), done(textItem)],
      [
        created,
        added({ ...textItem, content: [] }),
        done(textItem),
        {
          type: 'response.output_text.delta',
          output_index: 0,
          item_id: 'msg_1',
          content_index: 0,
          delta: 'x',
        },
      ],
      [
        created,
        added({ ...textItem, content: [] }),
        done(textItem),
        complete([{ ...textItem, content: [] }]),
      ],
      [created, added({ ...textItem, content: [] }), complete([])],
      [created, complete([]), { type: 'response.in_progress', response: { id: 'resp_1' } }],
      [
        created,
        added({ type: 'reasoning', id: 'rs', summary: [] }),
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs',
          summary_index: 0,
          delta: 'lost',
        },
        done({ type: 'reasoning', id: 'rs', summary: [] }),
      ],
    ].map((events) => ({ events })),
  )('rejects sequence $events', async ({ events }) => await expect(run(events)).rejects.toThrow());
  it('malformed SSE JSON', async () => {
    async function* input() {
      yield { data: '{invalid' };
    }
    await expect(collect(translateStream(input(), 'm'))).rejects.toThrow(/Malformed/);
  });
  it('event name mismatch', async () => {
    async function* input() {
      yield { event: 'wrong', data: JSON.stringify(created) };
    }
    await expect(collect(translateStream(input(), 'm'))).rejects.toThrow(/disagrees/);
  });
  it('DONE before terminal rejected', async () => {
    async function* input() {
      yield { data: JSON.stringify(created) };
      yield { data: '[DONE]' };
    }
    await expect(collect(translateStream(input(), 'm'))).rejects.toThrow(/terminal/);
  });
  it('DONE after terminal accepted', async () => {
    async function* input() {
      yield { data: JSON.stringify(complete([])) };
      yield { data: '[DONE]' };
    }
    expect((await collect(translateStream(input(), 'm'))).at(-1)!.type).toBe('message_stop');
  });
});

describe('ordered streaming across parallel items', () => {
  it('encrypted-only reasoning stays before interleaved tool calls', async () => {
    const reasoning = { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'cipher' },
      tool = { type: 'function_call', id: 'fc', call_id: 'c', name: 'Task', arguments: '{}' };
    const events = await run([
      created,
      added({ ...reasoning, encrypted_content: undefined }),
      added({ ...tool, arguments: '' }, 1),
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'fc',
        delta: '{}',
      },
      done(tool, 1),
      done(reasoning),
      complete([reasoning, tool]),
    ]);
    expect(assemble(events)).toEqual(
      toMessage(complete([reasoning, tool]).response, 'exact/model'),
    );
  });
  it('out-of-order item.added and done retain canonical order', async () => {
    const second = { ...textItem, id: 'msg_2', content: [{ type: 'output_text', text: 'second' }] };
    expect(
      assemble(
        await run([
          created,
          added(second, 1),
          done(second, 1),
          added(textItem, 0),
          done(textItem, 0),
          complete([textItem, second]),
        ]),
      ),
    ).toEqual(toMessage(complete([textItem, second]).response, 'exact/model'));
  });
  it('interleaved items missing done recovered from terminal', async () => {
    const reasoning = { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'cipher' },
      tool = { type: 'function_call', id: 'fc', call_id: 'c', name: 'Task', arguments: '{}' };
    expect(
      assemble(
        await run([
          created,
          added({ ...reasoning, encrypted_content: undefined }),
          added({ ...tool, arguments: '' }, 1),
          {
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            item_id: 'fc',
            delta: '{}',
          },
          complete([reasoning, tool]),
        ]),
      ),
    ).toEqual(toMessage(complete([reasoning, tool]).response, 'exact/model'));
  });
  it('buffered item outside final output rejected', async () =>
    await expect(run([created, added(textItem, 10), complete([])])).rejects.toThrow(/buffered/));
  it('bounds total event bytes', async () =>
    await expect(
      collect(
        translateStream(
          frames([created, added(textItem), done(textItem), complete([textItem])]),
          'm',
          100,
        ),
      ),
    ).rejects.toThrow(/limit/));
  it('reasoning summary indices cannot move backwards', async () =>
    await expect(
      run([
        created,
        added({ type: 'reasoning', id: 'rs', summary: [] }),
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs',
          summary_index: 1,
          delta: 'b',
        },
        {
          type: 'response.reasoning_summary_text.delta',
          output_index: 0,
          item_id: 'rs',
          summary_index: 0,
          delta: 'a',
        },
      ]),
    ).rejects.toThrow(/Interleaved/));
});

it('empty streamed summary retains a thinking signature', async () => {
  const item = {
    type: 'reasoning',
    id: 'rs',
    summary: [{ type: 'summary_text', text: '' }],
    encrypted_content: 'cipher',
  };
  const events = await run([
    created,
    added({ ...item, summary: [] }),
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      item_id: 'rs',
      summary_index: 0,
      delta: '',
    },
    done(item),
    complete([item]),
  ]);
  expect(assemble(events)).toEqual(toMessage(complete([item]).response, 'exact/model'));
});
it('streamed tool identity cannot change', async () => {
  const initial = { type: 'function_call', id: 'fc', call_id: 'c', name: 'Task', arguments: '' };
  await expect(
    run([
      created,
      added(initial),
      done({ ...initial, call_id: 'changed', arguments: '{}' }),
      complete([]),
    ]),
  ).rejects.toThrow(/identity/);
});
it('response identity cannot change', async () =>
  await expect(run([created, complete([], { id: 'changed' })])).rejects.toThrow(/ID changed/));
it('terminal event status must agree', async () =>
  await expect(
    run([
      created,
      complete([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    ]),
  ).rejects.toThrow(/status mismatch/));
it('output item must have ID', async () =>
  await expect(
    run([created, added({ type: 'message', role: 'assistant', content: [] })]),
  ).rejects.toThrow(/item id/));
it('out-of-order text parts fail explicitly', async () =>
  await expect(
    run([
      created,
      added({ ...textItem, content: [] }),
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg_1',
        content_index: 1,
        delta: 'second',
      },
    ]),
  ).rejects.toThrow(/Out-of-order/));
it('reasoning part indices must be valid', async () =>
  await expect(
    run([
      created,
      added({ type: 'reasoning', id: 'rs', summary: [] }),
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: 'rs',
        summary_index: -1,
        delta: 'x',
      },
    ]),
  ).rejects.toThrow(/part index/));

it.each(['commentary', 'final_answer', null])(
  'streamed phase %s survives replay',
  async (phase) => {
    const item = { ...textItem, phase, status: 'completed' };
    const events = await run([
      created,
      added({ ...item, content: [] }),
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Hello ',
      },
      done(item),
      complete([item]),
    ]);
    expect(assemble(events)).toEqual(toMessage(complete([item]).response, 'exact/model'));
  },
);
it('upstream encrypted state from added is never replayed prematurely', async () => {
  const initial = {
      type: 'reasoning',
      id: 'rs',
      summary: [],
      encrypted_content: 'incomplete-state',
    },
    final = { ...initial, encrypted_content: 'complete-state' };
  const events = await run([created, added(initial), done(final), complete([final])]);
  expect(JSON.stringify(events)).not.toContain(
    Buffer.from('incomplete-state').toString('base64url'),
  );
  expect(assemble(events)).toEqual(toMessage(complete([final]).response, 'exact/model'));
});
