import type { Host } from '../../../src/core/extensions.js';

export class SecretNotFoundError extends Error {
  constructor(handle: string, settingKey: string) {
    super(
      `Missing API key for ${handle}. Store it in gurney-openai-compatible setting "${settingKey}".`,
    );
    this.name = 'SecretNotFoundError';
  }
}

export function settingKeyForSecretHandle(handle: string): string {
  if (!handle.startsWith('secret://')) {
    throw new Error('API key references must use secret:// handles');
  }
  const path = handle.slice('secret://'.length).replace(/^\/+/, '');
  if (!path) throw new Error('secret:// handle must include a path');
  return `secret_${path.replace(/[^a-z0-9_-]+/gi, '_')}`;
}

export function resolveSecret(host: Host, handle: string): string {
  const key = settingKeyForSecretHandle(handle);
  const value = host.settings.get<string>(key, '');
  if (!value) throw new SecretNotFoundError(handle, key);
  return value;
}
