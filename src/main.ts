import { createGateway } from './server.js';
const upstreamUrl = process.env.UPSTREAM_URL;
if (!upstreamUrl) throw new Error('Set UPSTREAM_URL to your router base URL (with or without /v1)');
const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.GATEWAY_API_KEY)
  throw new Error('Set GATEWAY_API_KEY when binding to a non-loopback address');
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
