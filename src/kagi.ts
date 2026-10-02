import { parseHTML } from 'linkedom';
export type SearchResult = { url: string; title: string; snippet: string; date?: string };
export type SearchOptions = {
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal: AbortSignal;
};
export type Searcher = (query: string, options: SearchOptions) => Promise<SearchResult[]>;
function publicUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return;
    return u.href;
  } catch {
    return;
  }
}
export function matchesDomain(url: string, filter: string): boolean {
  try {
    const u = new URL(url),
      f = new URL(`https://${filter}`);
    return (
      (u.hostname === f.hostname || u.hostname.endsWith(`.${f.hostname}`)) &&
      (f.pathname === '/' || u.pathname.startsWith(f.pathname))
    );
  } catch {
    return false;
  }
}
export function filterResults(results: SearchResult[], options: SearchOptions): SearchResult[] {
  return results.filter(
    (r) =>
      (!options.allowedDomains?.length ||
        options.allowedDomains.some((d) => matchesDomain(r.url, d))) &&
      !options.blockedDomains?.some((d) => matchesDomain(r.url, d)),
  );
}
/** Selectors adapted from the user's @tap/kagi-mcp scraper. No scripts/resources execute. */
export function parseKagiResults(html: string, now = new Date()): SearchResult[] {
  const { document } = parseHTML(html),
    container = document.getElementById('page0');
  if (!container) throw new Error('Kagi returned no search results container');
  const results: SearchResult[] = [],
    seen = new Set<string>();
  for (const root of Array.from(container.children)) {
    if (!root.classList.contains('sri-group') && !root.classList.contains('search-result'))
      continue;
    const elements = root.classList.contains('sri-group')
      ? [root.children[0], ...Array.from(root.querySelector('.sr-group')?.children ?? [])]
      : [root];
    for (const el of elements) {
      if (!el) continue;
      const header = el.querySelector('._0_URL'),
        url = publicUrl(header?.getAttribute('href') ?? '');
      if (!url || seen.has(url)) continue;
      const description = el.querySelector('.__sri-desc')?.cloneNode(true) as typeof el | undefined;
      const time = description?.querySelector('span.__sri-time'),
        dateText = time?.textContent?.trim();
      time?.remove();
      let date: Date | undefined;
      if (dateText === 'Today' || dateText === 'Yesterday') {
        date = new Date(now);
        if (dateText === 'Yesterday') date.setUTCDate(date.getUTCDate() - 1);
      } else if (dateText) date = new Date(dateText);
      seen.add(url);
      results.push({
        url,
        title: (header?.textContent ?? '').trim().slice(0, 1000),
        snippet: (description?.textContent ?? '').trim().slice(0, 8000),
        ...(date && Number.isFinite(date.getTime()) && { date: date.toISOString() }),
      });
    }
  }
  return results.slice(0, 10);
}
export function createKagiSearcher(
  session: string,
  options: { turnstile?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Searcher {
  const fetcher = options.fetch ?? fetch;
  return async (query, filters) => {
    const terms = [
      query,
      ...(filters.allowedDomains?.length
        ? [`(${filters.allowedDomains.map((d) => `site:${d}`).join(' OR ')})`]
        : []),
      ...(filters.blockedDomains ?? []).map((d) => `-site:${d}`),
    ].join(' ');
    const response = await fetcher(
      `https://kagi.com/html/search?${new URLSearchParams({ q: terms })}`,
      {
        headers: {
          Cookie: `kagi_session=${encodeURIComponent(session)};${options.turnstile ? ` turnstile-session=${encodeURIComponent(options.turnstile)};` : ''}`,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
        },
        signal: AbortSignal.any([filters.signal, AbortSignal.timeout(options.timeoutMs ?? 20000)]),
        redirect: 'manual',
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Kagi search request failed');
    }
    if (!response.body) throw new Error('Kagi returned an empty response');
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) throw new Error('Kagi response too large');
      chunks.push(chunk);
    }
    const results = filterResults(
      parseKagiResults(Buffer.concat(chunks).toString('utf8')),
      filters,
    );
    // Never allow personal auth to leak through reflected page content or links.
    return results.filter(
      (r) =>
        ![
          session,
          encodeURIComponent(session),
          options.turnstile,
          options.turnstile && encodeURIComponent(options.turnstile),
        ]
          .filter(Boolean)
          .some((secret) => JSON.stringify(r).includes(secret!)),
    );
  };
}
