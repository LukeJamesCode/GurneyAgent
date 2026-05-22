// Report rendering for ability tests. Two consumers:
//   - terminal:  printRow() during the run, renderSummary() at the end
//   - markdown:  renderMarkdown() writes the saved report file
//
// Kept pure (no I/O) so the runner stays the only place that touches the
// filesystem or stdout.

import type { TestCase } from './catalog.js';

export interface TurnRecord {
  test: TestCase;
  interceptReplies: string[];
  reply: string;
  toolsCalled: Array<{ name: string; ok: boolean }>;
  voiceEmitted: boolean;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  elapsedMs: number;
  status: 'pass' | 'fail' | 'info' | 'error';
  notes: string[];
  error?: string;
}

export interface ReportContext {
  startedAt: number;
  finishedAt: number;
  tier: string;
  chatId: number;
  filter?: string;
}

const STATUS_MARK: Record<TurnRecord['status'], string> = {
  pass: '✔',
  fail: '✗',
  info: '·',
  error: '!',
};

export function judgeTest(record: Omit<TurnRecord, 'status' | 'notes'>): {
  status: TurnRecord['status'];
  notes: string[];
} {
  const notes: string[] = [];
  if (record.error) {
    notes.push(`error: ${record.error}`);
    return { status: 'error', notes };
  }
  const expects = record.test.expects;
  if (!expects || Object.keys(expects).length === 0) {
    return { status: 'info', notes };
  }
  let failed = false;
  if (expects.tool) {
    const found = record.toolsCalled.find((t) => t.name === expects.tool);
    if (!found) {
      const seen = record.toolsCalled.map((t) => t.name).join(', ') || 'none';
      notes.push(`expected tool '${expects.tool}', got: ${seen}`);
      failed = true;
    } else if (!found.ok) {
      notes.push(`tool '${expects.tool}' was called but reported failure`);
      failed = true;
    }
  }
  if (expects.interceptReply && record.interceptReplies.length === 0) {
    notes.push('expected an intercept reply (e.g. instant-response ack); none seen');
    failed = true;
  }
  if (expects.voice && !record.voiceEmitted) {
    notes.push('expected a voice payload via sendVoice; none emitted');
    failed = true;
  }
  return { status: failed ? 'fail' : 'pass', notes };
}

export function formatRow(r: TurnRecord): string {
  const mark = STATUS_MARK[r.status];
  const ms = `${r.elapsedMs}ms`;
  const tools = r.toolsCalled.length
    ? ' · tools: ' + r.toolsCalled.map((t) => (t.ok ? t.name : `${t.name}✗`)).join(', ')
    : '';
  const voice = r.voiceEmitted ? ' · 🔊' : '';
  const intercept = r.interceptReplies.length
    ? `\n  ↪ ${truncateOneLine(r.interceptReplies.join(' | '), 200)}`
    : '';
  const replyLine = r.reply
    ? `\n  < ${truncateOneLine(r.reply, 240)}`
    : r.error
      ? `\n  ! ${truncateOneLine(r.error, 240)}`
      : '';
  const notes = r.notes.length ? `\n  • ${r.notes.join('; ')}` : '';
  return (
    `${mark} [${r.test.id}] ${r.test.ability}  (${ms}${tools}${voice})\n` +
    `  > ${truncateOneLine(r.test.message, 240)}` +
    intercept +
    replyLine +
    notes
  );
}

