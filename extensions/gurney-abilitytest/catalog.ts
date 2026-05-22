// Catalog discovery + tier/filter selection for `gurney abilitytest`.
//
// Reads core.json (shipped by this extension) plus every installed
// extension's tests/ability-tests.json. Extensions are the source of truth
// for the wording variations Gurney should be tested on — core stays out of
// the business of knowing what an extension can do.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type TestTier = 'smoke' | 'standard' | 'full';
export type TestKind = 'freeform' | 'slash';

export interface TestExpectation {
  // Name of a tool the model is expected to call. Pass if it appears in the
  // afterTurn toolCalls list; fail if not.
  tool?: string;
  // True if an extension intercept (e.g. gurney-instant-responses) is
  // expected to ship a reply before the orchestrator runs.
  interceptReply?: boolean;
  // True if a voice payload is expected to be emitted (sendVoice called).
  voice?: boolean;
}

export interface TestCase {
  id: string;
  ability: string;
  tier: TestTier;
  kind: TestKind;
  message: string;
  source: string;
  expects?: TestExpectation;
}

interface CatalogFile {
  tests: Array<Omit<TestCase, 'source'>>;
}

const TIER_ORDER: TestTier[] = ['smoke', 'standard', 'full'];

export interface LoadCatalogOptions {
  tier: TestTier;
  filter?: string;
}

export function loadCatalog(
  extensionRoots: readonly string[],
  runnerDir: string,
  opts: LoadCatalogOptions,
): TestCase[] {
  const tierIdx = TIER_ORDER.indexOf(opts.tier);
  if (tierIdx === -1) {
    throw new Error(`Unknown tier: ${opts.tier}. Use one of: ${TIER_ORDER.join(', ')}`);
  }

  const all: TestCase[] = [];

  const corePath = join(runnerDir, 'tests', 'core.json');
  if (existsSync(corePath)) {
    all.push(...readCatalog(corePath, 'core'));
  }

  // Each extension owns its own catalog. Skip the abilitytest extension
  // itself — its tests are core-level and ship as tests/core.json above.
  const seen = new Set<string>();
  for (const root of extensionRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'gurney-abilitytest') continue;
      if (seen.has(entry)) continue;
      const extDir = join(root, entry);
      try {
        if (!statSync(extDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const catPath = join(extDir, 'tests', 'ability-tests.json');
      if (!existsSync(catPath)) continue;
      seen.add(entry);
      all.push(...readCatalog(catPath, entry));
    }
  }

  const byTier = all.filter((t) => TIER_ORDER.indexOf(t.tier) <= tierIdx);

  if (!opts.filter) return byTier;
  const re = new RegExp(opts.filter);
  return byTier.filter((t) => re.test(t.id) || re.test(t.ability));
}

function readCatalog(path: string, source: string): TestCase[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as CatalogFile).tests)) {
    throw new Error(`${path}: expected an object with a "tests" array`);
  }
  const tests = (raw as CatalogFile).tests;
  for (const t of tests) {
    if (!t.id || !t.ability || !t.tier || !t.kind || !t.message) {
      throw new Error(
        `${path}: test missing required field (id/ability/tier/kind/message): ${JSON.stringify(t)}`,
      );
    }
    if (!TIER_ORDER.includes(t.tier)) {
      throw new Error(`${path}: invalid tier "${t.tier}" in ${t.id}`);
    }
    if (t.kind !== 'freeform' && t.kind !== 'slash') {
      throw new Error(`${path}: invalid kind "${t.kind}" in ${t.id}`);
    }
  }
  return tests.map((t) => ({ ...t, source }));
}
