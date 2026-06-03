// Shared types for gurney-tudor. The `*Row` types mirror the SQLite columns in
// migrations/0001_tudor.sql; the `Parsed*` types are the intermediate shapes the
// generation parsers produce before they're persisted into those rows.

export type CourseStatus = 'generating' | 'ready' | 'failed';
export type LessonStatus = 'pending' | 'generating' | 'ready' | 'failed';
export type ProgressState = 'unseen' | 'in_progress' | 'done';
export type Depth = 'quick' | 'standard' | 'deep';
export type Generator = 'local' | 'codex' | 'cloud';

// Segment kinds drive how the player themes each slide. Unknown kinds from the
// model are normalised to 'explain' by the parser, so this set is closed.
export type SegmentKind =
  | 'explain'
  | 'example'
  | 'analogy'
  | 'keypoints'
  | 'checkpoint'
  | 'warning';

export const SEGMENT_KINDS: readonly SegmentKind[] = [
  'explain',
  'example',
  'analogy',
  'keypoints',
  'checkpoint',
  'warning',
];

export interface CourseRow {
  id: string;
  topic: string;
  title: string | null;
  status: CourseStatus;
  model: string | null;
  depth: Depth;
  created_at: number;
  ready_at: number | null;
}

export interface ModuleRow {
  id: string;
  course_id: string;
  idx: number;
  title: string;
  summary: string | null;
}

export interface LessonRow {
  id: string;
  module_id: string;
  idx: number;
  title: string;
  status: LessonStatus;
  est_minutes: number | null;
  // Cached on-demand HTML visualization for the lesson, NULL until the learner
  // clicks "Visualize" in the panel. See migration 0003.
  visualization_html: string | null;
}

export interface SegmentRow {
  id: string;
  lesson_id: string;
  idx: number;
  kind: SegmentKind;
  body_md: string;
  narration: string | null;
  variants_json: string | null;
}

export interface QuizRow {
  id: string;
  lesson_id: string;
  idx: number;
  question: string;
  choices_json: string;
  answer_idx: number;
  explain_md: string | null;
}

export interface ProgressRow {
  course_id: string;
  lesson_id: string;
  state: ProgressState;
  confidence: number;
  updated_at: number;
}

export interface JobRow {
  course_id: string;
  phase: 'outline' | 'lessons';
  done: number;
  total: number;
  error: string | null;
  updated_at: number;
}

export interface SourceRow {
  id: string;
  course_id: string;
  idx: number;
  title: string;
  url: string;
  domain: string | null;
}

// A web source as it flows through the research/approval path (pre-persist).
export interface Source {
  title: string;
  url: string;
  domain?: string;
  snippet?: string;
}

// ---- Parsed (pre-persist) shapes produced by lib/parse.ts ----

export interface ParsedOutline {
  title: string;
  modules: Array<{ title: string; summary: string; lessons: string[] }>;
}

export interface ParsedQuiz {
  question: string;
  choices: string[];
  answerIdx: number;
  why: string;
}

export interface ParsedSegment {
  kind: SegmentKind;
  body: string;
}

export interface ParsedLesson {
  segments: ParsedSegment[];
  quiz: ParsedQuiz[];
}
