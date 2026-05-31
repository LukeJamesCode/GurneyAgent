import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveExtensionSelection, type ExtensionSelectionPlan } from './init.js';
import type { DiscoveredExtension } from './ext-setup.js';

function ext(name: string, deps: string[] = []): DiscoveredExtension {
  return {
    name,
    folder: `/tmp/${name}`,
    manifest: {
      name,
      version: '0.1.0',
      gurney: '*',
      deps,
    },
  };
}

function names(plan: ExtensionSelectionPlan): string[] {
  return plan.extensions.map((e) => e.name);
}

test('resolveExtensionSelection adds bundled dependencies before selected extensions', () => {
  const plan = resolveExtensionSelection(
    [ext('gurney-dependent', ['gurney-voice']), ext('gurney-voice')],
    ['gurney-dependent'],
  );

  assert.deepEqual(names(plan), ['gurney-voice', 'gurney-dependent']);
  assert.deepEqual(plan.addedDependencies, ['gurney-voice']);
  assert.deepEqual(plan.missingDependencies, []);
});

test('resolveExtensionSelection reports dependencies that are not bundled', () => {
  const plan = resolveExtensionSelection(
    [ext('gurney-front', ['gurney-missing'])],
    ['gurney-front'],
  );

  assert.deepEqual(names(plan), ['gurney-front']);
  assert.deepEqual(plan.addedDependencies, []);
  assert.deepEqual(plan.missingDependencies, [
    { extension: 'gurney-front', dependency: 'gurney-missing' },
  ]);
});
