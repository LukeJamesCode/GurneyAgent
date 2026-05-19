// Glue between the Host and the memgraph HTTP bridge. Reads bridge URL/token
// out of the per-extension settings store and returns a configured client, or
// null when the bridge isn't configured yet.

import type { Host } from '../../src/core/extensions.js';
import { createMemoryClient, type BridgeCredentials, type MemoryClient } from './api.js';

export function getCredentials(host: Host): BridgeCredentials | null {
  const url = host.settings.get<string>('bridge_url');
  if (!url) return null;
  const namespace = host.settings.get<string>('namespace', 'default')!;
  const token = host.settings.get<string>('bridge_token');
  const creds: BridgeCredentials = { url, namespace };
  if (token) creds.token = token;
  return creds;
}

export function getClient(host: Host): MemoryClient | null {
  const creds = getCredentials(host);
  if (!creds) return null;
  return createMemoryClient({ creds });
}

export function formatFactLine(f: { text: string; score?: number }): string {
  if (f.score === undefined) return `• ${f.text}`;
  return `• ${f.text}  (${f.score.toFixed(2)})`;
}
