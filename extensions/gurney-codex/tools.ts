// codex_handoff — the escalation tool the local Qwen model calls when a task is
// beyond what it can do at quality (real coding, multi-file refactors, hard
// debugging). It runs at the `confirm` tier: every call pops a Yes/No prompt in
// the chat (via core's confirm hook) so Codex quota is never spent without the
// user's say-so. On top of that, the daily budget ceiling in lib/budget.ts and
// the deliberately narrow prompt fragment bound how often the model reaches for
// it. The result comes back as a tool message and the local model summarises it
// (per the chosen "summary via qwen" reply mode), so this tool is NOT
// self-replying.

import type { Host } from '../../src/core/extensions.js';
import { runHandoff } from './lib/run.js';

// One-line, human-readable summary of `task` for the confirm prompt.
function previewTask(args: Record<string, unknown>): string {
  const task = typeof args['task'] === 'string' ? (args['task'] as string).trim() : '';
  const oneLine = task.replace(/\s+/g, ' ');
  const clipped = oneLine.length > 160 ? oneLine.slice(0, 157) + '…' : oneLine;
  return `Spend a Codex call on:\n“${clipped || '(no task given)'}”?`;
}

const HANDOFF_INTENT =
  '\\b(code|coding|refactor\\w*|implement\\w*|debug\\w*|rewrite|optimi[sz]e|function|method|class|script|program|regex|algorithm|stack ?trace|traceback|exception|unit ?tests?|write.{0,15}(function|method|class|script|test|program|app|module)|fix.{0,20}(bug|error|crash|test|build|code|function))\\b';

export function register(host: Host): void {
  host.tools.register({
    name: 'codex_handoff',
    intentPattern: HANDOFF_INTENT,
    description:
      'Escalate a HARD coding task to Codex (a powerful remote model) and return its full answer. ' +
      'Use ONLY when the user wants code produced, fixed, or refactored AND the job is too large or hard to do well locally — ' +
      'e.g. it needs more than ~80 lines of code, spans multiple files/functions, or requires careful debugging. ' +
      'Do NOT use for explanations, one-line snippets, definitions, or any non-coding request — answer those yourself. ' +
      'Each call spends from a small daily budget and asks the user to confirm, so reserve it for tasks you genuinely cannot do at quality.',
    tier: 'confirm',
    confirmPrompt: previewTask,
    // Codex can take a while; give it generous headroom over the default tool
    // timeout. The actual network deadline is enforced inside callCodex via the
    // request_timeout_ms setting. Note the confirm prompt's own wait is
    // separate (CONFIRM_TIMEOUT_MS in the Telegram adapter).
    timeoutMs: 180_000,
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description:
            'A clear, self-contained brief of what to build/fix/refactor. Codex cannot see this chat — restate everything it needs.',
        },
        context: {
          type: 'string',
          description:
            'Optional. Paste the relevant existing code, error messages, file contents, or constraints from the conversation so Codex has what it needs.',
        },
        success_criteria: {
          type: 'string',
          description:
            'Optional. How you will judge the answer is correct (e.g. "compiles, handles empty input, has tests").',
        },
      },
    },
    invoke: async (args, ctx) => {
      const a = args as { task?: string; context?: string; success_criteria?: string };
      const task = a.task?.trim();
      if (!task) {
        return 'codex_handoff needs a `task` describing what to build or fix. Re-call with a clear, self-contained brief.';
      }

      const input: Parameters<typeof runHandoff>[1] = { task, source: 'tool' };
      if (a.context?.trim()) input.context = a.context.trim();
      if (a.success_criteria?.trim()) input.successCriteria = a.success_criteria.trim();
      if (ctx.chatId !== undefined) input.chatId = ctx.chatId;
      if (ctx.signal) input.signal = ctx.signal;

      const outcome = await runHandoff(host, input);
      if (!outcome.ok) {
        // Both denied and failed outcomes return a plain message; the local
        // model relays it to the user.
        return outcome.message;
      }
      const u = outcome.result;
      const usage =
        u.promptTokens !== undefined || u.completionTokens !== undefined
          ? ` (Codex tokens: ${u.promptTokens ?? '?'} in / ${u.completionTokens ?? '?'} out)`
          : '';
      return `Codex completed the task.${usage}\n\n${u.text}`;
    },
  });
}
