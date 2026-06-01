// High-level service: the API the frontend HTTP routes and the Telegram command
// both call. Owns the generation job lifecycle (outline -> lessons), progress
// persistence, and the on-demand rephrase. Generation runs as fire-and-forget
// against the shared DB; the SSE progress stream polls that DB, so a job is
// observable across processes and survives a client reconnect.

import type { LLM, ProfileName } from '../../../src/core/llm.js';
import type { Logger } from '../../../src/util/log.js';
import type { DB } from '../../../src/storage/db.js';
import type { CourseTree, CourseSummary } from './store.js';
import type { Depth, Generator, ParsedLesson, ProgressState, Source } from './types.js';
import * as store from './store.js';
import { chooseModel, generateLesson, generateOutline, labelFor, rephrase } from './generate.js';
import { previewSourcesForTopic, referenceFromSources, researchForCourse } from './research.js';

export interface TudorCtx {
  db: DB;
  llm: LLM;
  log: Logger;
}

// Courses with a generation job live in THIS process. Used to avoid double-
// running a job and to detect a course that was left mid-generation by a
// process restart (so we can transparently resume it).
const activeJobs = new Set<string>();
const activeAborts = new Map<string, AbortController>();

function estMinutes(seed: number): number {
  // Cheap deterministic-ish estimate; the UI just wants a rough "5 min" badge.
  return 4 + (seed % 4);
}

export function startCourse(
  ctx: TudorCtx,
  args: {
    topic: string;
    depth: Depth;
    generator: Generator;
    localModel?: string;
    useWebsearch?: boolean;
    approvedSources?: Source[];
  },
): string {
  const topic = args.topic.trim().slice(0, 300);
  const choice = chooseModel(ctx.llm, args.generator, args.localModel);
  const id = store.createCourse(ctx.db, { topic, depth: args.depth, model: choice.label });
  // Fire-and-forget — the panel/daemon process keeps running, and progress is
  // tracked in the DB so the UI can follow along and resume if needed.
  void runJob(ctx, id, args.depth, choice, {
    useWebsearch: !!args.useWebsearch,
    ...(args.approvedSources ? { approvedSources: args.approvedSources } : {}),
  }).catch((e) => {
    ctx.log.error('tudor: generation job crashed', {
      courseId: id,
      error: e instanceof Error ? e.message : String(e),
    });
  });
  return id;
}

// Search-only preview: the candidate websites for a topic, so the Learn tab can
// ask the user to approve each one before any of it is used in a build.
export async function previewSources(ctx: TudorCtx, topic: string): Promise<Source[]> {
  if (!store.isExtensionEnabled(ctx.db, 'gurney-websearch')) return [];
  return previewSourcesForTopic(topic.trim().slice(0, 300), ctx.log);
}

// Re-attach to a course that's still 'generating' but has no live job in this
// process (e.g. the panel restarted mid-build). Skips the outline if modules
// already exist and just finishes the pending lessons.
export function resumeIfStale(ctx: TudorCtx, courseId: string): void {
  if (activeJobs.has(courseId)) return;
  const course = store.getCourse(ctx.db, courseId);
  if (!course || course.status !== 'generating') return;
  void runJob(ctx, courseId, course.depth, null).catch((e) => {
    ctx.log.error('tudor: resume job crashed', {
      courseId,
      error: e instanceof Error ? e.message : String(e),
    });
  });
}

