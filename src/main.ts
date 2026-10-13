import { createGateway, type UpstreamKeyResolution } from './server.js';

/**
 * Build the per-request upstream-key resolver from `UPSTREAM_KEY_RESOLVER_URL`.
 * The URL is an internal service that takes the caller's key on `X-Gateway-Key`
 * (with `GATEWAY_RESOLVER_SECRET` on `X-Gateway-Secret`) and answers:
 *
 *   200 {"upstream_api_key": "..."} — this caller's own key; use it.
 *   403                             — a known caller with no usable key; refuse
 *                                     (401 downstream), never the shared key.
 *   anything else                   — 404 unknown caller, 401 bad secret, 5xx,
 *                                     or a transport failure: `fallback`, i.e.
 *                                     the static `UPSTREAM_API_KEY` / ingress
 *                                     gate, exactly as with no resolver. This
 *                                     keeps other deployments on the same
 *                                     gateway working, and keeps it serving
 *                                     during a resolver outage.
 */
function makeResolver(url: string, secret?: string) {
  return async (key: string): Promise<UpstreamKeyResolution> => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-gateway-key': key,
          ...(secret ? { 'x-gateway-secret': secret } : {}),
        },
      });
      if (response.status === 403) return { action: 'refuse' };
      if (response.status !== 200) return { action: 'fallback' };
      const body: unknown = await response.json();
      const value = (body as { upstream_api_key?: unknown } | null)?.upstream_api_key;
      return typeof value === 'string' && value.length
        ? { action: 'use', upstreamKey: value }
        : { action: 'fallback' };
    } catch {
      return { action: 'fallback' };
    }
  };
}

const upstreamUrl = process.env.UPSTREAM_URL;
if (!upstreamUrl) throw new Error('Set UPSTREAM_URL to your router base URL (with or without /v1)');
const host = process.env.HOST ?? '127.0.0.1';
const resolverUrl = process.env.UPSTREAM_KEY_RESOLVER_URL;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  !process.env.GATEWAY_API_KEY &&
  !resolverUrl
)
  throw new Error(
    'Set GATEWAY_API_KEY (or UPSTREAM_KEY_RESOLVER_URL) when binding to a non-loopback address',
  );
function positive(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}
const port = positive('PORT', 4000);
if (port > 65535) throw new Error('PORT must be below 65536');
const server = createGateway({
  upstreamUrl,
  upstreamApiKey: process.env.UPSTREAM_API_KEY,
  clientApiKey: process.env.GATEWAY_API_KEY,
  timeoutMs: positive('UPSTREAM_TIMEOUT_MS', 600000),
  maxBodyBytes: positive('MAX_BODY_BYTES', 33554432),
  kagiSession: process.env.KAGI_SESSION,
  kagiTurnstile: process.env.KAGI_TURNSTILE,
  debugStream: process.env.DEBUG_STREAM === '1',
  debugCache: process.env.DEBUG_CACHE === '1',
  debugErrors: process.env.DEBUG_ERRORS === '1',
  resolveUpstreamKey: resolverUrl
    ? makeResolver(resolverUrl, process.env.GATEWAY_RESOLVER_SECRET)
    : undefined,
});
server.listen(port, host, () => console.log(`Gateway listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
    const deadline = setTimeout(() => {
      server.closeAllConnections();
    }, 10000);
    deadline.unref();
  });
