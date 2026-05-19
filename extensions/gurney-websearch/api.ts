// Web search backends. Primary: DuckDuckGo instant-answer API (no key).
// Optional: SearXNG for proper ranked web results when a self-hosted instance
// is configured.

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

const UA = 'gurney-websearch/0.1 (https://github.com/gurney)';

export async function duckduckgoSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
    `&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const d = (await res.json()) as {
    AbstractTitle?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
      Topics?: Array<{ Text?: string; FirstURL?: string }>;
    }>;
  };

  const results: SearchResult[] = [];

  if (d.AbstractText && d.AbstractURL) {
    results.push({
      title: d.AbstractTitle ?? query,
      snippet: d.AbstractText.slice(0, 280),
      url: d.AbstractURL,
    });
  }

  for (const topic of d.RelatedTopics ?? []) {
    if (results.length >= maxResults) break;
    // Some topics are grouped (have a Topics sub-array instead of Text)
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.slice(0, 100),
        snippet: topic.Text.slice(0, 280),
        url: topic.FirstURL,
      });
    }
  }

  return results.slice(0, maxResults);
}

export async function searxngSearch(
  baseUrl: string,
  query: string,
  maxResults = 5,
): Promise<SearchResult[]> {
  const url =
    `${baseUrl.replace(/\/$/, '')}/search` + `?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const d = (await res.json()) as {
    results?: Array<{ title?: string; content?: string; url?: string }>;
  };
  return (d.results ?? []).slice(0, maxResults).map((r) => ({
    title: (r.title ?? '').slice(0, 100),
    snippet: (r.content ?? '').slice(0, 280),
    url: r.url ?? '',
  }));
}

// Strip suspected prompt-injection from external snippets.
function sanitize(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/gi, '')
    .slice(0, 280);
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${sanitize(r.snippet)}\n   ${r.url}`)
    .join('\n\n');
}
