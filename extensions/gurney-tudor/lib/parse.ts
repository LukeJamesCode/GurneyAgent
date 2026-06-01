// Deterministic parsers for the model's output.
//
// We deliberately do NOT ask small local models for nested JSON — a 0.8B/2B
// model gets that wrong often enough to ruin the experience. Instead the prompts
// ask for a flat, line-tagged format that is trivial to emit and bulletproof to
// parse, and every parser degrades gracefully (a lesson with no recognised
// markers still becomes one readable segment rather than an error).

import type {
  ParsedLesson,
  ParsedOutline,
  ParsedQuiz,
  ParsedSegment,
  SegmentKind,
} from './types.js';
import { SEGMENT_KINDS } from './types.js';

const MAX_MODULES = 6;
const MAX_LESSONS_PER_MODULE = 6;
const MAX_SEGMENTS = 8;
const MAX_QUIZ = 3;

// Strip Qwen3-style <think> blocks and any stray /no_think hint so reasoning
// chatter never leaks into a lesson body or breaks the parser.
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/^\s*\/no_think\s*$/gim, '')
    .trim();
}

// Drop a single pair of wrapping ``` fences if the model wrapped its whole
// answer in a code block (common with chat-tuned models).
function stripOuterFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i.exec(t);
  return m ? m[1]!.trim() : t;
}

const TITLE_RE = /^title\s*[:-]\s*(.+)$/i;
const MODULE_RE = /^module\s*\d*\s*[:-]\s*(.+)$/i;
const SUMMARY_RE = /^summary\s*[:-]\s*(.+)$/i;
const BULLET_RE = /^(?:[-*•]|\d+[.)])\s+(.+)$/;

