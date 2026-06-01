// Search backends. Two are supported, both keyless:
//   - duckduckgo: scrapes the no-JS HTML endpoint (tolerant regex parse).
//   - searxng:    a self-hosted SearXNG instance's JSON API (?format=json).
//
// Everything is best-effort: a backend that's blocked, rate-limited, or
// returns an unexpected shape yields [] rather than throwing, so a course
// build (or a chat tool call) degrades to "no web context" instead of failing.

import { domainOf, htmlToText, isSafeUrl, truncate } from './sanitize.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageImage {
  pageUrl: string;
  imageUrl: string;
  alt: string;
  width?: number;
  height?: number;
}

export type Backend = 'duckduckgo' | 'searxng';

export interface SearchOptions {
  backend?: Backend;
  searxngUrl?: string;
  maxResults?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const UA =
  'Mozilla/5.0 (compatible; gurney-websearch/0.1; +https://github.com/LukeJamesCode/GurneyAgent)';

const MAX_REDIRECTS = 4;

// Fetch text with redirects handled MANUALLY so every hop's target is
// re-checked by the SSRF guard. `redirect: 'follow'` would only validate the
// first URL — a public page could then 302 to 169.254.169.254 (cloud metadata)
// and slip past. Here each Location is resolved and re-validated before we
// follow it.
async function getText(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeUrl(current)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': UA, ...headers },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers?.get('location');
        if (!loc) return null;
        try {
          current = new URL(loc, current).toString(); // resolve relative redirects
        } catch {
          return null;
        }
        continue; // re-validated at the top of the next iteration
      }
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // too many redirects
}

// DuckDuckGo's redirect links wrap the real URL in a `uddg` query param.
function unwrapDuckUrl(href: string): string | null {
  let h = href;
  if (h.startsWith('//')) h = `https:${h}`;
  const m = /[?&]uddg=([^&]+)/.exec(h);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return null;
    }
  }
  return /^https?:\/\//.test(h) ? h : null;
}

function parseDuckHtml(html: string, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  // Each result exposes an anchor with class result__a (title+link) and a
  // sibling result__snippet. We walk the anchors in document order and grab
  // the nearest following snippet.
  const anchorRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(htmlToText(sm[1]!));
  let am: RegExpExecArray | null;
  let i = 0;
  while ((am = anchorRe.exec(html)) && out.length < max) {
    const url = unwrapDuckUrl(am[1]!);
    const title = htmlToText(am[2]!);
    if (!url || !title || !isSafeUrl(url)) {
      i++;
      continue;
    }
    out.push({ title, url, snippet: truncate(snippets[i] ?? '', 320) });
    i++;
  }
  return out;
}

function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  return decodeHtmlAttr(m?.[2] ?? m?.[3] ?? m?.[4] ?? '');
}

function decodeHtmlAttr(s: string): string {
  return htmlToText(s).replace(/\s+/g, ' ').trim();
}

