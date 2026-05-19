// One-shot Ollama probes used by the CLI. These don't go through the LLM
// interface because the CLI runs without a logger / circuit breaker / profile
// table — it just wants to know whether the server is up and which models it
// has.

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export async function probeOllama(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/api/tags`);
    if (!res.ok) {
      return { ok: false, models: [], error: `http ${res.status}` };
    }
    const j = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, models: (j.models ?? []).map((m) => m.name) };
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
  }
}
