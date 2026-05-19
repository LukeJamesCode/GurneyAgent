// Context manager. Builds the prompt the LLM sees from a deterministic order
// of sections so Ollama's KV slot cache stays warm:
//
//     system  ->  tools  ->  memory  ->  session  ->  history
//
// Per PLAN North Star "Deterministic prompt prefix". Anything before history
// is the stable prefix; drift there invalidates the cache for the rest of
// the conversation, so the order never changes.
//
// Token counting is approximate by design: real tokenization is
// model-specific and Ollama doesn't expose its tokenizer. ~4 chars per token
// is a workable upper bound for qwen3-class models. The orchestrator tightens
// this with the real prompt_tokens count Ollama returns after each turn.

import type { ChatMessage, Role } from './llm.js';

export interface HistoryMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface BuildOptions {
  systemPrompt: string;
  // Natural-language tool fragment (e.g. an extension's prompt.md). The
  // OpenAI-shaped tool schemas go into ChatOptions.tools, not here.
  toolPrompt?: string;
  // Long-term memory results retrieved for this turn (populated by whichever
  // extension is providing memory; e.g. gurney-memgraph when it lands).
  memory?: string;
  // Compact running session summary kept between turns.
  session?: string;
  history: HistoryMessage[];
  // Approx max tokens the assembled prompt may consume. Older history is
  // dropped first to fit; the newest user turn is always preserved.
  budgetTokens: number;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  approxTokens: number;
  truncated: boolean;
}

export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function build(opts: BuildOptions): BuiltPrompt {
  const prefixParts: string[] = [];
  if (opts.systemPrompt) prefixParts.push(opts.systemPrompt);
  if (opts.toolPrompt) prefixParts.push(opts.toolPrompt);
  if (opts.memory) prefixParts.push(opts.memory);
  if (opts.session) prefixParts.push(opts.session);

  const SAFETY = 64;
  const prefixText = prefixParts.join('\n\n');
  const prefixTokens = approxTokens(prefixText) + SAFETY;

  const history = [...opts.history];
  let pinnedIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'user') {
      pinnedIdx = i;
      break;
    }
  }

  const tokensOf = (m: HistoryMessage): number => approxTokens(m.content);
  // Maintain a running total so each shift is O(1); the previous reduce-on-
  // every-iteration was O(n²) when truncating long histories.
  let historyTokens = 0;
  for (const m of history) historyTokens += tokensOf(m);

  let truncated = false;
  // Drop oldest entries until total fits, but never drop the pinned message.
  while (prefixTokens + historyTokens > opts.budgetTokens && history.length > 0) {
    // The pinned index shifts as we drop from the front.
    if (pinnedIdx === 0) break;
    const dropped = history.shift()!;
    historyTokens -= tokensOf(dropped);
    pinnedIdx -= 1;
    truncated = true;
  }

  const messages: ChatMessage[] = [];
  if (prefixText) messages.push({ role: 'system', content: prefixText });
  for (const h of history) {
    const m: ChatMessage = { role: h.role, content: h.content };
    if (h.tool_call_id) m.tool_call_id = h.tool_call_id;
    if (h.tool_name) m.tool_name = h.tool_name;
    messages.push(m);
  }

  return {
    messages,
    approxTokens: prefixTokens + historyTokens,
    truncated,
  };
}
