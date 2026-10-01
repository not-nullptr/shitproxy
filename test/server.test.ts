import { describe, it, expect, afterEach } from 'vitest';
import {
  createServer,
  request as httpRequest,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { createGateway, type GatewayConfig } from '../src/server.js';
import { sse } from '../src/stream.js';
const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});
const request = {
  model: 'custom/exact:id',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};
const output = {
  id: 'resp_1',
  status: 'completed',
  output: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};
async function setup(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  extra: Partial<GatewayConfig> = {},
) {
  const upstream = await listen(createServer(handler));
  const base = await listen(
    createGateway({ upstreamUrl: upstream, upstreamApiKey: 'upstream-secret', ...extra }),
  );
  return { base, upstream };
}
async function post(
  base: string,
  payload: unknown = request,
  headers: Record<string, string> = {},
) {
  return fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}
async function read(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
describe('HTTP routing and protocol integration', () => {
  it('routes all non-Anthropic models to Responses with exact ID', async () => {
    let captured: any;
    const { base } = await setup(async (req, res) => {
      captured = { url: req.url, headers: req.headers, body: JSON.parse(await read(req)) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(output));
    });
    const result = await post(base, request, {
      'x-api-key': 'client-secret',
      'anthropic-beta': 'foo',
    });
    expect(result.status).toBe(200);
    expect(((await result.json()) as any).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(captured.url).toBe('/v1/responses');
    expect(captured.body.model).toBe(request.model);
    expect(captured.headers.authorization).toBe('Bearer upstream-secret');
    expect(captured.headers['x-api-key']).toBeUndefined();
    expect(captured.headers['anthropic-beta']).toBeUndefined();
  });
  it('native request bytes and beta headers are preserved', async () => {
    let captured: any;
    const raw =
      '{ "model" : "anthropic/claude-test", "unknown_native_field":true, "messages":[] }\n';
    const { base } = await setup(async (req, res) => {
      captured = { url: req.url, headers: req.headers, raw: await read(req) };
      res.setHeader('content-type', 'application/json');
      res.setHeader('request-id', 'native-id');
      res.end('{"native":true}');
    });
    const result = await post(base, raw, {
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking',
      'x-api-key': 'client-secret',
    });
    expect(await result.text()).toBe('{"native":true}');
    expect(result.headers.get('request-id')).toBe('native-id');
    expect(captured.raw).toBe(raw);
    expect(captured.url).toBe('/v1/messages');
    expect(captured.headers['anthropic-beta']).toBe('interleaved-thinking');
    expect(captured.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured.headers['x-api-key']).toBe('upstream-secret');
  });
  it('native SSE response is passed unchanged', async () => {
    const raw = 'event: message_start\ndata: {"native":true}\n\n: ping\n\n';
    const { base } = await setup((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write(raw.slice(0, 25));
      res.end(raw.slice(25));
    });
    const result = await post(base, { model: 'anthropic/x', stream: true });
    expect(await result.text()).toBe(raw);
  });
  it.each([400, 401, 429, 500])('native HTTP %s passes body and status', async (status) => {
    const { base } = await setup((_req, res) => {
      res.writeHead(status, { 'retry-after': '10' });
      res.end('native error');
    });
    const result = await post(base, { model: 'anthropic/x' });
    expect(result.status).toBe(status);
    expect(await result.text()).toBe('native error');
    expect(result.headers.get('retry-after')).toBe('10');
  });
  it('models body, pagination query, and status pass through', async () => {
    let path = '';
    const raw = ' {"data":[{"id":"custom/exact:id"}]} ';
    const { base } = await setup((req, res) => {
      path = req.url!;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw);
    });
    const result = await fetch(base + '/v1/models?after=abc&limit=7');
    expect(path).toBe('/v1/models?after=abc&limit=7');
    expect(await result.text()).toBe(raw);
  });
  it.each(['/v1', '/v1/', '/router/v1', '/router', '/router/'])(
    'upstream base path %s',
    async (suffix) => {
      let path = '';
      const upstream = await listen(
        createServer((req, res) => {
          path = req.url!;
          res.end(JSON.stringify(output));
        }),
      );
      const base = await listen(createGateway({ upstreamUrl: upstream + suffix }));
      await post(base);
      expect(path).toBe(
        suffix.replace(/\/$/, '') +
          (suffix.replace(/\/$/, '').endsWith('/v1') ? '' : '/v1') +
          '/responses',
      );
    },
  );
  it('client x-api-key forwarded as bearer when upstream key absent', async () => {
    let headers: any;
    const { base } = await setup(
      (req, res) => {
        headers = req.headers;
        res.end(JSON.stringify(output));
      },
      { upstreamApiKey: undefined },
    );
    await post(base, request, { 'x-api-key': 'caller' });
    expect(headers.authorization).toBe('Bearer caller');
  });
  it('client bearer forwarded when upstream key absent', async () => {
    let auth: any;
    const { base } = await setup(
      (req, res) => {
        auth = req.headers.authorization;
        res.end(JSON.stringify(output));
      },
      { upstreamApiKey: undefined },
    );
    await post(base, request, { authorization: 'Bearer caller' });
    expect(auth).toBe('Bearer caller');
  });
  it.each(['x-api-key', 'authorization'])('gateway auth accepts %s', async (name) => {
    const { base } = await setup((_req, res) => res.end(JSON.stringify(output)), {
      clientApiKey: 'gateway',
    });
    const result = await post(base, request, {
      [name]: name === 'authorization' ? 'Bearer gateway' : 'gateway',
    });
    expect(result.status).toBe(200);
  });
  it.each([
    {},
    { 'x-api-key': 'wrong' },
    { 'x-api-key': 'gateway-longer' },
    { authorization: 'Basic gateway' },
  ])('rejects invalid auth %j', async (headers) => {
    let called = false;
    const { base } = await setup(
      () => {
        called = true;
      },
      { clientApiKey: 'gateway' },
    );
    const result = await post(base, request, headers as Record<string, string>);
    expect(result.status).toBe(401);
    expect(called).toBe(false);
  });
  it('health requires no auth and makes no upstream call', async () => {
    const { base } = await setup(
      () => {
        throw new Error('unexpected');
      },
      { clientApiKey: 'gateway' },
    );
    expect(await (await fetch(base + '/healthz')).json()).toEqual({ status: 'ok' });
  });
  it.each(['/v1/messages/count_tokens', '/v1/responses', '/unknown'])(
    'unsupported route %s',
    async (path) => {
      const { base } = await setup(() => {});
      expect((await fetch(base + path)).status).toBe(404);
    },
  );
  it('rejects wrong method', async () => {
    const { base } = await setup(() => {});
    expect((await fetch(base + '/v1/messages')).status).toBe(404);
  });
  it.each(['not-json', 'null', '[]', '{}', '{"model":1}'])(
    'invalid JSON/request %s',
    async (raw) => {
      const { base } = await setup(() => {});
      expect((await post(base, raw)).status).toBe(400);
    },
  );
  it('rejects compressed bodies', async () => {
    const { base } = await setup(() => {});
    expect((await post(base, request, { 'content-encoding': 'gzip' })).status).toBe(415);
  });
  it('rejects unsupported translation before calling upstream', async () => {
    let called = false;
    const { base } = await setup(() => {
      called = true;
    });
    expect((await post(base, { ...request, stop_sequences: ['STOP'] })).status).toBe(400);
    expect(called).toBe(false);
  });
  it('rejects oversized bodies', async () => {
    const { base } = await setup(() => {}, { maxBodyBytes: 20 });
    expect((await post(base)).status).toBe(413);
  });
  it.each([400, 401, 403, 429, 500, 503])('translated HTTP error %s', async (status) => {
    const { base } = await setup((_req, res) => {
      res.writeHead(status, { 'retry-after': '4' });
      res.end('sensitive upstream detail');
    });
    const result = await post(base);
    expect(result.status).toBe(status);
    const error = await result.text();
    expect(error).not.toContain('sensitive');
    expect(error).toContain('/v1/responses');
    expect(error).toContain(request.model);
    expect(result.headers.get('retry-after')).toBe('4');
  });
  it('redirects are not followed or leaked credentials', async () => {
    let followed = false;
    const target = await listen(
      createServer((_req, res) => {
        followed = true;
        res.end();
      }),
    );
    const { base } = await setup((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    expect((await post(base)).status).toBe(502);
    expect(followed).toBe(false);
  });
  it.each(['invalid', '[]', '{"status":"completed"}'])(
    'malformed upstream JSON %s',
    async (body) => {
      const { base } = await setup((_req, res) => res.end(body));
      expect((await post(base)).status).toBe(502);
    },
  );
  it('upstream JSON size limit', async () => {
    const { base } = await setup((_req, res) => res.end(JSON.stringify(output)), {
      maxResponseBytes: 10,
    });
    expect((await post(base)).status).toBe(502);
  });
  it('timeout returns 504', async () => {
    const { base } = await setup(() => {}, { timeoutMs: 30 });
    expect((await post(base)).status).toBe(504);
  });
  it('connection failure returns 502', async () => {
    const server = createServer();
    const dead = await listen(server);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const base = await listen(createGateway({ upstreamUrl: dead }));
    expect((await post(base)).status).toBe(502);
  });
  it('stream translates across network chunks', async () => {
    const { base } = await setup(async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      const item = output.output[0]!;
      const events = [
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: 'o',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: output },
      ];
      for (const event of events) {
        const bytes = Buffer.from(sse(event));
        for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
      }
      res.end();
    });
    const result = await post(base, { ...request, stream: true });
    expect(result.headers.get('content-type')).toContain('text/event-stream');
    const raw = await result.text();
    expect(raw).toContain('event: message_start');
    expect(raw).toContain('event: message_stop');
    expect(raw).toContain('"text":"o"');
    expect(raw).toContain('"text":"k"');
  });
  it('broken SSE emits error without message_stop', async () => {
    const { base } = await setup((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse({ type: 'response.created', response: { id: 'r' } }));
    });
    const result = await post(base, { ...request, stream: true });
    const raw = await result.text();
    expect(raw).toContain('event: error');
    expect(raw).not.toContain('event: message_stop');
  });
  it('oversized SSE emits error without message_stop', async () => {
    const { base } = await setup(
      (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: ' + 'x'.repeat(100) + '\n\n');
      },
      { maxSseFrameBytes: 10 },
    );
    const result = await post(base, { ...request, stream: true });
    expect(await result.text()).toContain('event: error');
  });
  it('timeout during SSE emits error', async () => {
    const { base } = await setup(
      (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.write(sse({ type: 'response.created', response: { id: 'r' } }));
      },
      { timeoutMs: 80 },
    );
    const raw = await (await post(base, { ...request, stream: true })).text();
    expect(raw).toContain('timed out');
    expect(raw).not.toContain('message_stop');
  });
  it('JSON response to streaming request rejected', async () => {
    const { base } = await setup((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(output));
    });
    expect((await post(base, { ...request, stream: true })).status).toBe(502);
  });
  it('client disconnect aborts upstream stream', async () => {
    let closed!: () => void;
    const closePromise = new Promise<void>((resolve) => (closed = resolve));
    const { base } = await setup((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write(sse({ type: 'response.created', response: { id: 'r' } }));
      res.on('close', closed);
    });
    const abort = new AbortController();
    const result = await fetch(base + '/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ ...request, stream: true }),
      signal: abort.signal,
    });
    const reader = result.body!.getReader();
    await reader.read();
    abort.abort();
    await closePromise;
    await reader.cancel().catch(() => {});
  });
  it('connection-nominated headers and cookies are not forwarded', async () => {
    let headers: any;
    const { base } = await setup((req, res) => {
      headers = req.headers;
      res.end(JSON.stringify(output));
    });
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(
        base + '/v1/messages',
        {
          method: 'POST',
          headers: { connection: 'x-private', 'x-private': 'secret', cookie: 'session=secret' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      client.on('error', reject);
      client.end(JSON.stringify(request));
    });
    expect(headers['x-private']).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });
  it.each([
    'ftp://example.com',
    'https://u:p@example.com',
    'https://example.com?key=1',
    'https://example.com#frag',
  ])('invalid upstream URL %s', (url) =>
    expect(() => createGateway({ upstreamUrl: url })).toThrow(),
  );
  it.each([0, -1, 1.1, NaN])('invalid timeout %s', (timeoutMs) =>
    expect(() => createGateway({ upstreamUrl: 'http://localhost', timeoutMs })).toThrow(),
  );
});

