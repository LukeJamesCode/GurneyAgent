// Thin Google Calendar v3 client. Direct fetch — no SDK dependency. Handles
// access-token refresh from the long-lived refresh token; callers pass the
// settings object so we can lazy-refresh and cache the token in memory.

export interface CalendarCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  calendar_id: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  // Timed events use ISO date-times. All-day events use Google Calendar's
  // date-only YYYY-MM-DD values so local rendering does not drift through UTC.
  start: string;
  end: string;
  allDay?: boolean;
  startTimeZone?: string;
  endTimeZone?: string;
  htmlLink?: string;
}

export interface CalendarAccessTokenCache {
  token: string;
  expiresAt: number;
}

export class CalendarApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarApiError';
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

export interface CalendarClientOptions {
  creds: CalendarCredentials;
  fetchImpl?: FetchLike;
  // Pluggable cache so the loader can hand in a single shared cache that
  // survives across calls within a process.
  cache?: { current: CalendarAccessTokenCache | null };
  now?: () => number;
  signal?: AbortSignal;
}

// Transient Google API failures: rate-limited or temporary server errors.
// Anything else (auth, validation, 404) is the caller's bug and shouldn't be
// retried.
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  attempts = 3,
  baseDelayMs = 250,
): Promise<Awaited<ReturnType<FetchLike>>> {
  let last: Awaited<ReturnType<FetchLike>> | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetchImpl(url, init);
    if (!isTransient(res.status) || i === attempts - 1) return res;
    last = res;
    // Light jitter so two concurrent clients don't lock-step into Google's
    // rate limiter.
    const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
    await new Promise((r) => setTimeout(r, delay));
  }
  return last!;
}

export function createCalendarClient(opts: CalendarClientOptions) {
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
      throw new CalendarApiError(res.status, `token refresh failed (${res.status})`);
    }
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cache.current = {
      token: j.access_token,
      expiresAt: now() + j.expires_in * 1000,
    };
    return j.access_token;
  }

  async function api(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await getAccessToken();
    const calId = encodeURIComponent(opts.creds.calendar_id || 'primary');
    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}${path}`;
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
    const res = await fetchWithRetry(fetchImpl, url, init);
    if (!res.ok) {
      throw new CalendarApiError(res.status, `calendar ${method} ${path} failed (${res.status})`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }

  function flatten(ev: GoogleEvent): CalendarEvent {
    const allDay = Boolean(ev.start.date && ev.end.date);
    return {
      id: ev.id,
      summary: ev.summary ?? '(no title)',
      start: ev.start.dateTime ?? ev.start.date ?? '',
      end: ev.end.dateTime ?? ev.end.date ?? '',
      ...(allDay ? { allDay } : {}),
      ...(ev.start.timeZone ? { startTimeZone: ev.start.timeZone } : {}),
      ...(ev.end.timeZone ? { endTimeZone: ev.end.timeZone } : {}),
      ...(ev.htmlLink ? { htmlLink: ev.htmlLink } : {}),
    };
  }

  return {
    async listEvents(opts2: {
      timeMin: string;
      timeMax: string;
      max?: number;
    }): Promise<CalendarEvent[]> {
      const params = new URLSearchParams({
        timeMin: opts2.timeMin,
        timeMax: opts2.timeMax,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(opts2.max ?? 50),
      });
      const j = (await api('GET', `/events?${params.toString()}`)) as {
        items?: GoogleEvent[];
      };
      return (j.items ?? []).map(flatten);
    },
    async addEvent(opts2: {
      summary: string;
      start: string;
      end: string;
      description?: string;
      allDay?: boolean;
    }): Promise<CalendarEvent> {
      const body: Record<string, unknown> = {
        summary: opts2.summary,
        start: opts2.allDay ? { date: opts2.start } : { dateTime: opts2.start },
        end: opts2.allDay ? { date: nextLocalDate(opts2.end) } : { dateTime: opts2.end },
      };
      if (opts2.description) body['description'] = opts2.description;
      const j = (await api('POST', '/events', body)) as GoogleEvent;
      return flatten(j);
    },
    async quickAdd(text: string): Promise<CalendarEvent> {
      const params = new URLSearchParams({ text });
      const j = (await api('POST', `/events/quickAdd?${params.toString()}`)) as GoogleEvent;
      return flatten(j);
    },
    async deleteEvent(id: string): Promise<void> {
      await api('DELETE', `/events/${encodeURIComponent(id)}`);
    },
  };
}

export type CalendarClient = ReturnType<typeof createCalendarClient>;

function nextLocalDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + 1);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

interface GoogleEvent {
  id: string;
  summary?: string;
  htmlLink?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
}
