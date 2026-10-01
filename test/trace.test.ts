import { it, expect } from 'vitest';
import { traceShape } from '../src/trace.js';
it('traces text boundaries with bounded previews', () => {
  const shape = traceShape({
    type: 'response.output_text.delta',
    output_index: 1,
    content_index: 0,
    delta: 'x'.repeat(1000),
  });
  expect(shape.delta).toEqual({ length: 1000, preview: 'x'.repeat(80) });
  expect(shape.output_index).toBe(1);
});
it('omits encrypted state, signatures, tool arguments and arbitrary raw fields', () => {
  const secret = 'DO_NOT_EXPOSE';
  for (const event of [
    { type: 'response.function_call_arguments.delta', delta: secret },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: secret } },
    { type: 'content_block_delta', delta: { type: 'signature_delta', signature: secret } },
    {
      type: 'content_block_start',
      content_block: { type: 'redacted_thinking', data: 'spx:message:v1:' + secret },
    },
    {
      type: 'response.completed',
      response: {
        output: [
          { type: 'reasoning', encrypted_content: secret, summary: [] },
          { type: 'function_call', arguments: secret },
        ],
      },
    },
  ])
    expect(
      JSON.stringify(traceShape({ ...event, authorization: secret, request: secret })),
    ).not.toContain(secret);
});
it('identifies message metadata separately from reasoning carriers', () =>
  expect(
    traceShape({
      type: 'content_block_start',
      content_block: { type: 'redacted_thinking', data: 'spx:message:v1:opaque' },
    }).state_carrier,
  ).toBe('message'));
it('summarizes completed mixed output in canonical order', () =>
  expect(
    (
      traceShape({
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
            {
              type: 'message',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'Yes' }],
            },
          ],
        },
      }).output as any[]
    ).map((i) => i.type),
  ).toEqual(['reasoning', 'message']));
