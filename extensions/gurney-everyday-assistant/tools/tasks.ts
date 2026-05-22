import type { Host } from '../../../src/core/extensions.js';
import {
  findTaskByTitle,
  formatTask,
  friendlyTaskError,
  getClient,
  normalizeDue,
} from '../helpers/tasks.js';
import type { TasksClient } from '../api/tasks.js';

const NOT_CONFIGURED =
  'Google Tasks is not configured. Run `gurney auth gurney-everyday-assistant`.';

const TASK_LIST_INTENT =
  '\\b(list|show|review|check|what|whats|which)\\b.*\\b(task|tasks|todo|todos|to-do|to do|get done|need to do)\\b|^\\s*(tasks|todos|to-dos)\\s*\\??\\s*$';
const TASK_ADD_INTENT =
  '\\b(add|create|new|set|make|put)\\b(?!.*\\b(event|meeting|appointment|calendar|reminder|alarm|timer)\\b).*\\b(task|tasks|todo|todos|to-do|to do|list)\\b|\\b(need to|remember to)\\b(?!.*\\b(at|in \\d+\\s*(minutes?|hours?|days?))\\b)|\\b(task|todo|to-do)\\s*:';
const TASK_DONE_INTENT = '\\b(done|complete|completed|finish|finished|check off|mark.*done|did)\\b';
const TASK_DELETE_INTENT = '\\b(delete|remove|abandon|drop|cancel).*(task|todo|to-do|to do)\\b';
const TASK_LISTS_INTENT = '\\b(task lists?|google task lists?)\\b';

async function resolveTaskId(
  client: TasksClient,
  args: { task_id?: string; task_title?: string; tasklist_id?: string },
  verb: 'complete' | 'delete',
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (args.task_id?.trim()) {
    return { ok: true, id: args.task_id.trim() };
  }
  if (!args.task_title?.trim()) {
    return {
      ok: false,
      message: `To ${verb} a task, pass either task_title (preferred) or task_id.`,
    };
  }
  const match = await findTaskByTitle(client, args.task_title, args.tasklist_id, true);
  if (match.kind === 'none') {
    return { ok: false, message: `No task matching "${args.task_title}".` };
  }
  if (match.kind === 'many') {
    const titles = match.matches.map((t) => `• ${t.title}`).join('\n');
    return {
      ok: false,
      message:
        `"${args.task_title}" matches ${match.matches.length} tasks — ` +
        `ask the user which one, or pass task_id:\n${titles}`,
    };
  }
  return { ok: true, id: match.task.id };
}