describe('HTTP backpressure and stream budgets', () => {
  it('slow reader receives a large native response intact', async () => {
    const bytes = 'x'.repeat(4 * 1024 * 1024);
    const { base } = await setup((_req, res) => res.end(bytes));
    const result = await new Promise<string>((resolve, reject) => {
      const client = httpRequest(base + '/v1/messages', { method: 'POST' }, (res) => {
        const parts: Buffer[] = [];
        res.pause();
        setTimeout(() => res.resume(), 30);
        res.on('data', (b) => parts.push(b));
        res.on('end', () => resolve(Buffer.concat(parts).toString()));
        res.on('error', reject);
      });
      client.on('error', reject);
      client.end(JSON.stringify({ model: 'anthropic/x' }));
    });
    expect(result).toBe(bytes);
  });
  it('client closing a backpressured native response aborts upstream', async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const { base } = await setup((_req, res) => {
      res.on('close', resolveClosed);
      res.write('x'.repeat(8 * 1024 * 1024));
    });
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(base + '/v1/messages', { method: 'POST' }, (res) => {
        res.pause();
        setTimeout(() => {
          res.destroy();
          resolve();
        }, 25);
      });
      client.on('error', reject);
      client.end(JSON.stringify({ model: 'anthropic/x' }));
    });
    await closed;
  });
  it('native upstream interruption destroys the downstream connection', async () => {
    const { base } = await setup((_req, res) => {
      res.write('partial');
      setTimeout(() => res.destroy(), 20);
    });
    const result = await post(base, { model: 'anthropic/x' });
    await expect(result.text()).rejects.toThrow();
  });
  it('total streaming budget returns SSE error', async () => {
    const { base } = await setup(
      (_req, res) => {
        res.setHeader('content-type', 'text/event-stream');
        res.end(sse({ type: 'response.created', response: { id: 'r' } }));
      },
      { maxStreamBytes: 10 },
    );
    const text = await (await post(base, { ...request, stream: true })).text();
    expect(text).toContain('event: error');
    expect(text).toContain('limit');
  });
});

