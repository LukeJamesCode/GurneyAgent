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

interface WebsearchModule {
  researchTopic: (
    topic: string,
    opts: { maxResults?: number; fetchPages?: boolean; timeoutMs?: number; log?: unknown },
  ) => Promise<{ brief: string; sources: Array<{ title: string; url: string }> }>;
  wrapUntrusted: (brief: string) => string;
}

async function loadWebsearch(): Promise<WebsearchModule | null> {
  try {
    // Non-literal specifier: TypeScript won't try to resolve a sibling
    // extension that may not be installed; Node resolves it at runtime when it
    // is. Path is relative to this file (extensions/gurney-tudor/lib/).
    const spec = ['..', '..', 'gurney-websearch', 'lib', 'research.js'].join('/');
    const mod = (await import(spec)) as Partial<WebsearchModule>;
    if (typeof mod.researchTopic === 'function' && typeof mod.wrapUntrusted === 'function') {
      return mod as WebsearchModule;
    }
    return null;
  } catch {
    return null; // not installed / not resolvable — silently skip research
  }
}

export interface ResearchOutcome {
  reference: string; // wrapped + ready to drop into a prompt ('' when unavailable)
  sources: Array<{ title: string; url: string }>;
}

export async function researchForCourse(topic: string, log: Logger): Promise<ResearchOutcome> {
  const ws = await loadWebsearch();
  if (!ws) return { reference: '', sources: [] };
  try {
    const r = await ws.researchTopic(topic, { maxResults: 6, timeoutMs: 12_000, log });
    if (!r.brief) return { reference: '', sources: [] };
    return { reference: ws.wrapUntrusted(r.brief), sources: r.sources.slice(0, 8) };
  } catch (e) {
    log.warn('tudor: web research failed; building from model knowledge instead', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { reference: '', sources: [] };
  }
}
