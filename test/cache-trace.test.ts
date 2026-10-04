import { expect, it } from 'vitest';
import { createCacheTrace } from '../src/cache-trace.js';
import { toResponses } from '../src/translate.js';

const request = {
  model: 'deepseek/deepseek-flash',
  max_tokens: 100,
  system: [{ type: 'text', text: 'stable instructions' }],
  tools: [{ name: 'echo', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'private prompt' }],
};

it('locates system changes without confusing append-only tool history with prefix changes', () => {
  const trace = createCacheTrace();
  const first = trace.request(request, toResponses(request), 'session', 'secret');
  const next = {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'echo', input: { value: 'private' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'private result' }],
      },
    ],
  };
  const second = trace.request(next, toResponses(next), 'session', 'secret');
  expect(second.session).toBe(first.session);
  expect(second.tools).toEqual(first.tools);
  expect(second.input.items.slice(0, first.input.count)).toEqual(first.input.items);
  const changed = { ...next, system: [{ type: 'text', text: 'different instructions' }] };
  const third = trace.request(changed, toResponses(changed), 'session', 'secret');
  expect(third.raw_system.digest).not.toBe(second.raw_system.digest);
  expect(third.input.items[0]).not.toEqual(second.input.items[0]);
  expect(third.input.items.slice(1)).toEqual(second.input.items.slice(1));
});

it('excludes raw text, identifiers, credentials and opaque state', () => {
  const trace = createCacheTrace();
  const secret = 'DO_NOT_EXPOSE';
  const result = trace.request(
    { model: secret, system: secret, tools: [secret] },
    { input: [secret], tools: [secret], safety_identifier: secret },
    secret,
    secret,
  );
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(
    trace.usage({ input_tokens: secret, input_tokens_details: { cached_tokens: secret } }),
  ).toEqual({ type: 'cache_usage', input_tokens: null, cached_tokens: null, output_tokens: null });
});

it('isolates callers, sessions and processes and marks missing session identity', () => {
  const trace = createCacheTrace(),
    translated = toResponses(request);
  const a = trace.request(request, translated, 'one', 'key');
  expect(trace.request(request, translated, 'two', 'key').session).not.toBe(a.session);
  expect(trace.request(request, translated, 'one', 'other-key').session).not.toBe(a.session);
  expect(createCacheTrace().request(request, translated, 'one', 'key').input.digest).not.toBe(
    a.input.digest,
  );
  expect(trace.request(request, translated, undefined, undefined).session).toBeNull();
});

it('bounds item logs while fingerprinting the whole history', () => {
  const trace = createCacheTrace();
  const input = Array.from({ length: 513 }, (_, i) => ({ content: String(i) }));
  const a = trace.request({}, { input }, undefined, undefined);
  expect(a.input.count).toBe(513);
  expect(a.input.items).toHaveLength(512);
  expect(a.input.truncated).toBe(true);
  input[512] = { content: 'changed' };
  expect(trace.request({}, { input }, undefined, undefined).input.digest).not.toBe(a.input.digest);
  expect(a.raw_system.count).toBe(0);
});

it('distinguishes real zero usage from missing or invalid upstream fields', () => {
  const trace = createCacheTrace();
  expect(
    trace.usage({
      input_tokens: 100,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 80 },
    }),
  ).toEqual({ type: 'cache_usage', input_tokens: 100, cached_tokens: 80, output_tokens: 0 });
  for (const value of [undefined, null, { input_tokens: -1, output_tokens: 0.5 }])
    expect(trace.usage(value)).toEqual({
      type: 'cache_usage',
      input_tokens: null,
      cached_tokens: null,
      output_tokens: null,
    });
});