async function runJob(
  ctx: TudorCtx,
  courseId: string,
  depth: Depth,
  choice: ReturnType<typeof chooseModel> | null,
  opts: { useWebsearch?: boolean; approvedSources?: Source[] } = {},
): Promise<void> {
  if (activeJobs.has(courseId)) return;
  activeJobs.add(courseId);
  const ac = new AbortController();
  activeAborts.set(courseId, ac);
  const { signal } = ac;
  const { db, llm, log } = ctx;
  // On resume we don't have the original ModelChoice; rebuild a local one.
  let ref: ProfileName | { model: string } = choice?.ref ?? chooseModel(llm, 'local').ref;
  const fallback: ProfileName = choice?.fallback ?? chooseModel(llm, 'local').fallback;

  // Run a generation step; if the primary model (codex) throws, downgrade to
  // the local fallback for the rest of the course and retry the step once.
  const withDowngrade = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (e) {
      if (typeof ref !== 'object') throw e; // already local — nothing to fall back to
      log.warn('tudor: primary generator failed, falling back to local', {
        error: e instanceof Error ? e.message : String(e),
      });
      ref = fallback;
      store.setCourseModel(db, courseId, labelFor(llm, ref));
      return step();
    }
  };

  try {
    // --- Phase 0: optional web research (fresh builds only) ---
    let lessons = store.listPendingLessons(db, courseId);
    const course = store.getCourse(db, courseId);
    const hasModules = (store.getCourseTree(db, courseId)?.modules.length ?? 0) > 0;

    let reference = '';
    if (!hasModules && opts.useWebsearch && store.isExtensionEnabled(db, 'gurney-websearch')) {
      if (opts.approvedSources !== undefined) {
        // The user saw the candidate websites and approved exactly these — use
        // only them (an empty list means "approved none", so no research at all).
        if (opts.approvedSources.length > 0) {
          reference = await referenceFromSources(opts.approvedSources, log);
          store.saveSources(db, courseId, opts.approvedSources);
        }
      } else {
        // No per-site approval supplied (e.g. /learn, or the gate is off) —
        // search and use what comes back, recording it.
        const outcome = await researchForCourse(course?.topic ?? '', log);
        reference = outcome.reference;
        if (outcome.sources.length > 0) store.saveSources(db, courseId, outcome.sources);
      }
    }

    // --- Phase 1: outline (only if not already built) ---
    if (!hasModules) {
      store.updateJob(db, courseId, { phase: 'outline', done: 0, total: 0 });
      const outline = await withDowngrade(() =>
        generateOutline(llm, ref, course?.topic ?? '', depth, log, reference || undefined),
      );
      store.persistOutline(db, courseId, outline);
      lessons = store.listPendingLessons(db, courseId);
    }

    // --- Phase 2: lessons, one at a time, so the learner can start lesson 1
    // while the rest keep compiling. ---
    const total = lessons.length;
    const title = store.getCourse(db, courseId)?.title ?? course?.topic ?? '';
    store.updateJob(db, courseId, { phase: 'lessons', done: 0, total });

    let done = 0;
    for (const lesson of lessons) {
      if (signal.aborted) break;
      store.setLessonStatus(db, lesson.id, 'generating');
      const lessonArgs = {
        courseTitle: title,
        moduleTitle: store.moduleTitle(db, lesson.module_id),
        lessonTitle: lesson.title,
        siblingTitles: store.moduleSiblingTitles(db, lesson.module_id),
        ...(reference ? { reference } : {}),
      };
      // Two attempts. The first lessons in a course often hit a cold model
      // (inference timeout or an empty completion while Ollama warms up); a
      // quick second try usually lands once it's loaded. Only the final failure
      // is logged and marks the lesson failed.
      let parsed: ParsedLesson | null = null;
      for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
        try {
          parsed = await withDowngrade(() => generateLesson(llm, ref, lessonArgs));
        } catch (e) {
          if (attempt === 1) {
            log.warn('tudor: lesson generation failed after retry', {
              courseId,
              lesson: lesson.title,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      if (parsed)
        store.replaceLessonContent(db, lesson.id, parsed, estMinutes(lesson.title.length));
      else store.setLessonStatus(db, lesson.id, 'failed');
      done += 1;
      store.updateJob(db, courseId, { done });
    }

    store.setCourseStatus(db, courseId, 'ready');
    store.updateJob(db, courseId, { error: null });
  } catch (e) {
    log.error('tudor: course generation failed', {
      courseId,
      error: e instanceof Error ? e.message : String(e),
    });
    store.setCourseStatus(db, courseId, 'failed');
    store.updateJob(db, courseId, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    activeJobs.delete(courseId);
    activeAborts.delete(courseId);
  }
}

export function cancelCourse(ctx: TudorCtx, id: string): void {
  const ac = activeAborts.get(id);
  if (ac) ac.abort();
  store.setCourseStatus(ctx.db, id, 'failed');
  store.updateJob(ctx.db, id, { error: 'Generation stopped by user.' });
}

// --- Reads & mutations the routes expose ---

export function listCourses(ctx: TudorCtx): CourseSummary[] {
  return store.listCourses(ctx.db);
}

export function getCourse(ctx: TudorCtx, id: string): CourseTree | null {
  const tree = store.getCourseTree(ctx.db, id);
  if (tree && tree.course.status === 'generating') resumeIfStale(ctx, id);
  return tree;
}

export interface Snapshot {
  status: string;
  title: string | null;
  phase: string;
  done: number;
  total: number;
  error: string | null;
  lessons: Array<{ id: string; status: string }>;
  active: boolean;
}

export function snapshot(ctx: TudorCtx, id: string): Snapshot | null {
  const course = store.getCourse(ctx.db, id);
  if (!course) return null;
  if (course.status === 'generating') resumeIfStale(ctx, id);
  const job = store.getJob(ctx.db, id);
  const tree = store.getCourseTree(ctx.db, id);
  const lessonStates =
    tree?.modules.flatMap((m) => m.lessons.map((l) => ({ id: l.id, status: l.status }))) ?? [];
  return {
    status: course.status,
    title: course.title,
    phase: job?.phase ?? 'outline',
    done: job?.done ?? 0,
    total: job?.total ?? 0,
    error: job?.error ?? null,
    lessons: lessonStates,
    active: activeJobs.has(id),
  };
}

export function recordProgress(
  ctx: TudorCtx,
  courseId: string,
  lessonId: string,
  state: ProgressState,
  confidence: number,
): void {
  store.upsertProgress(ctx.db, courseId, lessonId, state, confidence);
}

export function deleteCourse(ctx: TudorCtx, id: string): void {
  store.deleteCourse(ctx.db, id);
}

// Rebuild a single lesson on demand — the recovery path for a lesson that
// failed during the initial build (cold-model timeout / empty completion).
// Always uses the local model (cheap, no budget) and the same two-attempt
// resilience as the build loop.
export async function regenerateLesson(ctx: TudorCtx, lessonId: string): Promise<{ ok: boolean }> {
  const c = store.lessonContext(ctx.db, lessonId);
  if (!c) throw new Error('lesson not found');
  store.setLessonStatus(ctx.db, lessonId, 'generating');
  const ref = chooseModel(ctx.llm, 'local').ref;
  let parsed: ParsedLesson | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      parsed = await generateLesson(ctx.llm, ref, {
        courseTitle: c.courseTitle,
        moduleTitle: c.moduleTitle,
        lessonTitle: c.lessonTitle,
        siblingTitles: c.siblingTitles,
      });
    } catch (e) {
      if (attempt === 1) {
        ctx.log.warn('tudor: lesson regenerate failed', {
          lessonId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  if (!parsed) {
    store.setLessonStatus(ctx.db, lessonId, 'failed');
    return { ok: false };
  }
  store.replaceLessonContent(ctx.db, lessonId, parsed, 4 + (c.lessonTitle.length % 4));
  return { ok: true };
}

// On-demand "explain simpler / go deeper". Caches the result on the segment so
// a repeat is instant and costs no further model time.
export async function rephraseSegment(
  ctx: TudorCtx,
  segmentId: string,
  mode: 'simpler' | 'deeper',
): Promise<{ text: string; cached: boolean }> {
  const seg = store.getSegment(ctx.db, segmentId);
  if (!seg) throw new Error('segment not found');
  const cache: Record<string, string> = seg.variants_json ? JSON.parse(seg.variants_json) : {};
  if (cache[mode]) return { text: cache[mode]!, cached: true };

  const ref = chooseModel(ctx.llm, 'local').ref; // rephrase always uses local (cheap, no budget)
  const lessonTitle = store.lessonTitleForSegment(ctx.db, segmentId);
  const text = await rephrase(ctx.llm, ref, mode, seg.body_md, lessonTitle);
  cache[mode] = text;
  store.setSegmentVariants(ctx.db, segmentId, cache);
  return { text, cached: false };
}

export interface TudorStatus {
  ok: true;
  defaults: { generator: Generator; depth: Depth; useWebsearch: boolean };
  localModel: string;
  codexAvailable: boolean;
  websearchAvailable: boolean;
  // Whether the Learn tab should confirm before building a researched course.
  confirmBeforeSearch: boolean;
}

export function status(ctx: TudorCtx): TudorStatus {
  const generator =
    (store.readExtSetting(ctx.db, 'default_generator', 'local') as Generator) || 'local';
  const depth = (store.readExtSetting(ctx.db, 'default_depth', 'standard') as Depth) || 'standard';
  const websearchAvailable = store.isExtensionEnabled(ctx.db, 'gurney-websearch');
  return {
    ok: true,
    defaults: {
      generator: generator === 'codex' ? 'codex' : 'local',
      depth: ['quick', 'standard', 'deep'].includes(depth) ? depth : 'standard',
      // Only default the toggle on when the extension is actually available.
      useWebsearch:
        websearchAvailable && store.readExtSetting(ctx.db, 'use_websearch', 'false') === 'true',
    },
    localModel: labelFor(ctx.llm, chooseModel(ctx.llm, 'local').ref),
    codexAvailable: store.isExtensionEnabled(ctx.db, 'gurney-codex'),
    websearchAvailable,
    confirmBeforeSearch:
      store.readExtSettingFor(ctx.db, 'gurney-websearch', 'confirm_before_search', 'true') !==
      'false',
  };
}
