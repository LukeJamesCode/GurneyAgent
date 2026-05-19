// Thin Google Tasks v1 client. Direct fetch — no SDK. Handles access-token
// refresh from a long-lived refresh token, same pattern as api/calendar.ts.

export interface TasksCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  default_tasklist: string;
}

export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string; // RFC 3339
  status: 'needsAction' | 'completed';
  completed?: string; // RFC 3339
  position?: string;
}

export interface TaskList {
  id: string;
  title: string;
}

export interface TasksAccessTokenCache {
  token: string;
  expiresAt: number;
}

export class TasksApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TasksApiError';
  }
}

interface FetchLike {
  (
    input: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export interface TasksClientOptions {
  creds: TasksCredentials;
  fetchImpl?: FetchLike;
  cache?: { current: TasksAccessTokenCache | null };
  now?: () => number;
  signal?: AbortSignal;
}

export function createTasksClient(opts: TasksClientOptions) {
  const fetchImpl = (opts.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike;
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? { current: null };

  async function getAccessToken(): Promise<string> {
    if (cache.current && cache.current.expiresAt - now() > 30_000) {
      return cache.current.token;
    }
    const body = new URLSearchParams({
      client_id: opts.creds.client_id,
      client_secret: opts.creds.client_secret,
      refresh_token: opts.creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) {
      throw new TasksApiError(res.status, `token refresh failed (${res.status})`);
    }
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cache.current = { token: j.access_token, expiresAt: now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async function api(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await getAccessToken();
    const url = `https://tasks.googleapis.com/tasks/v1${path}`;
    const init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {
      method,
      headers: { authorization: `Bearer ${token}` },
    };
    if (opts.signal) {
      init.signal = opts.signal;
    }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(url, init);
    if (!res.ok) {
      throw new TasksApiError(res.status, `tasks ${method} ${path} failed (${res.status})`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }

  function flattenTask(t: GoogleTask): Task {
    return {
      id: t.id,
      title: t.title ?? '(no title)',
      ...(t.notes ? { notes: t.notes } : {}),
      ...(t.due ? { due: t.due } : {}),
      status: t.status ?? 'needsAction',
      ...(t.completed ? { completed: t.completed } : {}),
      ...(t.position ? { position: t.position } : {}),
    };
  }

  const listId = () => encodeURIComponent(opts.creds.default_tasklist);

  return {
    async listTaskLists(): Promise<TaskList[]> {
      const j = (await api('GET', '/users/@me/lists')) as {
        items?: Array<{ id: string; title: string }>;
      };
      return (j.items ?? []).map((l) => ({ id: l.id, title: l.title }));
    },

    async listTasks(showCompleted = false, tasklistId?: string): Promise<Task[]> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const all: Task[] = [];
      let pageToken: string | undefined;
      // Cap at 5 pages × 100 = 500 tasks. Anything beyond that is a power user
      // who should be using Google's own UI; we don't want a runaway loop.
      for (let pages = 0; pages < 5; pages++) {
        const params = new URLSearchParams({
          showCompleted: String(showCompleted),
          showHidden: 'false',
          maxResults: '100',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const j = (await api('GET', `/lists/${lid}/tasks?${params.toString()}`)) as {
          items?: GoogleTask[];
          nextPageToken?: string;
        };
        for (const t of j.items ?? []) all.push(flattenTask(t));
        if (!j.nextPageToken) break;
        pageToken = j.nextPageToken;
      }
      return all;
    },

    async addTask(opts2: {
      title: string;
      notes?: string;
      due?: string;
      tasklistId?: string;
    }): Promise<Task> {
      const lid = opts2.tasklistId ? encodeURIComponent(opts2.tasklistId) : listId();
      const body: Record<string, unknown> = { title: opts2.title };
      if (opts2.notes) body['notes'] = opts2.notes;
      if (opts2.due) body['due'] = opts2.due;
      const j = (await api('POST', `/lists/${lid}/tasks`, body)) as GoogleTask;
      return flattenTask(j);
    },

    async completeTask(taskId: string, tasklistId?: string): Promise<Task> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const tid = encodeURIComponent(taskId);
      const j = (await api('PATCH', `/lists/${lid}/tasks/${tid}`, {
        status: 'completed',
      })) as GoogleTask;
      return flattenTask(j);
    },

    async deleteTask(taskId: string, tasklistId?: string): Promise<void> {
      const lid = tasklistId ? encodeURIComponent(tasklistId) : listId();
      const tid = encodeURIComponent(taskId);
      await api('DELETE', `/lists/${lid}/tasks/${tid}`);
    },
  };
}

export type TasksClient = ReturnType<typeof createTasksClient>;

interface GoogleTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
  completed?: string;
  position?: string;
}
