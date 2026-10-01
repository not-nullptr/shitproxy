import { describe, it, expect } from 'vitest';
import { repairAnswerPrefix } from '../src/answer-prefix.js';
import type { JsonObject } from '../src/protocol.js';
const start = (index: number, type: string, extra = {}) => ({
  type: 'content_block_start',
  index,
  content_block: {
    type,
    ...(type === 'text'
      ? { text: '' }
      : type === 'thinking'
        ? { thinking: '', signature: '' }
        : {}),
    ...extra,
  },
});
const delta = (index: number, type: string, text: string) => ({
  type: 'content_block_delta',
  index,
  delta: {
    type,
    ...(type === 'text_delta'
      ? { text }
      : type === 'signature_delta'
        ? { signature: text }
        : { thinking: text }),
  },
});
const stop = (index: number) => ({ type: 'content_block_stop', index });
const end = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
const thought = (i: number, text = 'reason') => [
  start(i, 'thinking'),
  delta(i, 'thinking_delta', text),
  delta(i, 'signature_delta', 'opaque-preserved'),
  stop(i),
];
const text = (i: number, s: string) => [start(i, 'text'), delta(i, 'text_delta', s), stop(i)];
async function* source(events: JsonObject[]) {
  yield* events;
}
async function collect(events: AsyncIterable<JsonObject>) {
  const out: JsonObject[] = [];
  for await (const e of events) out.push(e);
  return out;
}
function blocks(events: JsonObject[]) {
  const out: any[] = [];
  let active: unknown;
  for (const e of events) {
    const i = e.index as number;
    if (e.type === 'content_block_start') {
      expect(active).toBeUndefined();
      active = i;
      expect(i).toBe(out.length);
      out.push(structuredClone(e.content_block));
    }
    if (e.type === 'content_block_delta') {
      expect(i).toBe(active);
      const d = e.delta as any;
      if (d.type === 'text_delta') out[i].text += d.text;
      if (d.type === 'thinking_delta') out[i].thinking += d.thinking;
      if (d.type === 'signature_delta') out[i].signature += d.signature;
    }
    if (e.type === 'content_block_stop') {
      expect(i).toBe(active);
      active = undefined;
    }
  }
  expect(active).toBeUndefined();
  return out;
}
const run = (e: JsonObject[]) => collect(repairAnswerPrefix(source(e)));
describe('bounded answer prefix repair', () => {
  it.each(Array.from({ length: 16 }, (_, n) => n))(
    'repairs a %i character opening fragment',
    async (n) => {
      const out = blocks(
        await run([
          ...thought(0),
          ...text(1, 'x'.repeat(n)),
          ...thought(2, 'tail'),
          ...text(3, ' rest of the answer'),
          end,
        ]),
      );
      expect(out.map((b) => b.type)).toEqual(['thinking', 'thinking', 'text']);
      expect(out[2].text).toBe('x'.repeat(n) + ' rest of the answer');
      expect(out[0].signature).toBe('opaque-preserved');
      expect(out[1].signature).toBe('opaque-preserved');
    },
  );
  it.each([16, 17, 100])('releases %i characters and keeps later reasoning in order', async (n) => {
    const out = blocks(
      await run([
        ...thought(0),
        ...text(1, 'x'.repeat(n)),
        ...thought(2),
        ...text(3, 'remaining'),
        end,
      ]),
    );
    expect(out.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking', 'text']);
  });
  it('does not delay or merge ordinary text without reasoning', async () => {
    const input = [...text(0, 'a'), ...text(1, 'b'), end];
    expect(await run(input)).toEqual(input);
  });
  it('counts Unicode code points without cutting surrogate pairs', async () => {
    const out = blocks(
      await run([
        ...thought(0),
        ...text(1, '😀'.repeat(15)),
        ...thought(2),
        ...text(3, 'done'),
        end,
      ]),
    );
    expect(out.length).toBe(3);
    expect(out[2].text).toBe('😀'.repeat(15) + 'done');
  });
  it('holds multiple small answer items and multiple trailing reasoning items', async () => {
    const out = blocks(
      await run([
        ...thought(0),
        ...text(1, 'Yes'),
        ...thought(2),
        ...text(3, ' — it'),
        ...thought(4),
        ...text(5, ' works normally now'),
        end,
      ]),
    );
    expect(out.map((b) => b.type)).toEqual(['thinking', 'thinking', 'thinking', 'text']);
    expect(out[3].text).toBe('Yes — it works normally now');
  });
  it('flushes before tool calls and repairs a new span after the tool', async () => {
    const out = blocks(
      await run([
        ...thought(0),
        ...text(1, 'a'),
        start(2, 'tool_use', { id: 'call', name: 'tool', input: {} }),
        stop(2),
        ...thought(3),
        ...text(4, 'b'),
        ...thought(5),
        ...text(6, 'c'),
        end,
      ]),
    );
    expect(out.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'tool_use',
      'thinking',
      'thinking',
      'text',
    ]);
    expect(out[5].text).toBe('bc');
  });
  it('flushes phase metadata without merging its associated text', async () => {
    const carrier = { data: 'spx:message:v1:test' };
    const out = blocks(
      await run([
        ...thought(0),
        ...text(1, 'a'),
        start(2, 'redacted_thinking', carrier),
        stop(2),
        ...thought(3),
        ...text(4, 'b'),
        end,
      ]),
    );
    expect(out.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'redacted_thinking',
      'thinking',
      'text',
    ]);
    expect(out[2].data).toBe(carrier.data);
  });
  it('preserves encrypted-only reasoning carriers', async () => {
    const out = blocks(
      await run([
        start(0, 'redacted_thinking', { data: 'encrypted-state' }),
        stop(0),
        ...text(1, 'Yes'),
        start(2, 'redacted_thinking', { data: 'more-state' }),
        stop(2),
        ...text(3, ' indeed'),
        end,
      ]),
    );
    expect(out.map((b) => b.type)).toEqual(['redacted_thinking', 'redacted_thinking', 'text']);
    expect(out[0].data).toBe('encrypted-state');
  });
  it('flushes short answers on completion, not after the timeout', async () => {
    expect(blocks(await run([...thought(0), ...text(1, 'OK'), end]))[1].text).toBe('OK');
  });
  it('releases on timeout even when the upstream next read is pending', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    async function* input() {
      yield* thought(0);
      yield* text(1, 'Yes');
      await gate;
      yield end;
    }
    const iterator = repairAnswerPrefix(input(), 16, 5);
    const events = [];
    while (events.length < 7) events.push((await iterator.next()).value!);
    expect(events[4].type).toBe('content_block_start');
    expect(events[5].delta).toEqual({ type: 'text_delta', text: 'Yes' });
    resolve();
    for await (const e of iterator) events.push(e);
    expect(blocks(events)[1].text).toBe('Yes');
  });
  it('does not open text inside reasoning when the timer expires', async () => {
    async function* input() {
      yield* thought(0);
      yield* text(1, 'Yes');
      yield start(2, 'thinking');
      yield delta(2, 'thinking_delta', 'tail');
      await new Promise((r) => setTimeout(r, 20));
      yield delta(2, 'signature_delta', 'state');
      yield stop(2);
      yield* text(3, ' indeed');
      yield end;
    }
    const out = blocks(await collect(repairAnswerPrefix(input(), 16, 5)));
    expect(out.map((b) => b.type)).toEqual(['thinking', 'thinking', 'text']);
    expect(out[2].text).toBe('Yes indeed');
  });
  it('streams the answer before response completion once the threshold is met', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    async function* input() {
      yield* thought(0);
      yield start(1, 'text');
      yield delta(1, 'text_delta', '1234567890123456');
      await gate;
      yield stop(1);
      yield end;
    }
    const iterator = repairAnswerPrefix(input());
    let e: JsonObject;
    do {
      e = (await iterator.next()).value!;
    } while (e.type !== 'content_block_delta' || (e.delta as any).type !== 'text_delta');
    expect((e.delta as any).text).toHaveLength(16);
    resolve();
    await collect(iterator);
  });
  it('propagates upstream errors without fabricating completion', async () => {
    async function* input() {
      yield* thought(0);
      yield* text(1, 'Yes');
      throw new Error('interrupted');
    }
    await expect(collect(repairAnswerPrefix(input()))).rejects.toThrow('interrupted');
  });
  it('closes repaired text before end of the source', async () => {
    const out = blocks(
      await run([...thought(0), ...text(1, 'Yes'), ...thought(2), ...text(3, ' indeed')]),
    );
    expect(out[2].text).toBe('Yes indeed');
  });
});
