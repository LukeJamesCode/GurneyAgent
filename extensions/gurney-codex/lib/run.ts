// Shared handoff runner. Both the `codex_handoff` tool (qwen-initiated) and the
// `/codex` command (user-initiated) funnel through here so budget accounting,
// token refresh, prompt composition, and error shaping live in exactly one
// place.

import type { Host } from '../../../src/core/extensions.js';
import { getValidAccessToken, CodexNotAuthedError } from './store.js';
import { callCodex, CodexApiError, type CodexResult } from './codex.js';
import { localDay, countToday, recordCall } from './budget.js';

export interface HandoffInput {
  task: string;
  context?: string;
  successCriteria?: string;
  chatId?: number;
  source: 'tool' | 'command';
  signal?: AbortSignal;
}

export type HandoffOutcome =
  | { ok: true; result: CodexResult }
  // `denied` = a policy stop (not authed / over budget). The caller surfaces
  // `message` to the user; it is NOT a backend failure.
  | { ok: false; denied: true; message: string }
  | { ok: false; denied: false; message: string };

interface Settings {
  model: string;
  baseUrl: string;
  ceiling: number;
  maxOutputTokens: number;
  timeoutMs: number;
  timeZone?: string;
}

export function readSettings(host: Host): Settings {
  const tz = host.settings.get<string>('time_zone', '');
  const s: Settings = {
    model: host.settings.get<string>('model', 'gpt-5-codex') || 'gpt-5-codex',
    baseUrl:
      host.settings.get<string>('base_url', 'https://chatgpt.com/backend-api/codex') ||
      'https://chatgpt.com/backend-api/codex',
    ceiling: Number(host.settings.get<number>('daily_call_ceiling', 20)) || 20,
    maxOutputTokens: Number(host.settings.get<number>('max_output_tokens', 4096)) || 4096,
    timeoutMs: Number(host.settings.get<number>('request_timeout_ms', 120_000)) || 120_000,
  };
  if (tz) s.timeZone = tz;
  return s;
}

export function composePrompt(input: HandoffInput): string {
  const parts = [`TASK:\n${input.task.trim()}`];
  if (input.context?.trim())
    parts.push(`\nCONTEXT (from the user / conversation):\n${input.context.trim()}`);
  if (input.successCriteria?.trim())
    parts.push(`\nSUCCESS CRITERIA:\n${input.successCriteria.trim()}`);
  return parts.join('\n');
}

export async function runHandoff(
  host: Host,
  input: HandoffInput,
  deps?: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<HandoffOutcome> {
  const now = (deps?.now ?? Date.now)();
  const cfg = readSettings(host);
  const day = localDay(now, cfg.timeZone);

  // Budget gate first — cheapest check, and refusing early avoids a token
  // refresh we don't need.
  const used = countToday(host.db, day);
  if (used >= cfg.ceiling) {
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'denied',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    return {
      ok: false,
      denied: true,
      message: `Daily Codex budget reached (${cfg.ceiling}/${cfg.ceiling} calls used today). It resets at local midnight, or raise it with \`gurney config gurney-codex\`.`,
    };
  }

  // Auth + refresh.
  let token;
  try {
    const tokenDeps: { fetchImpl?: typeof fetch; now?: () => number } = {};
    if (deps?.fetchImpl) tokenDeps.fetchImpl = deps.fetchImpl;
    if (deps?.now) tokenDeps.now = deps.now;
    token = await getValidAccessToken(host, tokenDeps);
  } catch (e) {
    if (e instanceof CodexNotAuthedError) {
      return { ok: false, denied: true, message: e.message };
    }
    const msg = e instanceof Error ? e.message : String(e);
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'error',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    return { ok: false, denied: false, message: `Could not refresh Codex credentials: ${msg}` };
  }

  // Call Codex.
  try {
    const callArgs: Parameters<typeof callCodex>[0] = {
      baseUrl: cfg.baseUrl,
      accessToken: token.accessToken,
      accountId: token.accountId,
      model: cfg.model,
      prompt: composePrompt(input),
      maxOutputTokens: cfg.maxOutputTokens,
      timeoutMs: cfg.timeoutMs,
    };
    if (deps?.fetchImpl) callArgs.fetchImpl = deps.fetchImpl;
    if (input.signal) callArgs.signal = input.signal;
    const result = await callCodex(callArgs);
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'ok',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(result.promptTokens !== undefined ? { promptTokens: result.promptTokens } : {}),
      ...(result.completionTokens !== undefined
        ? { completionTokens: result.completionTokens }
        : {}),
    });
    return { ok: true, result };
  } catch (e) {
    recordCall(host.db, {
      day,
      source: input.source,
      status: 'error',
      now,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
    });
    if (e instanceof CodexApiError && e.status === 401) {
      return {
        ok: false,
        denied: false,
        message:
          'Codex rejected the credentials (401). The stored token may lack backend access — re-run `gurney auth gurney-codex`.',
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, denied: false, message: `Codex call failed: ${msg}` };
  }
}
