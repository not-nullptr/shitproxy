import { it, expect } from 'vitest';
import fc from 'fast-check';
import { toResponses, toMessage, outputBlocks } from '../src/translate.js';
import { messageEnvelope, replayMessage, hasMessageEnvelope } from '../src/message-state.js';
const message = (phase: unknown = 'commentary') => ({
  type: 'message',
  id: 'msg_phase',
  role: 'assistant',
  status: 'completed',
  phase,
  content: [{ type: 'output_text', text: 'Working 🌎', annotations: [] }],
});
const response = (item: unknown) => ({ id: 'resp', status: 'completed', output: [item] });
it.each(['commentary', 'final_answer', null])(
  'phase %s preserved through request/response replay',
  (phase) => {
    const item = message(phase);
    const converted = toMessage(response(item), 'model');
    const input = toResponses({
      model: 'model',
      max_tokens: 100,
      messages: [
        { role: 'assistant', content: converted.content },
        { role: 'user', content: 'continue' },
      ],
    }).input as any[];
    expect(input[0]).toEqual(item);
    expect(input).toHaveLength(2);
  },
);
it('phase metadata follows visible text', () => {
  const blocks = outputBlocks(message());
  expect(blocks[0]).toEqual({ type: 'text', text: 'Working 🌎' });
  expect(hasMessageEnvelope(blocks[1]!)).toBe(true);
});
it('message metadata is independent of reasoning envelopes', () =>
  expect(hasMessageEnvelope({ type: 'redacted_thinking', data: 'spx:reasoning:v1:x' })).toBe(
    false,
  ));
it('modified assistant text rejected', () => {
  const blocks = outputBlocks(message());
  blocks[0] = { type: 'text', text: 'changed' };
  expect(() =>
    toResponses({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'assistant', content: blocks }],
    }),
  ).toThrow(/modified/);
});
it('message metadata in user content rejected', () =>
  expect(() =>
    toResponses({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: outputBlocks(message()) }],
    }),
  ).toThrow(/assistant role/));
it('message metadata with missing text rejected', () =>
  expect(() =>
    toResponses({
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'assistant', content: [messageEnvelope(message())] }],
    }),
  ).toThrow(/modified/));
it('multiple phases in one Anthropic turn preserve separate items', () => {
  const a = message('commentary'),
    b = {
      ...message('final_answer'),
      id: 'msg_final',
      content: [{ type: 'output_text', text: 'done', annotations: [] }],
    };
  const input = toResponses({
    model: 'm',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: [...outputBlocks(a), ...outputBlocks(b)] }],
  }).input;
  expect(input).toEqual([a, b]);
});
it('refusal with phase retains refusal on replay', () => {
  const item = { ...message('final_answer'), content: [{ type: 'refusal', refusal: 'no' }] };
  const input = toResponses({
    model: 'm',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: outputBlocks(item) }],
  }).input;
  expect(input).toEqual([item]);
});
it('unknown upstream phase rejected', () =>
  expect(() => outputBlocks(message('other'))).toThrow(/metadata/));
it.each([
  '',
  'spx:message:v2:abc',
  'spx:message:v1:',
  'spx:message:v1:!!!!',
  'spx:message:v1:Zh',
  'spx:message:v1:YWJj',
  'spx:message:v1:_w',
])('bad metadata envelope %s', (data) => expect(() => replayMessage(data)).toThrow());
it.each([
  null,
  {},
  { ...message(), phase: undefined },
  { ...message(), id: '' },
  { ...message(), role: 'user' },
  { ...message(), extra: true },
])('invalid message metadata %j', (v) => expect(() => messageEnvelope(v)).toThrow());
it.each([{}, [{ type: 'url_citation', url: 'https://example.com' }]])(
  'annotations do not disappear silently %j',
  (annotations) =>
    expect(() =>
      outputBlocks({ ...message(), content: [{ type: 'output_text', text: 'x', annotations }] }),
    ).toThrow(/annotations/),
);
it('phase and arbitrary Unicode round trips (100 examples)', () =>
  fc.assert(
    fc.property(
      fc.string({ unit: 'grapheme' }),
      fc.constantFrom('commentary', 'final_answer', null),
      (text, phase) => {
        const item = {
          ...message(phase),
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        const input = toResponses({
          model: 'm',
          max_tokens: 100,
          messages: [{ role: 'assistant', content: outputBlocks(item) }],
        }).input;
        expect(input).toEqual([item]);
      },
    ),
    { numRuns: 100, seed: 844 },
  ));