it('invalid UTF8 upstream JSON is rejected without replacing bytes', async () => {
  const { base } = await setup((_req, res) =>
    res.end(
      Buffer.concat([
        Buffer.from('{"id":"'),
        Buffer.from([255]),
        Buffer.from('","status":"completed","output":[]}'),
      ]),
    ),
  );
  expect((await post(base)).status).toBe(502);
});

it('request deadline also covers a client that never finishes its JSON body', async () => {
  const { base } = await setup(() => {}, { timeoutMs: 40 });
  const status = await new Promise<number>((resolve, reject) => {
    const client = httpRequest(
      base + '/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    client.on('error', reject);
    client.write('{"model":');
  });
  expect(status).toBe(504);
});
it('upstream empty response body fails explicitly', async () => {
  const base = await listen(
    createGateway({
      upstreamUrl: 'http://unused.example',
      fetch: async () => new Response(null, { status: 200 }),
    }),
  );
  expect((await post(base)).status).toBe(502);
});

describe('web client hardcoded Haiku alias', () => {
  it.each([false, true])('routes alias through native Messages with stream=%s', async (stream) => {
    let captured: any;
    const nativeResponse = stream
      ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : '{"native":true}';
    const { base } = await setup(async (req, res) => {
      captured = { url: req.url, headers: req.headers, body: JSON.parse(await read(req)) };
      res.setHeader('content-type', stream ? 'text/event-stream' : 'application/json');
      res.end(nativeResponse);
    });
    const payload = {
      model: 'claude-haiku-4-5-20251001',
      stream,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello 🌎' }],
      unknown_native_field: { keep: [1, true, null] },
      thinking: { type: 'adaptive' },
    };
    const result = await post(base, payload, { 'anthropic-beta': 'native-beta' });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(nativeResponse);
    expect(captured.url).toBe('/v1/messages');
    expect(captured.body).toEqual({ ...payload, model: 'anthropic/claude-haiku-4-5-20251001' });
    expect(captured.headers['anthropic-beta']).toBe('native-beta');
    expect(captured.headers['x-api-key']).toBe('upstream-secret');
  });
  it.each([
    'claude-haiku-4-5-20251002',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001-extra',
    'CLAUDE-HAIKU-4-5-20251001',
    'openrouter/claude-haiku-4-5-20251001',
  ])('does not rewrite nearby model ID %s', async (model) => {
    let captured: any;
    const { base } = await setup(async (req, res) => {
      captured = { url: req.url, body: JSON.parse(await read(req)) };
      res.end(JSON.stringify(output));
    });
    expect((await post(base, { ...request, model })).status).toBe(200);
    expect(captured.url).toBe('/v1/responses');
    expect(captured.body.model).toBe(model);
  });
  it('already-prefixed Haiku stays byte-for-byte unchanged', async () => {
    const raw = '{ "model": "anthropic/claude-haiku-4-5-20251001", "custom": true }\n';
    let received = '';
    const { base } = await setup(async (req, res) => {
      received = await read(req);
      res.end('{}');
    });
    expect((await post(base, raw)).status).toBe(200);
    expect(received).toBe(raw);
  });
});
