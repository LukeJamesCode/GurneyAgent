// Prompt builders. The format instructions are strict and example-anchored
// because the target is a small local model — the more concrete and the fewer
// degrees of freedom, the more reliable the line-tagged output the parsers in
// parse.ts expect.

import type { Depth } from './types.js';

interface DepthShape {
  modules: string;
  lessons: string;
}

const DEPTH_SHAPE: Record<Depth, DepthShape> = {
  quick: { modules: '2', lessons: '2' },
  standard: { modules: '3', lessons: '2 to 3' },
  deep: { modules: '4 to 5', lessons: '3' },
};

export const OUTLINE_SYSTEM =
  'You are Tudor, a world-class course designer. You break a topic into a clear, ' +
  'motivating learning path that builds from fundamentals to mastery. You output ' +
  'ONLY the requested plain-text format — no preamble, no commentary, no markdown fences.';

// `reference` is optional, already-wrapped untrusted web research (see
// gurney-websearch). When present it's appended so the model grounds the plan in
// it; the wrapping itself tells the model to treat it as data, not instructions.
function withReference(lines: string[], reference?: string): string {
  const body = lines.join('\n');
  if (!reference) return body;
  return `${body}\n\nUse the following reference material where relevant; prefer it over guesswork:\n${reference}`;
}

export function outlineUser(topic: string, depth: Depth, reference?: string): string {
  const shape = DEPTH_SHAPE[depth];
  return withReference(
    [
      `Design a course that teaches a motivated beginner: "${topic}".`,
      '',
      `Produce ${shape.modules} modules. Each module has ${shape.lessons} lessons.`,
      'Order them so each lesson builds on the ones before it. Lesson titles should be',
      'specific and concrete (not "Introduction" or "Overview").',
      '',
      'Use EXACTLY this format and nothing else:',
      '',
      'TITLE: <a short, engaging course title>',
      'MODULE: <module 1 title>',
      'SUMMARY: <one sentence on what this module covers>',
      '- <lesson title>',
      '- <lesson title>',
      'MODULE: <module 2 title>',
      'SUMMARY: <one sentence>',
      '- <lesson title>',
      '- <lesson title>',
    ],
    reference,
  );
}

export const LESSON_SYSTEM =
  'You are Tudor, an expert tutor who makes hard ideas click. You explain one idea ' +
  'at a time, in plain language, with concrete examples and vivid analogies. You output ' +
  'ONLY the requested plain-text format — no preamble, no commentary, no markdown fences.';

export function lessonUser(args: {
  courseTitle: string;
  moduleTitle: string;
  lessonTitle: string;
  siblingTitles: string[];
  reference?: string;
}): string {
  const others = args.siblingTitles.filter((t) => t !== args.lessonTitle);
  const context =
    others.length > 0
      ? `Other lessons in this module (do not repeat them): ${others.join('; ')}.`
      : '';
  return withReference(
    [
      `Course: "${args.courseTitle}". Module: "${args.moduleTitle}".`,
      `Write the lesson: "${args.lessonTitle}".`,
      context,
      '',
      'Write 3 to 5 short segments, then 1 to 2 multiple-choice quiz questions.',
      'Each segment is one clear idea, 2-5 sentences. You may use markdown inside a',
      'segment body (bold, lists, `code`). Pick a kind for each segment from:',
      'explain, example, analogy, keypoints, checkpoint, warning.',
      '',
      'Use EXACTLY this format and nothing else:',
      '',
      'SEGMENT: explain',
      '<the explanation>',
      'SEGMENT: example',
      '<a concrete worked example>',
      'SEGMENT: analogy',
      '<a vivid everyday analogy>',
      'SEGMENT: keypoints',
      '- <key takeaway>',
      '- <key takeaway>',
      'QUIZ:',
      'Q: <a question that checks understanding>',
      '- <option>',
      '- <option>',
      '- <option>',
      'CORRECT: <the letter or number of the right option>',
      'WHY: <one sentence on why that answer is correct>',
    ],
    args.reference,
  );
}

export const REPHRASE_SYSTEM =
  'You are Tudor, a patient tutor. You rewrite a passage on request, keeping it accurate ' +
  'and self-contained. Output ONLY the rewritten passage in markdown — no preamble.';

export function rephraseUser(
  mode: 'simpler' | 'deeper',
  body: string,
  lessonTitle: string,
): string {
  const instruction =
    mode === 'simpler'
      ? 'Rewrite it much simpler — explain it like I am twelve, using a everyday analogy and short sentences.'
      : 'Go deeper — add precision, a concrete example, and the "why" behind it, for a learner who wants more.';
  return [`This passage is from a lesson on "${lessonTitle}":`, '', body, '', instruction].join(
    '\n',
  );
}
