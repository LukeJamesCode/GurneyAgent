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

// --- Visualization (on-demand, per lesson) ---
//
// The model returns a complete self-contained HTML document that the panel
// renders inside a sandboxed iframe (srcdoc + sandbox="allow-scripts", null
// origin). That means it can't read the panel's cookies, storage, or DOM — so
// the prompt can lean into JS/SVG/canvas freely. The format constraints keep
// the output a single document with everything inlined, which is what the
// iframe needs: external <script src>/<link href> won't load in a srcdoc
// frame with no network identity.
export const VISUALIZATION_SYSTEM =
  'You are Tudor, an expert at turning ideas into visuals that make them click. ' +
  'You write a single self-contained HTML document (one <!DOCTYPE html> page) that ' +
  'visualizes the lesson. All CSS and JS are inline; do NOT use external scripts, ' +
  'stylesheets, fonts, or images. Output ONLY the raw HTML — no preamble, no ' +
  'commentary, no markdown fences.';

export function visualizationUser(args: {
  courseTitle: string;
  moduleTitle: string;
  lessonTitle: string;
  lessonBody: string;
}): string {
  return [
    `Course: "${args.courseTitle}". Module: "${args.moduleTitle}".`,
    `Build a visual for the lesson: "${args.lessonTitle}".`,
    '',
    'The lesson content (for grounding — visualize what is here, do not invent new facts):',
    '"""',
    args.lessonBody,
    '"""',
    '',
    'Design the visualization for the single most important idea or structure in this lesson.',
    'Pick the form that best fits the content — a diagram, a labelled illustration, a flow,',
    'a small interactive demo, a step-through, or an animated SVG. Use whichever helps a',
    'learner see the idea fastest.',
    '',
    'Hard rules for the HTML:',
    '- One complete document starting with <!DOCTYPE html>.',
    '- All CSS in a single <style> tag in <head>. All JS in a single <script> tag.',
    '- No external resources: no <link>, no <script src>, no remote fonts, no remote images.',
    '  If you need icons or images, use inline SVG.',
    '- Use a dark, calm background (around #0f1115) with high-contrast text. The whole',
    '  document must fit in a viewport ~960x600 without horizontal scrolling.',
    '- Keep it under ~3000 lines of HTML. Prefer clarity over visual maximalism.',
    '- Label every part of the diagram clearly. Add a short caption explaining what the',
    '  learner is looking at.',
  ].join('\n');
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
