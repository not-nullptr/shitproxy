import { createHmac, randomBytes } from 'node:crypto';
import type { JsonObject } from './protocol.js';

// Process-local keyed fingerprints allow comparisons without retaining prompts or
// making low-entropy text/credentials recoverable by hashing guesses offline.
// These are structural diagnostics, not provider token counts or cache keys.
export function createCacheTrace() {
  const key = randomBytes(32);
  const digest = (value: unknown) =>
    createHmac('sha256', key)
      .update(JSON.stringify(value) ?? 'undefined')
      .digest('hex');
  const shape = (value: unknown) => ({
    digest: digest(value),
    chars: (JSON.stringify(value) ?? '').length,
  });
  const list = (value: unknown) => {
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return {
      ...shape(entries),
      count: entries.length,
      // Bound log volume even for unusually large conversation histories.
      items: entries.slice(0, 512).map(shape),
      truncated: entries.length > 512,
    };
  };
  return {
    request(request: JsonObject, translated: JsonObject, session: unknown, caller: unknown) {
      const { input, tools, ...parameters } = translated;
      return {
        type: 'cache_request',
        // Missing session IDs are explicit: concurrent requests in that group
        // cannot be assumed to belong to the same conversation.
        session: session === undefined ? null : digest([caller, session, request.model]),
        model: digest(request.model),
        raw_system: list(request.system),
        raw_tools: list(request.tools),
        tools: list(tools),
        input: list(input),
        parameters: shape(parameters),
      };
    },
    usage(value: unknown) {
      const u = value && typeof value === 'object' ? (value as JsonObject) : {};
      const details =
        u.input_tokens_details && typeof u.input_tokens_details === 'object'
          ? (u.input_tokens_details as JsonObject)
          : {};
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      return {
        type: 'cache_usage',
        input_tokens: count(u.input_tokens),
        cached_tokens: count(details.cached_tokens),
        output_tokens: count(u.output_tokens),
      };
    },
  };
}
