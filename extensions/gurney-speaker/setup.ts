// Setup entry point. Today it only ensures a shared device secret exists so
// the first device install has something to flash. Once the WebSocket server
// lands this will also surface the LAN URL + secret for the firmware build.

import { randomBytes } from 'node:crypto';
import type { ExtensionSetupContext } from '../../src/core/extensions.js';

export async function setup(ctx: ExtensionSetupContext): Promise<void> {
  const existing = ctx.settings.get<string>('device_shared_secret', '') || '';
  if (existing.length >= 24) {
    ctx.stdout('gurney-speaker: device_shared_secret already set, leaving it untouched.\n');
    return;
  }
  const secret = randomBytes(24).toString('base64url');
  ctx.settings.set('device_shared_secret', secret);
  ctx.stdout(
    `gurney-speaker: generated device_shared_secret — copy this into the firmware NVS before flashing:\n  ${secret}\n`,
  );
}
