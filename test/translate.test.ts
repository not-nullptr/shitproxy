import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toResponses, toMessage, outputBlocks, usage } from '../src/translate.js';
import {
  encodeReasoning,
  decodeReasoning,
  reasoningToBlock,
  blockToReasoning,
} from '../src/reasoning.js';
import { parseRequest, type ReasoningItem } from '../src/protocol.js';
const req = (extra: Record<string, unknown> = {}) => ({
  model: 'vendor/exact:model',
  max_tokens: 16000,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});
const response = (output: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id: 'resp_test',
  status: 'completed',
  output,
  usage: { input_tokens: 100, output_tokens: 15, input_tokens_details: { cached_tokens: 40 } },
  ...extra,
});
const msg = (text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = {
  type: 'tool_use',
  id: 'call_1',
  name: 'Task',
  input: { prompt: 'delegate', nested: { args: [1, null, true] } },
};

describe('request golden translation', () => {
  it.each([
    'deepseek/deepseek-flash',
    'deepseek/deepseek-v4-pro',
    'deepseek-flash',
    'deepseek-v4-pro',
  ])('keeps appended budget counters out of the system prefix for %s', (model) => {
    const history = [
      { role: 'user', content: 'long stable context' },
      { role: 'system', content: '# Environment\nStable instructions.' },
      { role: 'assistant', content: [call] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'ok' }] },
    ];
    const first = toResponses(req({ model, messages: history })).input as any[];
    const second = toResponses(
      req({
        model,
        messages: [
          ...history,
          { role: 'system', content: '<total_tokens>14998980 tokens left</total_tokens>' },
        ],
      }),
    ).input as any[];
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: '<total_tokens>14998980 tokens left</total_tokens>' }],
    });
    expect(second.filter((i) => i.role === 'system')).toEqual(
      first.filter((i) => i.role === 'system'),
    );
    const third = toResponses(
      req({
        model,
        messages: [
          ...history,
          {
            role: 'system',
            content: [
              {
                type: 'text',
                text: '<total_tokens>14998980 tokens left</total_tokens>',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      }),
    ).input;
    expect(third).toEqual(second);
  });
  it('does not demote actual instructions or alter other providers', () => {
    for (const [model, content] of [
      ['openai/gpt-5', '<total_tokens>100 tokens left</total_tokens>'],
      ['custom/exact', '<total_tokens>100 tokens left</total_tokens>'],
      ['deepseek/deepseek-flash', '# Environment\n<total_tokens>100 tokens left</total_tokens>'],
      [
        'deepseek/deepseek-flash',
        '<total_tokens>100 tokens left</total_tokens>\nImportant instruction',
      ],
    ]) {
      const input = toResponses(req({ model, messages: [{ role: 'system', content }] }))
        .input as any[];
      expect(input[0].role).toBe('system');
      expect(input[0].content[0].text).toBe(content);
    }
  });
  it('preserves exact model and stateless defaults', () =>
    expect(toResponses(req())).toEqual({
      model: 'vendor/exact:model',
      max_output_tokens: 16000,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      store: false,
      include: ['reasoning.encrypted_content'],
      stream: false,
    }));
  it.each(['gpt-5', 'openai/a:b', 'claude-bare', 'deepseek/test', 'a/🚀', ' anthropic/x'])(
    'never guesses or rewrites %s',
    (model) => expect(toResponses(req({ model })).model).toBe(model),
  );
  it.each([false, true])('stream %s', (stream) =>
    expect(toResponses(req({ stream })).stream).toBe(stream),
  );
  it.each([
    '',
    'sys',
    [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
    ],
  ])('system %j', (system) =>
    expect((toResponses(req({ system })).input as any[])[0]).toEqual({
      role: 'system',
      content: [{ type: 'input_text', text: typeof system === 'string' ? system : 'a\nb' }],
    }),
  );
  it('keeps text/call/text/result order', () =>
    expect(
      (
        toResponses(
          req({
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'first' }, call, { type: 'text', text: 'after' }],
              },
              {
                role: 'user',
                content: [
                  { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
                  { type: 'text', text: 'next' },
                ],
              },
            ],
          }),
        ).input as any[]
      ).map((i) => i.type ?? i.role),
    ).toEqual(['assistant', 'function_call', 'assistant', 'function_call_output', 'user']));
  it('preserves nested call arguments', () =>
    expect(
      (toResponses(req({ messages: [{ role: 'assistant', content: [call] }] })).input as any[])[0]
        .arguments,
    ).toBe(JSON.stringify(call.input)));
  it.each([
    undefined,
    '',
    'result',
    [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  ])('tool result %j', (content) => {
    const out = toResponses(
      req({
        messages: [
          { role: 'assistant', content: [call] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content }] },
        ],
      }),
    );
    expect((out.input as any[])[1].output).toEqual(
      typeof content === 'string'
        ? content
        : (content ?? []).map((b) => ({ type: 'input_text', text: b.text })),
    );
  });
  it.each(['bad', [{ type: 'text', text: 'bad' }]])('explicit tool error %j', (content) => {
    const out = toResponses(
      req({
        messages: [
          { role: 'assistant', content: [call] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: true, content }],
          },
        ],
      }),
    );
    expect(JSON.stringify(out)).toContain('[tool_error]');
  });
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('base64 %s', (media_type) => {
    const out = toResponses(
      req({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type, data: 'YWJj' } }],
          },
        ],
      }),
    );
    expect((out.input as any[])[0].content[0]).toEqual({
      type: 'input_image',
      image_url: `data:${media_type};base64,YWJj`,
    });
  });
  it('URL images and tool image results', () => {
    const image = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/image?token=x' },
    };
    const out = toResponses(
      req({
        messages: [
          { role: 'user', content: [image] },
          { role: 'assistant', content: [call] },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [image] }],
          },
        ],
      }),
    );
    expect((out.input as any[])[2].output).toEqual([
      { type: 'input_image', image_url: 'https://example.com/image?token=x' },
    ]);
  });
  it('maps schema without strictification', () => {
    const tools = [
      {
        name: 'Task',
        description: 'run subagent',
        input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: [] },
      },
    ];
    expect(toResponses(req({ tools })).tools).toEqual([
      {
        type: 'function',
        name: 'Task',
        description: 'run subagent',
        parameters: tools[0]!.input_schema,
        strict: false,
      },
    ]);
  });
  it.each([
    ['auto', 'auto'],
    ['any', 'required'],
    ['none', 'none'],
    ['tool', { type: 'function', name: 'Task' }],
  ])('tool choice %s', (type, expected) =>
    expect(
      toResponses(
        req({
          tools: [{ name: 'Task', input_schema: { type: 'object' } }],
          tool_choice: { type, ...(type === 'tool' ? { name: 'Task' } : {}) },
        }),
      ).tool_choice,
    ).toEqual(expected),
  );
  it.each([true, false])('parallel choice %s', (disable_parallel_tool_use) =>
    expect(
      toResponses(req({ tool_choice: { type: 'auto', disable_parallel_tool_use } }))
        .parallel_tool_calls,
    ).toBe(!disable_parallel_tool_use),
  );
  it.each([0, 0.2, 1])('sampling %s', (v) => {
    const out = toResponses(req({ temperature: v, top_p: v }));
    expect(out.temperature).toBe(v);
    expect(out.top_p).toBe(v);
  });
  it.each([
    [1024, 'low'],
    [2047, 'low'],
    [2048, 'medium'],
    [8191, 'medium'],
    [8192, 'high'],
  ])('budget %s -> %s', (budget_tokens, effort) =>
    expect(toResponses(req({ thinking: { type: 'enabled', budget_tokens } })).reasoning).toEqual({
      effort,
      summary: 'auto',
    }),
  );
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh'],
  ])('effort %s', (effort, mapped) =>
    expect(
      toResponses(req({ thinking: { type: 'adaptive' }, output_config: { effort } })).reasoning,
    ).toEqual({ effort: mapped, summary: 'auto' }),
  );
  it('adaptive defaults medium', () =>
    expect(toResponses(req({ thinking: { type: 'adaptive' } })).reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    }));
  it('disabled omits reasoning', () =>
    expect(toResponses(req({ thinking: { type: 'disabled' } })).reasoning).toBeUndefined());
  it('metadata uses safety identifier', () =>
    expect(toResponses(req({ metadata: { user_id: 'u123' } })).safety_identifier).toBe('u123'));
  it('json schema output', () =>
    expect(
      toResponses(
        req({
          output_config: {
            format: {
              type: 'json_schema',
              schema: { type: 'object', additionalProperties: false },
            },
          },
        }),
      ).text,
    ).toEqual({
      format: {
        type: 'json_schema',
        name: 'response',
        schema: { type: 'object', additionalProperties: false },
        strict: true,
      },
    }));
  it('parallel subagent results retain independent call IDs', () => {
    const out = toResponses(
      req({
        messages: [
          {
            role: 'assistant',
            content: [call, { ...call, id: 'call_2', input: { prompt: 'other' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_2', content: '2' },
              { type: 'tool_result', tool_use_id: 'call_1', content: '1' },
            ],
          },
        ],
      }),
    );
    expect((out.input as any[]).map((i) => i.call_id)).toEqual([
      'call_1',
      'call_2',
      'call_2',
      'call_1',
    ]);
  });
});
describe('fail explicit on invalid or unsupported inputs', () => {
  it.each([
    { model: '' },
    { model: 1 },
    { max_tokens: 0 },
    { max_tokens: -1 },
    { max_tokens: 1.5 },
    { max_tokens: '1' },
    { messages: [] },
    { messages: null },
    { stream: 'true' },
    { temperature: -1 },
    { temperature: 1.1 },
    { top_p: 2 },
    { tools: [{ type: 'web_search_20250305', name: 'search' }] },
    { messages: [{ role: 'unknown', content: 'x' }] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', citations: [] }] }] },
    {
      messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'x', name: 'f', input: {} }] }],
    },
    {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'x' }] },
      ],
    },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'x' }] }] },
    {
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'foreign' }] },
      ],
    },
    {
      messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'foreign' }] }],
    },
    { messages: [{ role: 'assistant', content: [call, call] }] },
    {
      messages: [
        { role: 'assistant', content: [call] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1' },
            { type: 'tool_result', tool_use_id: 'call_1' },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a' } }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'file:///etc/passwd' } }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'text/plain', data: 'YWJj' } },
          ],
        },
      ],
    },
    { thinking: { type: 'enabled', budget_tokens: 16000 } },
    { thinking: { type: 'enabled', budget_tokens: 0 } },
    { thinking: { type: 'disabled' }, output_config: { effort: 'high' } },
    { top_k: 0 },
    { stop_sequences: ['END'] },
    { output_config: { format: { type: 'text' } } },
    { output_config: { format: { type: 'json_schema' } } },
    {
      tools: [
        { name: 'f', input_schema: {} },
        { name: 'f', input_schema: {} },
      ],
    },
    { tool_choice: { type: 'any' } },
    { tool_choice: { type: 'tool', name: 'missing' }, tools: [{ name: 'f', input_schema: {} }] },
    { unknown: true },
    { service_tier: 'auto' },
  ])('rejects %j', (extra) => expect(() => toResponses(req(extra))).toThrow());
  it.each([null, [], false, 'x', 1])('rejects nonobjects %j', (v) =>
    expect(() => parseRequest(v)).toThrow(),
  );
  it('empty stop sequences are harmless', () =>
    expect(() => toResponses(req({ stop_sequences: [] }))).not.toThrow());
});
describe('reasoning lossless replay', () => {
  const items: ReasoningItem[] = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque+/==🚀' },
    {
      type: 'reasoning',
      id: 'rs_2',
      summary: [{ type: 'summary_text', text: 'visible' }],
      encrypted_content: 'encrypted',
    },
    {
      type: 'reasoning',
      id: 'rs_3',
      summary: [
        { type: 'summary_text', text: 'one' },
        { type: 'summary_text', text: 'two' },
      ],
    },
    { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'plaintext' }] },
    {
      type: 'reasoning',
      id: 'rs_empty',
      summary: [],
      encrypted_content: null,
      status: 'completed',
    },
    {
      type: 'reasoning',
      id: 'rs_both',
      summary: [{ type: 'summary_text', text: 'summary' }],
      content: [{ type: 'reasoning_text', text: 'raw' }],
      encrypted_content: 'state',
    },
  ];
  it.each(items)('round trip %j', (item) => {
    expect(decodeReasoning(encodeReasoning(item))).toEqual(item);
    expect(blockToReasoning(reasoningToBlock(item) as any)).toEqual(item);
  });
  it.each(items)('full response/request loop %j', (item) => {
    const message = toMessage(
      response([
        item,
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Task', arguments: '{}' },
      ]),
      'custom/model',
    );
    const out = toResponses(
      req({
        messages: [
          { role: 'assistant', content: message.content },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
          },
        ],
      }),
    );
    expect((out.input as any[])[0]).toEqual(item);
  });
  it('unsigned plaintext summaries preserved', () =>
    expect(blockToReasoning({ type: 'thinking', thinking: 'plain' })).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'plain' }],
    }));
  it('rejects modified visible reasoning', () => {
    const block = reasoningToBlock(items[1]!) as any;
    expect(() => blockToReasoning({ ...block, thinking: 'tampered' })).toThrow(/modified/);
  });
  it.each([
    '',
    'foreign',
    'spx:reasoning:v2:aaaa',
    'spx:reasoning:v1:',
    'spx:reasoning:v1:!!!!',
    'spx:reasoning:v1:YWJj',
    'spx:reasoning:v1:eyJ0eXBlIjoidGV4dCJ9',
  ])('rejects envelope %s', (v) => expect(() => decodeReasoning(v)).toThrow());
  it('rejects invalid upstream reasoning schema', () =>
    expect(() =>
      encodeReasoning({ type: 'reasoning', summary: [], encrypted_content: 123 } as any),
    ).toThrow());
  it('rejects unknown envelope fields', () =>
    expect(() =>
      decodeReasoning(
        'spx:reasoning:v1:' +
          Buffer.from(JSON.stringify({ type: 'reasoning', summary: [], evil: 1 })).toString(
            'base64url',
          ),
      ),
    ).toThrow());
  it('unicode arbitrary reasoning round trip (500 examples)', () =>
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme' }),
        fc.string({ unit: 'grapheme' }),
        fc.array(fc.string({ unit: 'grapheme' }), { maxLength: 5 }),
        (id, encrypted, texts) => {
          const item: ReasoningItem = {
            type: 'reasoning',
            id: 'rs_' + id,
            encrypted_content: encrypted,
            summary: texts.map((text) => ({ type: 'summary_text', text })),
          };
          expect(blockToReasoning(reasoningToBlock(item) as any)).toEqual(item);
        },
      ),
      { numRuns: 500, seed: 1042 },
    ));
  it('100-turn stateless tool loop retains all reasoning IDs', () => {
    const messages: any[] = [{ role: 'user', content: 'start' }];
    for (let n = 0; n < 100; n++) {
      const item: ReasoningItem = {
        type: 'reasoning',
        id: `rs_${n}`,
        summary: [{ type: 'summary_text', text: `step ${n}` }],
        encrypted_content: `cipher_${n}`,
      };
      const out = toMessage(
        response([
          item,
          {
            type: 'function_call',
            call_id: `call_${n}`,
            name: 'Task',
            arguments: '{"n":' + n + '}',
          },
        ]),
        'model',
      );
      messages.push(
        { role: 'assistant', content: out.content },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `call_${n}`, content: `result ${n}` }],
        },
      );
      const input = toResponses(req({ messages })).input as any[];
      expect(input.filter((i) => i.type === 'reasoning').map((i) => i.id)).toEqual(
        Array.from({ length: n + 1 }, (_, i) => `rs_${i}`),
      );
    }
  });
});
describe('response translation', () => {
  it('golden response', () =>
    expect(toMessage(response([msg('hello')]), 'exact')).toEqual({
      id: 'resp_test',
      type: 'message',
      role: 'assistant',
      model: 'exact',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 60,
        output_tokens: 15,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 0,
      },
    }));
  it('empty output', () => expect(toMessage(response(), 'm').content).toEqual([]));
  it('tool call stop', () =>
    expect(
      toMessage(
        response([{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }]),
        'm',
      ).stop_reason,
    ).toBe('tool_use'));
  it.each([
    ['max_output_tokens', 'max_tokens'],
    ['content_filter', 'refusal'],
  ])('incomplete %s', (reason, stop) =>
    expect(
      toMessage(response([], { status: 'incomplete', incomplete_details: { reason } }), 'm')
        .stop_reason,
    ).toBe(stop),
  );
  it('incomplete overrides tool stop', () =>
    expect(
      toMessage(
        response([{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }], {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
        'm',
      ).stop_reason,
    ).toBe('max_tokens'));
  it('refusal blocks', () =>
    expect(
      toMessage(
        response([
          { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
        ]),
        'm',
      ),
    ).toMatchObject({ stop_reason: 'refusal', content: [{ type: 'text', text: 'no' }] }));
  it.each(['failed', 'in_progress', 'queued', 'cancelled', 'unknown'])(
    'rejects status %s',
    (status) => expect(() => toMessage(response([], { status }), 'm')).toThrow(),
  );
  it.each([
    null,
    {},
    [],
    { status: 'completed', output: [] },
    { id: 'x', status: 'completed', output: null },
    { id: 'x', status: 'incomplete', output: [], incomplete_details: { reason: 'other' } },
    { id: 'x', status: 'completed', output: [], error: { message: 'bad' } },
  ])('rejects response %j', (v) => expect(() => toMessage(v, 'm')).toThrow());
  it.each([
    null,
    [],
    { type: 'unknown' },
    { type: 'message', role: 'user', content: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_image' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 123 }] },
    { type: 'reasoning', summary: 'no' },
    { type: 'function_call', call_id: 'x', name: 'f', arguments: '{broken' },
    { type: 'function_call', call_id: 'x', name: 'f', arguments: '[]' },
    { type: 'function_call', call_id: 'x', name: 'f', arguments: 'null' },
    { type: 'function_call', call_id: 'x', name: 'f', arguments: '"a"' },
  ])('rejects output item %j', (v) => expect(() => outputBlocks(v)).toThrow());
  it('missing usage defaults zero', () =>
    expect(usage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 }));
  it.each([-1, 1.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects token count %s',
    (v) => expect(() => usage({ input_tokens: v })).toThrow(),
  );
  it('rejects cached count above total', () =>
    expect(() => usage({ input_tokens: 5, input_tokens_details: { cached_tokens: 6 } })).toThrow());
  it('arbitrary tool JSON round trip (500 examples)', () =>
    fc.assert(
      fc.property(fc.dictionary(fc.string({ unit: 'grapheme' }), fc.jsonValue()), (input) => {
        const out = outputBlocks({
          type: 'function_call',
          call_id: 'c',
          name: 'f',
          arguments: JSON.stringify(input),
        })[0];
        expect((out as any).input).toEqual(input);
      }),
      { numRuns: 500, seed: 700 },
    ));
});

it('empty summary text round trips as signed thinking', () => {
  const item: ReasoningItem = {
    type: 'reasoning',
    id: 'rs_empty_text',
    summary: [{ type: 'summary_text', text: '' }],
    encrypted_content: 'cipher',
  };
  const block = reasoningToBlock(item);
  expect(block.type).toBe('thinking');
  expect(blockToReasoning(block as any)).toEqual(item);
});
it('empty signature is treated as unsigned plaintext', () =>
  expect(blockToReasoning({ type: 'thinking', thinking: 'plain', signature: '' })).toEqual({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'plain' }],
  }));
it('noncanonical base64 encoding rejected', () =>
  expect(() => decodeReasoning('spx:reasoning:v1:Zh')).toThrow(/Malformed/));
it('invalid UTF8 envelope rejected', () =>
  expect(() =>
    decodeReasoning('spx:reasoning:v1:' + Buffer.from([255]).toString('base64url')),
  ).toThrow(/Malformed/));

describe('web client instruction roles', () => {
  it.each(['system', 'developer'] as const)(
    'preserves %s text messages and history order',
    (role) => {
      const translated = toResponses(
        req({
          system: 'top-level instructions',
          messages: [
            { role: 'user', content: 'hello' },
            {
              role,
              content: [
                { type: 'text', text: 'instruction one' },
                { type: 'text', text: 'instruction two' },
              ],
            },
            { role: 'assistant', content: 'answer' },
          ],
        }),
      );
      expect(translated.input).toEqual([
        { role: 'system', content: [{ type: 'input_text', text: 'top-level instructions' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          role,
          content: [
            { type: 'input_text', text: 'instruction one' },
            { type: 'input_text', text: 'instruction two' },
          ],
        },
        { role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
      ]);
    },
  );
  it.each(['system', 'developer'])('accepts %s string content', (role) => {
    expect(toResponses(req({ messages: [{ role, content: 'instructions' }] })).input).toEqual([
      { role, content: [{ type: 'input_text', text: 'instructions' }] },
    ]);
  });
  it.each(['system', 'developer'])('rejects non-text %s images', (role) => {
    expect(() =>
      toResponses(
        req({
          messages: [
            {
              role,
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/user role/);
  });
  it.each(['system', 'developer'])('rejects %s tool calls and reasoning', (role) => {
    for (const block of [call, { type: 'thinking', thinking: 'x' }])
      expect(() => toResponses(req({ messages: [{ role, content: [block] }] }))).toThrow();
  });
  it.each(['tool', 'model', 'human', 'function'])('reports actual unsupported role %s', (role) => {
    expect(() =>
      toResponses(
        req({
          messages: [
            { role: 'user', content: 'secret prompt' },
            { role, content: 'secret second prompt' },
          ],
        }),
      ),
    ).toThrow(`messages.1.role: unsupported role "${role}"`);
  });
});
