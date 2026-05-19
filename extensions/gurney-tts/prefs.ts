// Tiny wrapper around the per-chat preference table. Centralizing this keeps
// commands.ts and jobs.ts from duplicating the same SQL.

import type { DB } from '../../src/storage/db.js';

export function getPref(db: DB, chatId: number, fallback: boolean): boolean {
  const row = db.prepare(`SELECT enabled FROM tts_chat_prefs WHERE chat_id = ?`).get(chatId) as
    | { enabled: number }
    | undefined;
  if (!row) return fallback;
  return row.enabled !== 0;
}

export function setPref(db: DB, chatId: number, enabled: boolean): void {
  db.prepare(
    `INSERT INTO tts_chat_prefs (chat_id, enabled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(chatId, enabled ? 1 : 0, Date.now());
}

// Telegram voice notes break down on huge replies (long encoding, awkward
// listening UX). We strip Markdown-y noise the LLM might emit and cap length.
export function prepForSpeech(text: string, maxChars: number): string | null {
  // Remove fenced code blocks entirely — speaking code is useless.
  const noFences = text.replace(/```[\s\S]*?```/g, ' [code omitted] ');
  // Strip inline-code backticks and Markdown emphasis characters.
  const cleaned = noFences
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > maxChars) return null;
  return cleaned;
}
