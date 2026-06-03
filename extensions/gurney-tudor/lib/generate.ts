// The generation layer: turn prompts into parsed course pieces.
//
// Two things matter for a CPU/qwen-native host:
//   1. Calls are serialised process-wide (withLock). Course generation fires
//      many model calls; letting them overlap would thrash the single heavy
//      model slot and the Pi's CPU. One at a time is both faster end-to-end and
//      kinder to a box that's also answering Telegram.
//   2. Every parse gets one repair retry before we fall back, because small
//      models occasionally drift from the format on the first try.

import type { ChatMessage, LLM, ProfileName } from '../../../src/core/llm.js';
import type { Logger } from '../../../src/util/log.js';
import type { Depth, Generator, ParsedLesson, ParsedOutline } from './types.js';
import { parseLesson, parseOutline, stripThink } from './parse.js';
import {
  LESSON_SYSTEM,
  OUTLINE_SYSTEM,
  REPHRASE_SYSTEM,
  VISUALIZATION_SYSTEM,
  lessonUser,
  outlineUser,
  rephraseUser,
  visualizationUser,
} from './prompts.js';

// Process-wide lock so all Tudor inference runs strictly one call at a time.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// A model reference plus a local fallback to switch to if the primary (codex)
// fails part-way through a course.
export interface ModelChoice {
  ref: ProfileName | { model: string };
  label: string;
  fallback: ProfileName;
}

function bestLocalProfile(llm: LLM): ProfileName {
  const p = llm.listProfiles();
  if (p.reason) return 'reason';
  if (p.tools) return 'tools';
  return 'chat';
}

export function chooseModel(llm: LLM, generator: Generator, localModel?: string): ModelChoice {
  const fallback = bestLocalProfile(llm);
  if (generator === 'codex') {
    return { ref: { model: 'codex' }, label: 'codex', fallback };
  }
  // An explicit local model tag (e.g. "qwen3.5:7b") wins over the default
  // profile pick, so the learner can choose exactly which model builds a course.
  if (localModel && localModel.trim()) {
    const tag = localModel.trim();
    return { ref: { model: tag }, label: tag, fallback };
  }
  return { ref: fallback, label: llm.resolveModel(fallback), fallback };
}

export function labelFor(llm: LLM, ref: ProfileName | { model: string }): string {
  return typeof ref === 'object' ? ref.model : llm.resolveModel(ref);
}

// Run one chat completion to a single string. Concatenates streamed deltas,
// strips reasoning chatter, and bounds output length defensively. `maxChars` is
// the safety valve; visualisation needs more headroom than text generation, the
// other callers stick with the default.
async function complete(
  llm: LLM,
  ref: ProfileName | { model: string },
  system: string,
  user: string,
  maxTokens: number,
  maxChars = 24_000,
): Promise<string> {
  return withLock(async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let out = '';
    for await (const chunk of llm.chat({ profile: ref, messages, maxTokens, timeoutMs: 10 * 60_000 })) {
      if (chunk.delta) out += chunk.delta;
      if (out.length > maxChars) break; // safety valve against a runaway stream
    }
    return stripThink(out).trim();
  });
}

export async function generateOutline(
  llm: LLM,
  ref: ProfileName | { model: string },
  topic: string,
  depth: Depth,
  log: Logger,
  reference?: string,
): Promise<ParsedOutline> {
  const user = outlineUser(topic, depth, reference);
  const first = await complete(llm, ref, OUTLINE_SYSTEM, user, 700);
  try {
    return parseOutline(first);
  } catch (e) {
    log.warn('tudor: outline parse failed, retrying', {
      error: e instanceof Error ? e.message : String(e),
    });
    const repaired = await complete(
      llm,
      ref,
      OUTLINE_SYSTEM,
      `${user}\n\nYour previous answer did not follow the format. Output ONLY the TITLE/MODULE/SUMMARY/- lines, nothing else.`,
      700,
    );
    return parseOutline(repaired); // throws if still unparseable — caller fails the course
  }
}

export async function generateLesson(
  llm: LLM,
  ref: ProfileName | { model: string },
  args: {
    courseTitle: string;
    moduleTitle: string;
    lessonTitle: string;
    siblingTitles: string[];
    reference?: string;
  },
): Promise<ParsedLesson> {
  const user = lessonUser(args);
  const text = await complete(llm, ref, LESSON_SYSTEM, user, 1100);
  // parseLesson never throws on non-empty input (it falls back to one segment),
  // so no repair pass is needed here — a usable lesson always comes back.
  return parseLesson(text);
}

// Strip a leading/trailing markdown code fence if the model wrapped its HTML
// in one (small local models love to do this despite the instruction).
function stripCodeFences(s: string): string {
  let t = s.trim();
  const open = /^```(?:html|HTML)?\s*\n/;
  if (open.test(t)) {
    t = t.replace(open, '');
    const close = t.lastIndexOf('```');
    if (close !== -1) t = t.slice(0, close).trimEnd();
  }
  // If there's preamble before <!DOCTYPE or <html, drop it.
  const docStart = t.search(/<!DOCTYPE\s+html|<html[\s>]/i);
  if (docStart > 0) t = t.slice(docStart);
  return t.trim();
}

export async function generateVisualization(
  llm: LLM,
  ref: ProfileName | { model: string },
  args: {
    courseTitle: string;
    moduleTitle: string;
    lessonTitle: string;
    lessonBody: string;
  },
): Promise<string> {
  const user = visualizationUser(args);
  const html = await complete(llm, ref, VISUALIZATION_SYSTEM, user, 4000, 80_000);
  const cleaned = stripCodeFences(html);
  if (!/<html|<!DOCTYPE/i.test(cleaned)) {
    throw new Error('visualization model returned no HTML document');
  }
  return cleaned;
}

export async function rephrase(
  llm: LLM,
  ref: ProfileName | { model: string },
  mode: 'simpler' | 'deeper',
  body: string,
  lessonTitle: string,
): Promise<string> {
  const text = await complete(
    llm,
    ref,
    REPHRASE_SYSTEM,
    rephraseUser(mode, body, lessonTitle),
    600,
  );
  return text || body;
}
