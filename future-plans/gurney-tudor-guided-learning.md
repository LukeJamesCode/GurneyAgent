# Gurney-Tudor — Guided Learning Studio

**Status:** v1 implemented — shipped as the `gurney-tudor` extension (see
[`extensions/gurney-tudor/`](../extensions/gurney-tudor/) and its README). This
document captures the agreed v1 direction; phase 2 (voice-over narration) is
still outstanding. The data model already reserves a per-segment `narration`
field for it.

**v1 shape (decided):**

- **Approach: "Course Compiler."** One up-front generation produces a complete,
  structured course; consumption (reading, stepping through, quizzes) is then
  instant because nothing calls a model in real time.
- **Input: a topic / prompt.** No document upload or RAG in v1 (that depends on
  infrastructure Gurney doesn't have yet — see _Non-goals_).
- **Workhorse model: qwen (local), codex optional.** Generation runs on the
  local model by default and stays true to the local-first North Star; codex is
  an opt-in speed/quality boost when the user has it authed.
- **Voice-over: phase 2.** Ship the interactive visual course first; add Piper
  narration as a fast follow.

## Context & motivation

The goal is a NotebookLM-style learning surface inside Gurney: give it a topic,
and instead of just answering, it **builds a course and walks you through it** —
broken into digestible steps, with interactive UI that _shows_ you what you're
learning, not just a wall of text.

The hard constraint that shapes everything: **local inference takes 40–60s for a
2B model.** A turn-by-turn live tutor would pay that cost on _every_ interaction
and feel terrible. Codex is fast but is budget-capped per day (see
`gurney-codex`), so it can't be the answer to "respond instantly on every tap"
either.

The design principle that resolves this:

> **Separate generation-time from consumption-time.** Do the slow, expensive
> thinking _once_, up front, as a background job behind an engaging progress
> experience. Produce a fully pre-baked, structured course. Then playback is
> instant — every "next", reveal, and quiz is reading pre-generated data, not
> calling a model.

This is exactly how NotebookLM's "Audio Overview" works: one wait to generate,
then instant consumption.

## North Star alignment

| North Star                   | How this design respects it                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs on small devices        | Generation is a bounded background job, not a hot-path cost. Per-lesson prompts keep context small enough for a Pi-class model. Heavy work is opt-in (codex / 7B tier). |
| Extensions are mods          | Ships as a `gurney-tudor` extension. The only core/other-extension touch is a small, generic "extension panel" hook added to `gurney-frontend` (itself an extension).   |
| Telegram is the chat surface | This is a **panel-only** feature and says so. It requires `gurney-frontend`; it adds nothing to the Telegram loop. Consistent with the web UI already being opt-in.     |
| Terminal-only setup          | Install/enable/config via `gurney ext install gurney-tudor` / `gurney config gurney-tudor`. No browser-based admin.                                                     |
| CPU-only, qwen3.5-native     | qwen is the default generator (`reason` profile if present, else `tools`). Codex is strictly opt-in and gated by its existing daily budget.                             |

## Non-goals for v1

- **No document ingestion / RAG.** Grounding a course in uploaded PDFs requires
  an embedding model + vector store + upload pipeline that don't exist yet
  (roadmap `gurney-files`, v1.6). v1 generates from the model's own knowledge of
  a topic. Pasted-text-as-source is a candidate for v1.1.
- **No live Socratic chat tutor.** Considered and rejected for v1 — it pays the
  40–60s latency on every turn. (A "discuss this lesson" affordance can be a
  later, explicitly-gated add.)
- **No voice-over in v1.** Deferred to phase 2.

---

## Architecture overview

Two pieces:

1. **`gurney-tudor` extension** — owns the domain: the course data model
   (SQLite migrations), the generation pipeline (the prompts, JSON schema,
   validation, model routing), and the generation _job_ runner. Exposes its
   capability through host primitives (`host.db`, `host.llm`, `host.cache`,
   `host.scheduler`) and a small set of functions the panel calls.

2. **`gurney-frontend` additions** — a new **Learn** tab, plus the API routes
   that back it. The frontend server is currently a single monolith
   (`server.ts`) with hardcoded tabs in `web/app.jsx` (`NAV` array +
   conditional render). Two ways to wire the tab:
   - **Pragmatic (recommended for v1):** add the tab directly to
     `gurney-frontend` — a `web/learnhub.jsx` component, a `NAV` entry with
     `requiresExt: 'gurney-tudor'` (so it only appears when the extension is
     enabled, exactly like Voice Hub today), and `/api/tudor/*` routes in
     `server.ts` that call into the `gurney-tudor` extension via the already-
     loaded `ExtensionLoader` runtime (`getDirectChatRuntime` pattern).
   - **Clean (longer-term):** give `gurney-frontend` a generic
     "extension-contributed panel" mechanism — extensions declare a panel
     (id, label, icon, asset path) in their manifest, and the frontend
     discovers them and mounts `/api/ext/<name>/*` proxy routes. More work, but
     it means future panels (e.g. a `gurney-files` browser) cost zero
     frontend edits. **Decision: ship pragmatic for v1, design the clean
     mechanism as a follow-up** so we don't over-build before we have a second
     consumer.

Either way, the **panel never calls a model directly.** It POSTs a topic to
start a job, subscribes to progress (SSE, reusing the `postStream` /
`text/event-stream` plumbing in `web/api.js` + `server.ts`), and otherwise reads
finished course data over plain JSON.

### Data model (SQLite migrations under `gurney-tudor/migrations/`)

```
courses
  id            text primary key      -- uuid
  topic         text not null         -- the user's prompt
  title         text                  -- model-generated
  status        text not null         -- 'generating' | 'ready' | 'failed'
  model         text                  -- which model/profile generated it
  created_at    integer
  ready_at      integer

modules
  id            text primary key
  course_id     text not null references courses(id)
  idx           integer not null      -- order
  title         text
  summary       text

lessons
  id            text primary key
  module_id     text not null references modules(id)
  idx           integer not null
  title         text
  status        text not null         -- 'pending' | 'ready' | 'failed'
  est_minutes   integer

segments                              -- the atomic "slides"
  id            text primary key
  lesson_id     text not null references lessons(id)
  idx           integer not null
  kind          text not null         -- 'explain' | 'example' | 'analogy'
                                       -- | 'diagram' | 'checkpoint'
  body_md       text                  -- markdown content
  widget_json   text                  -- optional UI-widget spec (see below)
  narration     text                  -- script for phase-2 TTS (nullable)
  variants_json text                  -- pre-generated "simpler"/"deeper" (nullable)

quizzes
  id            text primary key
  lesson_id     text not null references lessons(id)
  question      text
  choices_json  text                  -- ["...","..."]
  answer_idx    integer
  explain_md    text

course_progress                       -- per owner-chat, like chat_prefs
  course_id     text not null references courses(id)
  lesson_id     text not null
  state         text not null         -- 'unseen' | 'in_progress' | 'done'
  confidence    integer               -- 0..3 self-rating, feeds the mastery map
  updated_at    integer

generation_jobs                       -- one row per generate request
  id            text primary key
  course_id     text not null references courses(id)
  phase         text not null         -- 'outline' | 'lessons'
  done          integer               -- lessons completed
  total         integer               -- lessons expected
  error         text
  updated_at    integer
```

### Course JSON (what generation emits, before it's persisted into the tables)

```jsonc
{
  "title": "Understanding Transformers",
  "modules": [
    {
      "title": "Why attention?",
      "summary": "...",
      "lessons": [
        {
          "title": "From RNNs to attention",
          "est_minutes": 6,
          "segments": [
            { "kind": "explain", "body_md": "...", "narration": "..." },
            { "kind": "analogy", "body_md": "..." },
            { "kind": "diagram", "widget": { "type": "mermaid", "src": "graph LR; ..." } },
            { "kind": "checkpoint", "body_md": "..." },
          ],
          "quiz": [
            { "question": "...", "choices": ["...", "..."], "answer_idx": 1, "explain_md": "..." },
          ],
        },
      ],
    },
  ],
}
```

---

## Generation pipeline

This is the heart of the feature and where the latency strategy lives.

### It's a job, not a request

`POST /api/tudor/courses { topic }` **returns a `courseId` immediately** and
kicks off a background generation job (run off the hot path, similar to the
orchestrator's background queue). The panel subscribes to
`GET /api/tudor/courses/:id/progress` (SSE) and renders an engaging
"building your course…" experience as modules/lessons light up.

### Two stages — for speed of first feedback _and_ to fit small-model context

A single "generate the whole course" prompt is both slow (one long wait with no
feedback) and fragile (a big topic blows the 2B/7B context window and tanks JSON
reliability). So:

1. **Outline (one quick call).** Generate just the syllabus: course title +
   modules + lesson titles + est. minutes. Small output → fast → the panel can
   show the full course skeleton within one model call, so the user sees
   structure almost immediately.
2. **Lesson expansion (a loop of bounded calls).** For each lesson, one call
   generates that lesson's segments + quiz, given only the outline + that
   lesson's title as context. Each prompt is small (kind to Pi-class context
   limits), each result is independently validated, and the progress bar
   advances per lesson ("Module 2 of 5 ready"). The user can **start lesson 1
   as soon as it's ready**, while later lessons keep generating — same
   "consume while the rest builds" idea as prefetch, but driven by the job.

### Model routing (qwen primary, codex optional)

- Default: route to qwen via the existing profile system — prefer the `reason`
  profile (7B) when the tier has it, fall back to `tools` (2B). Generation
  quality matters more than latency here because it's a one-time job.
- Codex: opt-in per `gurney-tudor` setting (`generator: 'local' | 'codex'`, or a
  per-course selector). When on, route by passing a `codex` model ref through
  `host.llm` (the provider is already registered by `gurney-codex`). Respect its
  daily budget — surface a clear "codex budget reached, falling back to local"
  rather than failing the job.

### Structured-output reliability (the main technical risk)

Small models are unreliable at emitting strict JSON. Mitigations, in order:

1. **Constrain the surface.** Generate one lesson at a time with a tight schema
   and few-shot example; never ask for the whole nested course at once.
2. **Validate + one repair pass.** Parse and schema-check each result; on
   failure, send the malformed output back with "return valid JSON only"
   (reuse the JSON-fence stripping already in `gurney-codex`'s
   `model-provider.ts`).
3. **Graceful fallback.** If a lesson still fails to parse, fall back to storing
   it as a single `explain` segment of plain markdown — the lesson is still
   usable, just not richly segmented. A lesson is marked `failed` only if even
   that fails, and the course as a whole still completes.
4. Consider Ollama's JSON/grammar-constrained output (`format: json`) where the
   profile supports it, to harden step 1.

### Timeouts & resilience on a Pi

- Per-lesson calls have their own timeouts; a slow/stuck lesson fails that
  lesson, not the course.
- Jobs are resumable: `generation_jobs` tracks `done/total`, so a panel reload
  (or a daemon restart) can re-attach to or resume an in-flight course rather
  than starting over.

---

## The Learn tab (consumption UI)

All instant — reads persisted course data.

- **Course library** — cards for past courses (topic, progress ring, "continue"
  / "new course"). Reading is zero-cost and offline after generation.
- **Generation experience** — not a spinner: the outline appears first, then
  modules/lessons fill in live with a satisfying "ready" animation. The one
  unavoidable wait _feels_ like progress.
- **Lesson player** — the core "show me what I'm learning" surface:
  - **Step-through slides** with progressive reveal — one segment at a time,
    never a wall of text. Keyboard / tap to advance.
  - **Segment kinds render differently:** `explain` (prose), `example`,
    `analogy`, `diagram` (Mermaid rendered client-side — no model latency),
    `checkpoint`.
  - **Per-segment actions** — "Explain simpler" / "Go deeper" swap in
    **pre-generated variants** (instant). (Optionally, a later "ask about this"
    can do a live qwen call — but only behind an explicit button with an honest
    loading state, never silently.)
  - **Inline checkpoint quizzes** with instant feedback and an explanation.
- **Mastery map** — per-lesson state + self-rated confidence (0–3) fills a
  visual progress map; low-confidence lessons are flagged for review. This is
  also the seam where spaced-repetition could later plug in.

## Phase 2 — voice-over

- Narration scripts are already generated per segment (`segments.narration`).
- A background job (post-generation, like the existing voice `afterReply` path)
  pre-bakes Piper TTS per segment into cached OGG clips, reusing
  `gurney-voice`'s `synthesize()` and the frontend's existing one-shot voice-
  clip delivery (`voiceClips` map + SSE `voice` event).
- **Karaoke playback:** narration plays while the current segment/sentence
  highlights; play / pause / scrub. Because clips are pre-baked, playback is
  instant.
- Gated on `gurney-voice` being installed (`requiresExt`-style check); silently
  absent otherwise.

---

## Milestones

| Phase | Deliverable                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| 1a    | `gurney-tudor` extension scaffold: manifest, settings schema, migrations, the course data model.              |
| 1b    | Generation pipeline: outline call + per-lesson loop, JSON validation + repair + fallback, qwen routing, jobs. |
| 1c    | `gurney-frontend` Learn tab: library, live generation experience, lesson player, checkpoint quizzes.          |
| 1d    | Mastery map + progress persistence; codex-optional generator setting; polish + extension ability tests.       |
| 2     | Voice-over: narration TTS pre-bake job + karaoke playback (requires `gurney-voice`).                          |

## Risks & open questions

- **Frontend coupling.** v1 edits `gurney-frontend` directly (pragmatic path).
  Acceptable because the frontend is itself an opt-in extension and Voice Hub
  already sets the `requiresExt` precedent — but we should write the generic
  "extension panel" mechanism up as the immediate follow-up so the next panel
  is free.
- **JSON reliability on 2B.** The biggest unknown. The one-lesson-at-a-time +
  validate + repair + markdown-fallback chain should make it _robust_, but we
  should bench it on the actual default model before committing the UI to rich
  segments. If 2B is too weak, the `reason`/7B profile or codex becomes the
  recommended generator and 2B gets the markdown-fallback path more often.
- **Generation wall-clock on a Pi.** A 5-module course is dozens of model calls;
  on a Pi 4 that could be many minutes. The progressive "start lesson 1 while
  the rest builds" UX is the mitigation, but we should set sane default course
  sizes per tier (e.g. fewer lessons on Small).
- **Codex budget.** Generation can burn the daily ceiling fast. Default to local;
  when codex is selected, show an estimated call count up front and fall back to
  local on budget exhaustion rather than failing.
- **Open:** Should v1.1 add pasted-text-as-source (cheap, no embeddings) as a
  stepping stone toward full document RAG? Likely yes.
- **Open:** Where do courses live for multi-user installs? v1 assumes the single
  owner chat (like `course_progress` mirroring `chat_prefs`); revisit if/when the
  panel grows real multi-user auth.
  </content>
  </invoke>
