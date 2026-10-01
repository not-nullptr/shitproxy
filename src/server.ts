import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ProtocolError, record } from './protocol.js';
import { toResponses, toMessage } from './translate.js';
import { parseSse, sse, translateStream } from './stream.js';
export type GatewayConfig = {
  upstreamUrl: string;
  upstreamApiKey?: string;
  clientApiKey?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxSseFrameBytes?: number;
  maxStreamBytes?: number;
  fetch?: typeof fetch;
};
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
]);
function upstreamBase(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'UPSTREAM_URL must be an HTTP(S) base URL without credentials, query or fragment',
    );
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : path + '/v1';
  return url;
}
function headers(req: IncomingMessage, config: GatewayConfig, native: boolean): Headers {
  const out = new Headers();
  const excluded = new Set([
    ...HOP,
    ...String(req.headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim()),
    'authorization',
    'x-api-key',
    'cookie',
  ]);
  for (const [key, value] of Object.entries(req.headers)) {
    if (excluded.has(key) || value === undefined || (!native && key.startsWith('anthropic-')))
      continue;
    out.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  if (config.upstreamApiKey) {
    out.set('authorization', `Bearer ${config.upstreamApiKey}`);
    if (native) out.set('x-api-key', config.upstreamApiKey);
  } else {
    const auth = req.headers.authorization;
    const key = req.headers['x-api-key'];
    if (auth) out.set('authorization', auth);
    else if (typeof key === 'string') out.set('authorization', `Bearer ${key}`);
    if (native && typeof key === 'string') out.set('x-api-key', key);
  }
  out.set('accept-encoding', 'identity');
  return out;
}
function authorized(req: IncomingMessage, key: string): boolean {
  const supplied = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '');
  if (typeof supplied !== 'string') return false;
  const left = Buffer.from(supplied),
    right = Buffer.from(key);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function body(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const fail = (err: Error) => {
      cleanup();
      req.pause();
      reject(err);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new ProtocolError('Request body exceeds size limit', 413));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const error = (err: Error) => fail(err);
    const abort = () => fail(new Error('Request aborted'));
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function responseJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new ProtocolError('Empty upstream response', 502, 'api_error');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new ProtocolError('Upstream JSON exceeds size limit', 502, 'api_error');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError('Malformed upstream JSON', 502, 'api_error');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function write(res: ServerResponse, value: string | Uint8Array): Promise<void> {
  if (res.destroyed) throw new Error('Client disconnected');
  if (!res.write(value)) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off('drain', drain);
        res.off('close', close);
        res.off('error', error);
      };
      const drain = () => {
        cleanup();
        resolve();
      };
      const close = () => {
        cleanup();
        reject(new Error('Client disconnected'));
      };
      const error = (e: Error) => {
        cleanup();
        reject(e);
      };
      res.once('drain', drain);
      res.once('close', close);
      res.once('error', error);
    });
  }
}
function errorBody(error: ProtocolError) {
  return { type: 'error', error: { type: error.kind, message: error.message } };
}
export function createGateway(config: GatewayConfig) {
  const base = upstreamBase(config.upstreamUrl);
  const fetcher = config.fetch ?? fetch;
  const limit = config.maxBodyBytes ?? 32 * 1024 * 1024;
  for (const [name, value] of Object.entries({
    timeoutMs: config.timeoutMs ?? 600000,
    maxBodyBytes: limit,
    maxResponseBytes: config.maxResponseBytes ?? 32 * 1024 * 1024,
    maxSseFrameBytes: config.maxSseFrameBytes ?? 8 * 1024 * 1024,
    maxStreamBytes: config.maxStreamBytes ?? 128 * 1024 * 1024,
  }))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
  return createServer(async (req, res) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs ?? 600000);
    timer.unref();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abort);
    req.on('aborted', abort);
    let translatedStream = false;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (config.clientApiKey && !authorized(req, config.clientApiKey))
        throw new ProtocolError('Invalid gateway API key', 401, 'authentication_error');
      const models = url.pathname === '/v1/models' && req.method === 'GET';
      const messages = url.pathname === '/v1/messages' && req.method === 'POST';
      if (!models && !messages)
        throw new ProtocolError('Unsupported endpoint', 404, 'not_found_error');
      let raw: Buffer | undefined,
        request: Record<string, unknown> | undefined,
        native = models;
      if (messages) {
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
          throw new ProtocolError('Compressed request bodies are unsupported', 415);
        raw = await body(req, limit, controller.signal);
        try {
          request = record(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw)));
        } catch {
          throw new ProtocolError('Request body must be a JSON object');
        }
        if (typeof request.model !== 'string' || !request.model.length)
          throw new ProtocolError('model must be a non-empty string');
        let model = request.model;
        // The web client hardcodes this bare ID for its Haiku requests.
        if (model === 'claude-haiku-4-5-20251001') {
          model = 'anthropic/claude-haiku-4-5-20251001';
          request.model = model;
          raw = Buffer.from(JSON.stringify(request), 'utf8');
        }
        native = model.startsWith('anthropic/');
      }
      const translated = messages && !native ? toResponses(request) : undefined;
      const target = new URL(base);
      target.pathname += models ? '/models' : native ? '/messages' : '/responses';
      target.search = url.search;
      const outgoing = headers(req, config, native);
      if (messages) outgoing.set('content-type', 'application/json');
      const upstream = await fetcher(target, {
        method: req.method,
        headers: outgoing,
        ...(messages ? { body: native ? new Uint8Array(raw!) : JSON.stringify(translated) } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (native) {
        const excluded = new Set([
          ...HOP,
          'content-encoding',
          ...String(upstream.headers.get('connection') ?? '')
            .toLowerCase()
            .split(',')
            .map((s) => s.trim()),
        ]);
        upstream.headers.forEach((v, k) => {
          if (!excluded.has(k)) res.setHeader(k, v);
        });
        res.writeHead(upstream.status);
        if (upstream.body) for await (const chunk of upstream.body) await write(res, chunk);
        res.end();
        return;
      }
      if (!upstream.ok) {
        if (upstream.body) await upstream.body.cancel();
        const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        const kind =
          status === 429
            ? 'rate_limit_error'
            : status === 401 || status === 403
              ? 'authentication_error'
              : status < 500
                ? 'invalid_request_error'
                : 'api_error';
        if (upstream.headers.has('retry-after'))
          res.setHeader('retry-after', upstream.headers.get('retry-after')!);
        throw new ProtocolError(`Upstream returned HTTP ${upstream.status}`, status, kind);
      }
      if (translated!.stream) {
        if (
          !upstream.headers.get('content-type')?.includes('text/event-stream') ||
          !upstream.body
        ) {
          await upstream.body?.cancel();
          throw new ProtocolError(
            'Upstream did not return SSE for a streaming request',
            502,
            'api_error',
          );
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        translatedStream = true;
        for await (const event of translateStream(
          parseSse(upstream.body, config.maxSseFrameBytes),
          request!.model as string,
          config.maxStreamBytes,
        ))
          await write(res, sse(event));
        res.end();
      } else {
        const output = toMessage(
          await responseJson(upstream, config.maxResponseBytes ?? 32 * 1024 * 1024),
          request!.model as string,
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(output));
      }
    } catch (e) {
      controller.abort();
      if (res.destroyed) return;
      const error = timedOut
        ? new ProtocolError('Upstream request timed out', 504, 'api_error')
        : e instanceof ProtocolError
          ? e
          : new ProtocolError('Upstream connection failed', 502, 'api_error');
      if (translatedStream) {
        res.end(sse(errorBody(error)));
      } else if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(error.status, {
          'content-type': 'application/json',
          ...(!req.complete ? { connection: 'close' } : {}),
        });
        res.end(JSON.stringify(errorBody(error)));
      }
    } finally {
      clearTimeout(timer);
      res.off('close', abort);
      req.off('aborted', abort);
    }
  });
}
