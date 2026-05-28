// Codex backend client. Calls the ChatGPT Codex Responses API with the OAuth
// access token + chatgpt-account-id header — the same surface the Codex CLI
// uses when authenticated with a ChatGPT subscription. We request a
// non-streaming response and parse the final text out; Gurney's local model
// summarises it for the user, so there's nothing to stream live.

import { randomUUID } from 'node:crypto';

export interface CodexRequest {
  baseUrl: string;
  accessToken: string;
  accountId: string | null;
  model: string;
  // Fully-composed prompt (task + optional context + success criteria).
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface CodexResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class CodexApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CodexApiError';
  }
}

// System instructions handed to Codex for a Gurney handoff. Codex is the
// heavy-lifter; we ask it to be self-contained and explicit because its answer
// is consumed by a tiny local model that can't fill in gaps.
const INSTRUCTIONS =
  'You are Codex, a senior software engineer working as a sub-agent for a small local assistant. ' +
  'You are handed tasks the local model could not do well — usually writing, fixing, or refactoring code. ' +
  'Produce a complete, correct, self-contained answer. Include full code (not snippets-with-ellipses) when code is requested, ' +
  'and a short plain-language explanation of what you did and any assumptions. Do not ask clarifying questions; ' +
  'make reasonable assumptions and state them.';

interface ResponsesApiOutputContent {
  type?: string;
  text?: string;
}
interface ResponsesApiOutputItem {
  type?: string;
  content?: ResponsesApiOutputContent[];
}
interface ResponsesApiResponse {
  output_text?: string | string[];
  output?: ResponsesApiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
}

// Pull the assistant text out of a Responses API payload. Handles both the
// `output_text` convenience field and the structured `output[].content[]` form.
export function extractText(json: ResponsesApiResponse): string {
  if (typeof json.output_text === 'string' && json.output_text.trim()) {
    return json.output_text.trim();
  }
  if (Array.isArray(json.output_text)) {
    const joined = json.output_text.join('').trim();
    if (joined) return joined;
  }
  if (Array.isArray(json.output)) {
    const parts: string[] = [];
    for (const item of json.output) {
      if (!item?.content) continue;
      for (const c of item.content) {
        if (
          (c.type === 'output_text' || c.type === 'text' || !c.type) &&
          typeof c.text === 'string'
        ) {
          parts.push(c.text);
        }
      }
    }
    const joined = parts.join('').trim();
    if (joined) return joined;
  }
  return '';
}

export async function callCodex(req: CodexRequest): Promise<CodexResult> {
  const fetchImpl = req.fetchImpl ?? fetch;

  // Compose the caller's signal with our own timeout so a hung backend can't
  // pin the user queue forever.
  const timeoutCtl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtl.abort(), req.timeoutMs);
  timeoutId.unref?.();
  const signal = req.signal ? anySignal(req.signal, timeoutCtl.signal) : timeoutCtl.signal;

  const headers: Record<string, string> = {
    authorization: `Bearer ${req.accessToken}`,
    'content-type': 'application/json',
    // Codex CLI parity headers. The account id binds the request to the
    // ChatGPT subscription that should be billed.
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: randomUUID(),
  };
  if (req.accountId) headers['chatgpt-account-id'] = req.accountId;

  const body = {
    model: req.model,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: req.prompt }],
      },
    ],
    max_output_tokens: req.maxOutputTokens,
    stream: false,
    store: false,
  };

  let res: Response;
  try {
    res = await fetchImpl(`${req.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new CodexApiError(res.status, `Codex responded ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as ResponsesApiResponse;
  if (json.error?.message) {
    throw new CodexApiError(200, `Codex returned an error: ${json.error.message}`);
  }
  const text = extractText(json);
  if (!text) throw new CodexApiError(200, 'Codex returned an empty response');

  const result: CodexResult = { text };
  const pt = json.usage?.input_tokens ?? json.usage?.prompt_tokens;
  const ct = json.usage?.output_tokens ?? json.usage?.completion_tokens;
  if (typeof pt === 'number') result.promptTokens = pt;
  if (typeof ct === 'number') result.completionTokens = ct;
  return result;
}

// Lightweight token check used by the auth flow to catch the "identity-only
// scope" trap (OpenClaw #29418): a token that authenticates but can't reach the
// Codex backend. Returns the HTTP status so the caller can message precisely.
export async function probeAccess(opts: {
  baseUrl: string;
  accessToken: string;
  accountId: string | null;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const result = await callCodex({
      baseUrl: opts.baseUrl,
      accessToken: opts.accessToken,
      accountId: opts.accountId,
      model: opts.model,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 16,
      timeoutMs: 30_000,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    return { ok: true, status: 200, detail: result.text.slice(0, 80) };
  } catch (e) {
    if (e instanceof CodexApiError) {
      return { ok: false, status: e.status, detail: e.message };
    }
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

// Combine signals without depending on AbortSignal.any (Node 20 has it, but
// being explicit keeps the floor low and the intent obvious).
function anySignal(...signals: AbortSignal[]): AbortSignal {
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}
