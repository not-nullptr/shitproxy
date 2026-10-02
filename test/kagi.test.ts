import { it, expect, vi } from 'vitest';
import { createKagiSearcher, parseKagiResults, filterResults, matchesDomain } from '../src/kagi.js';
const result = (url = 'https://example.com/a', date = 'Today', title = 'Hello &amp; world') =>
  `<div class="search-result"><a class="_0_URL" href="${url}">${title}</a><div class="__sri-desc"><span class="__sri-time">${date}</span> A useful snippet</div></div>`;
const page = (body: string) => `<div id="page0">${body}</div>`;
const filters = { signal: new AbortController().signal };
it('parses grouped results entities Unicode and deduplicates', () => {
  const html = page(
    `<div class="sri-group">${result()}<div class="sr-group">${result('https://sub.example.com/b', 'Yesterday', '世界 🌎')}</div></div>${result()}`,
  );
  expect(parseKagiResults(html, new Date('2026-10-02T12:00:00Z'))).toEqual([
    {
      url: 'https://example.com/a',
      title: 'Hello & world',
      snippet: 'A useful snippet',
      date: '2026-10-02T12:00:00.000Z',
    },
    {
      url: 'https://sub.example.com/b',
      title: '世界 🌎',
      snippet: 'A useful snippet',
      date: '2026-10-01T12:00:00.000Z',
    },
  ]);
});
it.each(['', 'invalid date', 'two weeks ago'])('omits unparseable date %s', (date) =>
  expect(parseKagiResults(page(result(undefined, date)))[0]).not.toHaveProperty('date'),
);
it('parses absolute dates', () =>
  expect(parseKagiResults(page(result(undefined, '2026-09-30')))[0]?.date).toBe(
    '2026-09-30T00:00:00.000Z',
  ));
it.each([
  'javascript:alert(1)',
  '/relative',
  'https://user:secret@example.com',
  'bad',
  'file:///c:/secret',
])('rejects unsafe URL %s', (url) => expect(parseKagiResults(page(result(url)))).toEqual([]));
it('skips widgets and missing links; distinguishes no results from missing page', () => {
  expect(
    parseKagiResults(page('<div class="widget">x</div><div class="search-result"></div>')),
  ).toEqual([]);
  expect(() => parseKagiResults('<form>login</form>')).toThrow(/container/);
});
it('caps result count and field sizes', () => {
  const r = parseKagiResults(
    page(
      Array.from({ length: 20 }, (_, i) =>
        result(`https://example.com/${i}`, '', 'x'.repeat(2000)),
      ).join(''),
    ),
  );
  expect(r).toHaveLength(10);
  expect(r[0]?.title).toHaveLength(1000);
});
it.each([
  ['https://example.com/a', 'example.com', true],
  ['https://sub.example.com/a', 'example.com', true],
  ['https://fakeexample.com/a', 'example.com', false],
  ['https://example.com/docs/a', 'example.com/docs', true],
  ['https://example.com/other', 'example.com/docs', false],
  ['bad', 'example.com', false],
])('matches domain %s %s', (url, domain, expected) =>
  expect(matchesDomain(url as string, domain as string)).toBe(expected),
);
it('applies allow and block filters', () =>
  expect(
    filterResults(
      [
        { url: 'https://example.com/a', title: 'a', snippet: '' },
        { url: 'https://sub.example.com/b', title: 'b', snippet: '' },
        { url: 'https://evil.com', title: 'e', snippet: '' },
      ],
      { ...filters, allowedDomains: ['example.com'], blockedDomains: ['sub.example.com'] },
    ),
  ).toEqual([{ url: 'https://example.com/a', title: 'a', snippet: '' }]));
it('sends auth only to fixed Kagi origin with redirects disabled', async () => {
  const fetcher = vi.fn(async () => new Response(page(result())));
  const search = createKagiSearcher('personal token', {
    turnstile: 'challenge',
    fetch: fetcher as any,
  });
  expect(
    await search('news', {
      ...filters,
      allowedDomains: ['example.com'],
      blockedDomains: ['bad.com'],
    }),
  ).toHaveLength(1);
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(new URL(url).origin).toBe('https://kagi.com');
  expect(new URL(url).searchParams.get('q')).toContain('-site:bad.com');
  expect(options.redirect).toBe('manual');
  expect(options.headers.Cookie).toBe(
    'kagi_session=personal%20token; turnstile-session=challenge;',
  );
});
it.each([302, 401, 429, 500])('fails HTTP %s without leaking response content', async (status) => {
  const search = createKagiSearcher('secret', {
    fetch: async () =>
      new Response('secret', { status, headers: { location: 'https://evil.com' } }),
  });
  await expect(search('q', filters)).rejects.toThrow('Kagi search request failed');
});
it('rejects empty oversized and login responses', async () => {
  for (const response of [
    new Response(null),
    new Response('x'.repeat(8 * 1024 * 1024 + 1)),
    new Response('<form>secret</form>'),
  ])
    await expect(
      createKagiSearcher('secret', { fetch: async () => response })('q', filters),
    ).rejects.toThrow();
});
it('removes reflected personal auth from results', async () =>
  expect(
    await createKagiSearcher('personal secret', {
      fetch: async () =>
        new Response(
          page(
            result(undefined, '', 'personal secret') +
              result('https://other.com', '', 'personal%20secret'),
          ),
        ),
    })('q', filters),
  ).toEqual([]));
it('propagates cancellation', async () => {
  const c = new AbortController();
  c.abort();
  const fetcher = async (_url: any, options: any) => {
    options.signal.throwIfAborted();
    return new Response('');
  };
  await expect(
    createKagiSearcher('secret', { fetch: fetcher })('q', { signal: c.signal }),
  ).rejects.toThrow();
});