function numberAttr(attrs: string, name: string): number | undefined {
  const raw = attrValue(attrs, name);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function srcFromSrcset(srcset: string): string {
  let best = '';
  let bestScore = -1;
  for (const part of srcset.split(',')) {
    const pieces = part.trim().split(/\s+/);
    const url = pieces[0] ?? '';
    const scoreRaw = pieces[1] ?? '1x';
    const score = Number.parseFloat(scoreRaw.replace(/[wx]$/i, ''));
    if (url && Number.isFinite(score) && score > bestScore) {
      best = url;
      bestScore = score;
    }
  }
  return best;
}

function resolveImageUrl(raw: string, pageUrl: string): string | null {
  if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return null;
  try {
    const url = new URL(raw, pageUrl).toString();
    if (!isSafeUrl(url)) return null;
    if (/\.(svg|ico)(?:[?#]|$)/i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

function looksDecorative(url: string, alt: string, width?: number, height?: number): boolean {
  const hay = `${url} ${alt}`.toLowerCase();
  if (/\b(logo|icon|sprite|avatar|profile|tracking|pixel|blank|spacer|badge)\b/.test(hay))
    return true;
  if (width !== undefined && height !== undefined && (width < 180 || height < 120)) return true;
  return false;
}

function addImage(
  out: PageImage[],
  seen: Set<string>,
  pageUrl: string,
  imageUrl: string | null,
  alt: string,
  width?: number,
  height?: number,
): void {
  if (!imageUrl || seen.has(imageUrl)) return;
  if (looksDecorative(imageUrl, alt, width, height)) return;
  seen.add(imageUrl);
  out.push({
    pageUrl,
    imageUrl,
    alt,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  });
}

function parsePageImages(html: string, pageUrl: string, max: number): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();

  const metaRe =
    /<meta\b([^>]*(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*)>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = metaRe.exec(html)) && out.length < max) {
    const attrs = mm[1] ?? '';
    const url = resolveImageUrl(attrValue(attrs, 'content'), pageUrl);
    addImage(out, seen, pageUrl, url, 'social preview image');
  }

  const imgRe = /<img\b([^>]*)>/gi;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(html)) && out.length < max) {
    const attrs = im[1] ?? '';
    const src =
      attrValue(attrs, 'src') ||
      attrValue(attrs, 'data-src') ||
      attrValue(attrs, 'data-original') ||
      srcFromSrcset(attrValue(attrs, 'srcset'));
    const width = numberAttr(attrs, 'width');
    const height = numberAttr(attrs, 'height');
    const url = resolveImageUrl(src, pageUrl);
    addImage(out, seen, pageUrl, url, attrValue(attrs, 'alt'), width, height);
  }

  return out;
}

async function searchDuckDuckGo(
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  max: number,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await getText(url, fetchImpl, timeoutMs);
  if (!html) return [];
  return parseDuckHtml(html, max);
}

async function searchSearxng(
  base: string,
  query: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  max: number,
): Promise<SearchResult[]> {
  if (!isSafeUrl(base)) return [];
  const sep = base.includes('?') ? '&' : '?';
  const url = `${base.replace(/\/$/, '')}/search${sep}q=${encodeURIComponent(query)}&format=json`;
  const text = await getText(url, fetchImpl, timeoutMs, { accept: 'application/json' });
  if (!text) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = (json as { results?: unknown }).results;
  if (!Array.isArray(rows)) return [];
  const out: SearchResult[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    const row = r as { title?: unknown; url?: unknown; content?: unknown };
    const url2 = typeof row.url === 'string' ? row.url : '';
    const title = typeof row.title === 'string' ? row.title : '';
    if (!url2 || !title || !isSafeUrl(url2)) continue;
    out.push({
      title: htmlToText(title),
      url: url2,
      snippet: truncate(htmlToText(typeof row.content === 'string' ? row.content : ''), 320),
    });
  }
  return out;
}

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const q = query.trim().slice(0, 400);
  if (!q) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const max = Math.max(1, Math.min(10, opts.maxResults ?? 6));
  const backend = opts.backend ?? 'duckduckgo';

  if (backend === 'searxng' && opts.searxngUrl) {
    const r = await searchSearxng(opts.searxngUrl, q, fetchImpl, timeoutMs, max);
    if (r.length) return r;
    // fall through to DDG if the SearXNG instance returned nothing
  }
  return searchDuckDuckGo(q, fetchImpl, timeoutMs, max);
}

// Fetch one page and return readable plain text, length-capped. Gated by the
// SSRF guard; returns null on any failure. Only used when page-fetching is
// explicitly enabled.
export async function fetchPageText(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxChars?: number } = {},
): Promise<string | null> {
  const html = await getText(url, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 12_000);
  if (!html) return null;
  const text = htmlToText(html);
  return text ? truncate(text, opts.maxChars ?? 2000) : null;
}

// Fetch one page and return candidate content images. Uses the same safe fetch
// and redirect validation as text extraction. This intentionally returns URLs,
// not bytes; callers can decide whether and when to download a candidate image.
export async function fetchPageImages(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxImages?: number } = {},
): Promise<PageImage[]> {
  const html = await getText(url, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 12_000);
  if (!html) return [];
  return parsePageImages(html, url, Math.max(1, Math.min(20, opts.maxImages ?? 8)));
}

export { domainOf };
