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
  lessonUser,
  outlineUser,
  rephraseUser,
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
// strips reasoning chatter, and bounds output length defensively.
async function complete(
  llm: LLM,
  ref: ProfileName | { model: string },
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  return withLock(async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let out = '';
    for await (const chunk of llm.chat({ profile: ref, messages, maxTokens })) {
      if (chunk.delta) out += chunk.delta;
      if (out.length > 24_000) break; // safety valve against a runaway stream
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