function cleanTitle(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

// Parse the syllabus. Tolerant of missing TITLE, missing SUMMARY lines, and a
// flat bullet list with no MODULE headers (which becomes a single module).
export function parseOutline(raw: string): ParsedOutline {
  const text = stripOuterFence(stripThink(raw));
  let title = '';
  const modules: ParsedOutline['modules'] = [];
  const loose: string[] = []; // bullets seen before any MODULE header
  let cur: ParsedOutline['modules'][number] | null = null;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const titleM = TITLE_RE.exec(t);
    if (titleM && !title) {
      title = cleanTitle(titleM[1]!);
      continue;
    }
    const modM = MODULE_RE.exec(t);
    if (modM) {
      cur = { title: cleanTitle(modM[1]!), summary: '', lessons: [] };
      modules.push(cur);
      continue;
    }
    const sumM = SUMMARY_RE.exec(t);
    if (sumM && cur && !cur.summary) {
      cur.summary = cleanTitle(sumM[1]!);
      continue;
    }
    const bulletM = BULLET_RE.exec(t);
    if (bulletM) {
      const lessonTitle = cleanTitle(bulletM[1]!);
      if (!lessonTitle) continue;
      if (cur) cur.lessons.push(lessonTitle);
      else loose.push(lessonTitle);
    }
  }

  // No MODULE headers but we did collect bullets -> one module course.
  if (modules.length === 0 && loose.length > 0) {
    modules.push({ title: title || 'Course', summary: '', lessons: loose });
  }

  const cleaned = modules
    .map((m) => ({
      title: m.title,
      summary: m.summary,
      lessons: dedupe(m.lessons).slice(0, MAX_LESSONS_PER_MODULE),
    }))
    .filter((m) => m.title && m.lessons.length > 0)
    .slice(0, MAX_MODULES);

  if (cleaned.length === 0) {
    throw new Error('could not parse any modules/lessons from the outline');
  }
  return { title: title || cleaned[0]!.title, modules: cleaned };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function normaliseKind(raw: string): SegmentKind {
  const k = raw.toLowerCase().trim();
  if ((SEGMENT_KINDS as readonly string[]).includes(k)) return k as SegmentKind;
  if (k.startsWith('intro') || k.startsWith('concept') || k.startsWith('explain')) return 'explain';
  if (k.startsWith('exam') || k.startsWith('demo')) return 'example';
  if (k.startsWith('analog') || k.startsWith('metaphor')) return 'analogy';
  if (k.startsWith('key') || k.startsWith('summary') || k.startsWith('recap')) return 'keypoints';
  if (k.startsWith('check') || k.startsWith('try') || k.startsWith('practice')) return 'checkpoint';
  if (k.startsWith('warn') || k.startsWith('pitfall') || k.startsWith('gotcha')) return 'warning';
  return 'explain';
}

const SEGMENT_RE = /^segment\s*[:-]\s*(.+)$/i;
const QUIZ_RE = /^quiz\s*[:-]?\s*$/i;
const Q_RE = /^q\s*\d*\s*[:-]\s*(.+)$/i;
const CORRECT_RE = /^correct\s*[:-]\s*(.+)$/i;
const WHY_RE = /^(?:why|because|explain)\s*[:-]\s*(.+)$/i;

// Resolve "B", "2", "(b)", "option 2" -> 0-based index into the choices list.
function resolveAnswer(raw: string, choiceCount: number): number {
  const t = raw.trim();
  const letter = /([a-z])/i.exec(t);
  const digit = /(\d+)/.exec(t);
  if (digit) {
    const n = Number.parseInt(digit[1]!, 10) - 1;
    if (n >= 0 && n < choiceCount) return n;
  }
  if (letter) {
    const n = letter[1]!.toLowerCase().charCodeAt(0) - 97;
    if (n >= 0 && n < choiceCount) return n;
  }
  return 0;
}

// Parse a lesson body. Falls back to a single explain segment when the model
// ignored the SEGMENT markers, so a lesson is always at least readable.
export function parseLesson(raw: string): ParsedLesson {
  const text = stripOuterFence(stripThink(raw));
  if (!text) throw new Error('empty lesson body');

  const segments: ParsedSegment[] = [];
  const quiz: ParsedQuiz[] = [];
  let mode: 'seg' | 'quiz' = 'seg';
  let curSeg: { kind: SegmentKind; lines: string[] } | null = null;
  let curQ: { question: string; choices: string[]; answer: string; why: string } | null = null;

  const flushSeg = (): void => {
    if (curSeg) {
      const body = curSeg.lines.join('\n').trim();
      if (body) segments.push({ kind: curSeg.kind, body });
      curSeg = null;
    }
  };
  const flushQ = (): void => {
    if (curQ && curQ.question && curQ.choices.length >= 2) {
      quiz.push({
        question: curQ.question,
        choices: curQ.choices.slice(0, 6),
        answerIdx: resolveAnswer(curQ.answer, curQ.choices.length),
        why: curQ.why,
      });
    }
    curQ = null;
  };

  for (const line of text.split('\n')) {
    const t = line.trim();
    const segM = SEGMENT_RE.exec(t);
    if (segM) {
      flushSeg();
      mode = 'seg';
      curSeg = { kind: normaliseKind(segM[1]!), lines: [] };
      continue;
    }
    if (QUIZ_RE.test(t)) {
      flushSeg();
      mode = 'quiz';
      continue;
    }
    if (mode === 'quiz') {
      const qM = Q_RE.exec(t);
      if (qM) {
        flushQ();
        curQ = { question: cleanTitle(qM[1]!), choices: [], answer: '', why: '' };
        continue;
      }
      const correctM = CORRECT_RE.exec(t);
      if (correctM && curQ) {
        curQ.answer = correctM[1]!;
        continue;
      }
      const whyM = WHY_RE.exec(t);
      if (whyM && curQ) {
        curQ.why = cleanTitle(whyM[1]!);
        continue;
      }
      const bulletM = BULLET_RE.exec(t);
      if (bulletM && curQ) {
        curQ.choices.push(cleanTitle(bulletM[1]!));
        continue;
      }
      continue;
    }
    // segment body line
    if (curSeg) curSeg.lines.push(line);
    else if (t) curSeg = { kind: 'explain', lines: [line] };
  }
  flushSeg();
  flushQ();

  if (segments.length === 0) {
    // No markers at all — keep the lesson usable as a single prose slide.
    segments.push({ kind: 'explain', body: text });
  }

  return {
    segments: segments.slice(0, MAX_SEGMENTS),
    quiz: quiz.slice(0, MAX_QUIZ),
  };
}