export function register(host: Host): void {
  host.tools.register({
    name: 'tasks_list',
    intentPattern: TASK_LIST_INTENT,
    description:
      'List Google Tasks (TODOs, action items, things to do). ' +
      "Use when the user asks 'what are my tasks', 'what's on my todo list', 'what do I need to do'. " +
      'Do NOT use this for calendar events/appointments (use `calendar_list_events`) or for one-shot timed reminders (use `reminder_list`). ' +
      'Defaults to incomplete tasks only. ' +
      'You do NOT need to call this before tasks_complete/tasks_delete — those tools accept task_title directly.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        show_completed: {
          type: 'boolean',
          description:
            "Include completed tasks. Default false. Set true only if the user explicitly asks 'show completed'.",
        },
        tasklist_id: {
          type: 'string',
          description:
            "Specific task list id from `tasks_list_tasklists`. Omit to use the user's default list.",
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      try {
        const a = args as { show_completed?: boolean; tasklist_id?: string };
        const tasks = await c.listTasks(a.show_completed ?? false, a.tasklist_id);
        if (tasks.length === 0) return 'No tasks.';
        return tasks.map((t) => formatTask(t, { includeId: true })).join('\n');
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_add',
    intentPattern: TASK_ADD_INTENT,
    description:
      "Record a NEW todo on the user's Google Tasks list. " +
      "This is the DEFAULT for 'add X to my list', 'add X to my todos', 'put X on my list', 'set a todo/task X', 'I need to X', 'remember to X' (no specific firing time). " +
      'Always call this — never reply that no tool is available for adding a task. ' +
      "Your job is to RECORD X — copy the user's words into `title`. Do NOT perform X, do not rephrase X as a plan, do not reply with a description of the task. Just call the tool.",
    tier: 'auto',
    selfReplying: true,
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Short task title, e.g. "Buy milk", "Call dentist", "Submit Q2 report".',
        },
        notes: {
          type: 'string',
          description: 'Optional longer notes/description body.',
        },
        due: {
          type: 'string',
          description:
            'Optional due date. Accepts "YYYY-MM-DD" (preferred) or full ISO 8601. Pass ONLY when the user explicitly named a deadline. Omit when the user did not name a deadline.',
        },
        tasklist_id: {
          type: 'string',
          description: 'Task list id (omit for the default list).',
        },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { title: string; notes?: string; due?: string; tasklist_id?: string };
      if (!a.title?.trim()) return 'tasks_add requires a non-empty title.';
      let normalizedDue: string | undefined;
      try {
        normalizedDue = a.due?.trim() ? normalizeDue(a.due) : undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      try {
        const t = await c.addTask({
          title: a.title.trim(),
          ...(a.notes ? { notes: a.notes } : {}),
          ...(normalizedDue ? { due: normalizedDue } : {}),
          ...(a.tasklist_id ? { tasklistId: a.tasklist_id } : {}),
        });
        return `Added: ${formatTask(t)}`;
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_complete',
    intentPattern: TASK_DONE_INTENT,
    description:
      'Mark a Google Task as DONE. ' +
      "Use when the user says 'I finished X', 'mark X done', 'check off X'. " +
      'Pass `task_title` (the task name or a unique substring — preferred) OR `task_id` from a prior `tasks_list` call.',
    tier: 'auto',
    parameters: {
      type: 'object',
      properties: {
        task_title: {
          type: 'string',
          description: 'The task name or a unique substring (case-insensitive). Preferred.',
        },
        task_id: {
          type: 'string',
          description: 'Opaque task id from `tasks_list` output. Use only when title is ambiguous.',
        },
        tasklist_id: { type: 'string', description: 'Task list id (omit for default).' },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { task_id?: string; task_title?: string; tasklist_id?: string };
      try {
        const r = await resolveTaskId(c, a, 'complete');
        if (!r.ok) return r.message;
        await c.completeTask(r.id, a.tasklist_id);
        return 'Task marked as completed.';
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_delete',
    intentPattern: TASK_DELETE_INTENT,
    description:
      'Permanently delete a Google Task. ' +
      "Use only when the user wants to ABANDON a task (not finish it). For 'I did X', use `tasks_complete` instead. " +
      'Tier is `confirm`, so the user re-confirms before the delete fires.',
    tier: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        task_title: {
          type: 'string',
          description: 'The task name or a unique substring (case-insensitive). Preferred.',
        },
        task_id: { type: 'string', description: 'Task id from `tasks_list`.' },
        tasklist_id: { type: 'string', description: 'Task list id (omit for default).' },
      },
    },
    invoke: async (args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      const a = args as { task_id?: string; task_title?: string; tasklist_id?: string };
      try {
        const r = await resolveTaskId(c, a, 'delete');
        if (!r.ok) return r.message;
        await c.deleteTask(r.id, a.tasklist_id);
        return 'Task deleted.';
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });

  host.tools.register({
    name: 'tasks_list_tasklists',
    intentPattern: TASK_LISTS_INTENT,
    description:
      'List all available Google Task lists. ' +
      "Rarely needed — only call this if the user explicitly asks 'what task lists do I have'.",
    tier: 'auto',
    parameters: { type: 'object', properties: {} },
    invoke: async (_args, ctx) => {
      const c = getClient(host, ctx.signal);
      if (!c) return NOT_CONFIGURED;
      try {
        const lists = await c.listTaskLists();
        if (lists.length === 0) return 'No task lists found.';
        return lists.map((l) => `[${l.id}] ${l.title}`).join('\n');
      } catch (e) {
        return friendlyTaskError(e);
      }
    },
  });
}
