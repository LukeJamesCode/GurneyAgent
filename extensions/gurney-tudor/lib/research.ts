// Optional pre-generation research. When the learner opts in AND
// gurney-websearch is installed + enabled, Tudor pulls a sanitized research
// brief so the model designs the course from current facts rather than memory
// alone.
//
// Decoupled by design: gurney-websearch is loaded through a dynamic import
// built from a NON-LITERAL specifier, so Tudor neither statically depends on it
// (its typecheck stays independent) nor breaks at runtime when it's absent. The
// brief comes back already wrapped as untrusted DATA, so it's safe to drop into
// a prompt as-is.

import type { Logger } from '../../../src/util/log.js';
import type { Source } from './types.js';

interface WebsearchModule {
  researchTopic: (
    topic: string,
    opts: { maxResults?: number; fetchPages?: boolean; timeoutMs?: number; log?: unknown },
  ) => Promise<{ brief: string; sources: Array<{ title: string; url: string }> }>;
  previewSources: (
    topic: string,
    opts: { maxResults?: number; timeoutMs?: number },
  ) => Promise<Array<{ title: string; url: string; domain: string; snippet: string }>>;
  briefFromSources: (sources: Source[]) => string;
  wrapUntrusted: (brief: string) => string;
}

async function loadWebsearch(): Promise<WebsearchModule | null> {
  try {
    // Non-literal specifier: TypeScript won't try to resolve a sibling
    // extension that may not be installed; Node resolves it at runtime when it
    // is. Path is relative to this file (extensions/gurney-tudor/lib/).
    const spec = ['..', '..', 'gurney-websearch', 'lib', 'research.js'].join('/');
    const mod = (await import(spec)) as Partial<WebsearchModule>;
    if (
      typeof mod.researchTopic === 'function' &&
      typeof mod.wrapUntrusted === 'function' &&
      typeof mod.previewSources === 'function' &&
      typeof mod.briefFromSources === 'function'
    ) {
      return mod as WebsearchModule;
    }
    return null;
  } catch {
    return null; // not installed / not resolvable — silently skip research
  }
}

export interface ResearchOutcome {
  reference: string; // wrapped + ready to drop into a prompt ('' when unavailable)
  sources: Source[];
}

// Search only — the candidate websites for a topic, so the Learn tab can ask
// the user to approve each before any of it is used. Returns [] when search
// isn't available.
export async function previewSourcesForTopic(topic: string, log: Logger): Promise<Source[]> {
  const ws = await loadWebsearch();
  if (!ws) return [];
  try {
    const found = await ws.previewSources(topic, { maxResults: 6, timeoutMs: 12_000 });
    return found.slice(0, 8);
  } catch (e) {
    log.warn('tudor: source preview failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

// Build a reference brief from an already-approved set of sources (no new
// search). Returns '' when nothing is approved or search is unavailable.
export async function referenceFromSources(sources: Source[], log: Logger): Promise<string> {
  if (sources.length === 0) return '';
  const ws = await loadWebsearch();
  if (!ws) return '';
  try {
    return ws.briefFromSources(sources);
  } catch (e) {
    log.warn('tudor: building brief from approved sources failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return '';
  }
}

// Full auto path (no per-site approval): search, build a brief, return both.
export async function researchForCourse(topic: string, log: Logger): Promise<ResearchOutcome> {
  const ws = await loadWebsearch();
  if (!ws) return { reference: '', sources: [] };
  try {
    const found = await ws.previewSources(topic, { maxResults: 6, timeoutMs: 12_000 });
    const sources = found.slice(0, 8);
    if (sources.length === 0) return { reference: '', sources: [] };
    return { reference: ws.briefFromSources(sources), sources };
  } catch (e) {
    log.warn('tudor: web research failed; building from model knowledge instead', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { reference: '', sources: [] };
  }
}
