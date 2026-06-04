import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { LLM, ProfileConfig, ProfileName } from '../../../src/core/llm.js';
import { chooseModel, chooseModelFromLabel } from './generate.js';

// Minimal LLM stub: chooseModel / chooseModelFromLabel only read listProfiles
// (to pick the best local profile) and resolveModel (to name it). Everything
// else throws so an accidental dependency surfaces loudly.
function fakeLLM(opts: { profiles: Partial<Record<ProfileName, boolean>>; resolved: string }): LLM {
  const mk = (model: string): ProfileConfig => ({ model, contextTokens: 4096, heavy: false });
  return {
    listProfiles: () => ({
      chat: opts.profiles.chat ? mk(opts.resolved) : null,
      reason: opts.profiles.reason ? mk(opts.resolved) : null,
      tools: opts.profiles.tools ? mk(opts.resolved) : null,
    }),
    resolveModel: () => opts.resolved,
    chat: () => {
      throw new Error('not used');
    },
    health: () => {
      throw new Error('not used');
    },
    breakerSnapshot: () => {
      throw new Error('not used');
    },
    stopIdleEviction: () => {},
  };
}

test('chooseModelFromLabel keeps Codex as the routable model on resume', () => {
  const llm = fakeLLM({ profiles: { chat: true }, resolved: 'qwen3.5:0.8b' });
  const choice = chooseModelFromLabel(llm, 'codex');
  // Must round-trip to the same routable ref a fresh Codex build produces,
  // otherwise a resumed build silently drops to the local model.
  assert.deepEqual(choice.ref, { model: 'codex' });
  assert.deepEqual(choice.ref, chooseModel(llm, 'codex').ref);
  assert.equal(choice.label, 'codex');
});

test('chooseModelFromLabel keeps a cloud alias:model label on resume', () => {
  const llm = fakeLLM({ profiles: { chat: true }, resolved: 'qwen3.5:0.8b' });
  const choice = chooseModelFromLabel(llm, 'openai:gpt-4.1-mini');
  assert.deepEqual(choice.ref, { model: 'openai:gpt-4.1-mini' });
});

test('chooseModelFromLabel returns the local profile ref for the default local label', () => {
  // When the persisted label is just the resolved local model name, resume on
  // the profile ref (not a literal tag) so profile tuning is preserved.
  const llm = fakeLLM({ profiles: { reason: true }, resolved: 'qwen3.5:9b' });
  const choice = chooseModelFromLabel(llm, 'qwen3.5:9b');
  assert.equal(choice.ref, 'reason');
});

test('chooseModelFromLabel falls back to local when the label is missing', () => {
  const llm = fakeLLM({ profiles: { chat: true }, resolved: 'qwen3.5:0.8b' });
  for (const label of [undefined, null, '', '   ']) {
    const choice = chooseModelFromLabel(llm, label);
    assert.equal(choice.ref, 'chat', `label ${JSON.stringify(label)} should resume local`);
  }
});