export function renderSummary(records: TurnRecord[], ctx: ReportContext): string {
  const passes = records.filter((r) => r.status === 'pass').length;
  const fails = records.filter((r) => r.status === 'fail').length;
  const infos = records.filter((r) => r.status === 'info').length;
  const errors = records.filter((r) => r.status === 'error').length;

  const toolTally = new Map<string, number>();
  const toolFails = new Map<string, number>();
  const modelsTouched = new Set<string>();
  const llmElapsed: number[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let voices = 0;
  for (const r of records) {
    if (r.test.kind === 'freeform' && r.model) {
      modelsTouched.add(r.model);
      llmElapsed.push(r.elapsedMs);
      totalPromptTokens += r.promptTokens ?? 0;
      totalCompletionTokens += r.completionTokens ?? 0;
    }
    if (r.voiceEmitted) voices += 1;
    for (const t of r.toolsCalled) {
      toolTally.set(t.name, (toolTally.get(t.name) ?? 0) + 1);
      if (!t.ok) toolFails.set(t.name, (toolFails.get(t.name) ?? 0) + 1);
    }
  }

  const meanMs = llmElapsed.length
    ? Math.round(llmElapsed.reduce((a, b) => a + b, 0) / llmElapsed.length)
    : 0;
  const sorted = [...llmElapsed].sort((a, b) => a - b);
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
    : 0;
  const totalLlmMs = llmElapsed.reduce((a, b) => a + b, 0);

  return [
    '── Summary ───────────────────────────────────────────────────────────────────',
    `pass: ${passes}   fail: ${fails}   info-only: ${infos}   errors: ${errors}`,
    `tools used: ${tallyText(toolTally)}`,
    `tools failed: ${tallyText(toolFails)}`,
    `voice payloads emitted: ${voices}`,
    `models: ${modelsTouched.size ? [...modelsTouched].join(', ') : '(no LLM turns)'}`,
    `mean LLM turn: ${meanMs}ms · p95: ${p95}ms · total LLM time: ${formatDuration(totalLlmMs)}`,
    `tokens: ${totalPromptTokens} prompt + ${totalCompletionTokens} completion`,
    `total wall time: ${formatDuration(ctx.finishedAt - ctx.startedAt)}`,
  ].join('\n');
}

export function renderMarkdown(records: TurnRecord[], ctx: ReportContext): string {
  const lines: string[] = [];
  lines.push('# Gurney ability test report');
  lines.push('');
  lines.push(`- Started: ${new Date(ctx.startedAt).toISOString()}`);
  lines.push(`- Finished: ${new Date(ctx.finishedAt).toISOString()}`);
  lines.push(`- Tier: \`${ctx.tier}\``);
  if (ctx.filter) lines.push(`- Filter: \`${ctx.filter}\``);
  lines.push(`- Chat id: \`${ctx.chatId}\``);
  lines.push(
    `- **No cleanup** — events, tasks, reminders and quiet windows the model created are still present.`,
  );
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| status | id | ability | tools | ms | message → reply |');
  lines.push('|---|---|---|---|---:|---|');
  for (const r of records) {
    const status = `${STATUS_MARK[r.status]} ${r.status}`;
    const tools = r.toolsCalled.map((t) => (t.ok ? t.name : `${t.name}✗`)).join(', ') || '—';
    const msg = mdEscape(truncateOneLine(r.test.message, 160));
    const reply = mdEscape(
      truncateOneLine(r.error ?? r.reply ?? r.interceptReplies.join(' | '), 240),
    );
    lines.push(
      `| ${status} | \`${r.test.id}\` | ${r.test.ability} | ${tools} | ${r.elapsedMs} | **>** ${msg}<br>**<** ${reply} |`,
    );
  }
  lines.push('');
  lines.push('## Details');
  lines.push('');
  for (const r of records) {
    lines.push(`### ${STATUS_MARK[r.status]} \`${r.test.id}\` — ${r.test.ability}`);
    lines.push('');
    lines.push(
      `- kind: \`${r.test.kind}\` · tier: \`${r.test.tier}\` · source: \`${r.test.source}\``,
    );
    lines.push(`- elapsed: ${r.elapsedMs}ms`);
    if (r.model) lines.push(`- model: \`${r.model}\``);
    if (r.promptTokens !== undefined || r.completionTokens !== undefined) {
      lines.push(
        `- tokens: ${r.promptTokens ?? '?'} prompt + ${r.completionTokens ?? '?'} completion`,
      );
    }
    if (r.toolsCalled.length) {
      lines.push(
        `- tools: ${r.toolsCalled.map((t) => (t.ok ? t.name : `${t.name} (failed)`)).join(', ')}`,
      );
    }
    if (r.voiceEmitted) lines.push('- 🔊 voice payload emitted');
    if (r.notes.length) lines.push(`- notes: ${r.notes.join('; ')}`);
    lines.push('');
    lines.push('```');
    lines.push(`> ${r.test.message}`);
    for (const ir of r.interceptReplies) lines.push(`↪ ${ir}`);
    if (r.reply) lines.push(`< ${r.reply}`);
    if (r.error) lines.push(`! ${r.error}`);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Summary');
  lines.push('');
  lines.push('```');
  lines.push(renderSummary(records, ctx));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function tallyText(m: Map<string, number>): string {
  if (m.size === 0) return 'none';
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(', ');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
