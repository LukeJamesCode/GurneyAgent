/* global React, window */
// Learn Hub — the gurney-tudor front end. A topic goes in; a full interactive
// course comes out and you step through it. All playback reads pre-generated
// data (no model calls), so it's instant; only the build itself, the rephrase,
// and (nothing else) ever touch a model. Self-contained: talks to /api/tudor/*.
const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ---------------------------------------------------------------- tiny markdown
   A small, safe markdown -> React renderer. Everything renders as React
   children (escaped by React), so there's no innerHTML / XSS surface. Handles
   the subset a lesson actually uses: headings, lists, blockquotes, fenced code,
   and inline **bold** / *italic* / `code`. */
function mdInline(text, keyBase) {
  const nodes = [];
  let rest = String(text);
  let k = 0;
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            padding: '1px 5px',
          }}
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(
        <strong key={key} style={{ color: 'var(--text)' }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

function MD({ text }) {
  const blocks = [];
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
            overflow: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            lineHeight: 1.5,
            margin: '4px 0',
          }}
        >
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      blocks.push(
        <div
          key={key++}
          style={{
            fontWeight: 700,
            fontSize: lvl === 1 ? 18 : lvl === 2 ? 16 : 14.5,
            color: 'var(--text)',
            margin: '6px 0 2px',
          }}
        >
          {mdInline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(
        <blockquote
          key={key++}
          style={{
            borderLeft: '3px solid var(--accent)',
            margin: '6px 0',
            padding: '4px 0 4px 14px',
            color: 'var(--text-2)',
          }}
        >
          {mdInline(quote.join(' '), `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length && /^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={key++} style={{ margin: '4px 0', paddingLeft: 22, lineHeight: 1.6 }}>
          {items.map((it, idx) => (
            <li key={idx} style={{ marginBottom: 3 }}>
              {mdInline(it, `li${key}-${idx}`)}
            </li>
          ))}
        </Tag>,
      );
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // paragraph: gather consecutive non-blank, non-special lines
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*(?:[-*•]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key++} style={{ margin: '4px 0', lineHeight: 1.62 }}>
        {mdInline(para.join(' '), `p${key}`)}
      </p>,
    );
  }
  return <div style={{ color: 'var(--text-2)', fontSize: 14.5 }}>{blocks}</div>;
}

/* ---------------------------------------------------------------- segment theme */
const KIND = {
  explain: { icon: 'doc', label: 'Concept', tone: 'accent' },
  example: { icon: 'terminal', label: 'Example', tone: 'accent' },
  analogy: { icon: 'spark', label: 'Analogy', tone: 'accent' },
  keypoints: { icon: 'check', label: 'Key points', tone: 'ok' },
  checkpoint: { icon: 'pulse', label: 'Checkpoint', tone: 'ok' },
  warning: { icon: 'alert', label: 'Watch out', tone: 'warn' },
};
function kindMeta(k) {
  return KIND[k] || KIND.explain;
}

/* ---------------------------------------------------------------- progress ring */
function Ring({ value, total, size = 38, stroke = 4 }) {
  const pct = total > 0 ? value / total : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ flex: 'none', transform: 'rotate(-90deg)' }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border-2)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        style={{ transition: 'stroke-dashoffset .4s ease' }}
      />
    </svg>
  );
}

function Bar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ height: 7, borderRadius: 99, background: 'var(--border-2)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: 'var(--accent)',
          borderRadius: 99,
          transition: 'width .4s ease',
        }}
      />
    </div>
  );
}

const STATUS_BADGE = {
  generating: { tone: 'warn', label: 'Building' },
  ready: { tone: 'ok', label: 'Ready' },
  failed: { tone: 'err', label: 'Failed' },
};

/* ================================================================ root */
function LearnHub() {
  const [courseId, setCourseId] = useState(null);
  return courseId ? (
    <CoursePlayer courseId={courseId} onBack={() => setCourseId(null)} />
  ) : (
    <Library onOpen={setCourseId} />
  );
}

/* ================================================================ library */
const EXAMPLES = [
  'How neural networks actually learn',
  'The basics of options trading',
  'Why the Roman Republic fell',
  'Photosynthesis, end to end',
  'Rust ownership and borrowing',
  'How vaccines train the immune system',
];

function Library({ onOpen }) {
  const [status, setStatus] = useState(null);
  const [courses, setCourses] = useState(null);
  const [topic, setTopic] = useState('');
  const [depth, setDepth] = useState('standard');
  const [generator, setGenerator] = useState('local');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      window.api.get('/api/tudor/status'),
      window.api.get('/api/tudor/courses'),
    ]);
    if (s.ok) {
      setStatus(s.data);
      setDepth((d) => d || s.data.defaults.depth);
      setGenerator(s.data.defaults.generator || 'local');
    }
    if (c.ok) setCourses(c.data.courses);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(async () => {
    const t = topic.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    const r = await window.api.post('/api/tudor/courses', { topic: t, depth, generator });
    setBusy(false);
    if (r.ok && r.data && r.data.id) {
      setTopic('');
      onOpen(r.data.id);
    } else {
      setErr((r.data && r.data.error) || r.error || 'Could not start the course.');
    }
  }, [topic, depth, generator, busy, onOpen]);

  const remove = useCallback(
    async (id) => {
      await window.api.post(`/api/tudor/courses/${id}/delete`, {});
      load();
    },
    [load],
  );

  const codex = status && status.codexAvailable;
  const localModel = (status && status.localModel) || 'local model';

  return (
    <div>
      <window.SectionTitle sub="Turn any topic into a course you can actually walk through — built once, then instant to learn.">
        Learn
      </window.SectionTitle>

      {/* composer */}
      <window.Card pad={22} style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: 'var(--accent-soft)',
              color: 'var(--accent-strong)',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            <window.Icon name="spark" size={19} />
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>What do you want to learn?</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              Tudor designs the modules, writes every lesson, and quizzes you as you go.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <window.Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
              }}
              placeholder="e.g. how neural networks learn"
              aria-label="Course topic"
            />
          </div>
          <window.Button
            variant="primary"
            icon="spark"
            onClick={create}
            disabled={busy || !topic.trim()}
          >
            {busy ? 'Starting…' : 'Build course'}
          </window.Button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setTopic(ex)}
              style={{
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
                borderRadius: 99,
                padding: '5px 11px',
                fontSize: 12.5,
                cursor: 'pointer',
              }}
            >
              {ex}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>Depth</span>
            <window.Segmented
              size="sm"
              value={depth}
              onChange={setDepth}
              options={[
                { value: 'quick', label: 'Quick' },
                { value: 'standard', label: 'Standard' },
                { value: 'deep', label: 'Deep' },
              ]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>
              Built by
            </span>
            {codex ? (
              <window.Segmented
                size="sm"
                value={generator}
                onChange={setGenerator}
                options={[
                  { value: 'local', label: 'Local' },
                  { value: 'codex', label: 'Codex' },
                ]}
              />
            ) : (
              <window.Badge tone="neutral">{localModel}</window.Badge>
            )}
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-3)', flex: 1, textAlign: 'right' }}>
            {generator === 'codex'
              ? 'Codex is faster but uses your daily budget. Falls back to local automatically.'
              : `Built locally on ${localModel} — free, and a few minutes on a small box.`}
          </span>
        </div>
        {err && (
          <div style={{ marginTop: 12, color: 'var(--err)', fontSize: 13 }}>
            <window.Icon name="alert" size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {err}
          </div>
        )}
      </window.Card>

      {/* library */}
      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-2)', marginBottom: 12 }}>
        Your courses
      </div>
      {courses === null ? (
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading…</div>
      ) : courses.length === 0 ? (
        <window.Card pad={28} style={{ textAlign: 'center', color: 'var(--text-3)' }}>
          <window.Icon
            name="spark"
            size={26}
            style={{ margin: '0 auto 8px', color: 'var(--text-3)' }}
          />
          <div style={{ fontSize: 14 }}>
            No courses yet. Pick a topic above and build your first one.
          </div>
        </window.Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 14,
          }}
        >
          {courses.map((c) => (
            <CourseCard
              key={c.id}
              course={c}
              onOpen={() => onOpen(c.id)}
              onDelete={() => remove(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CourseCard({ course, onOpen, onDelete }) {
  const badge = STATUS_BADGE[course.status] || STATUS_BADGE.ready;
  const done = course.doneCount || 0;
  const ready = course.readyCount || 0;
  const total = course.lessonCount || 0;
  const building = course.status === 'generating';
  return (
    <window.Card
      pad={16}
      hover
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 12 }}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 15.5,
              color: 'var(--text)',
              lineHeight: 1.3,
              marginBottom: 3,
            }}
          >
            {course.title || course.topic}
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--text-3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {course.topic}
          </div>
        </div>
        <window.Badge tone={badge.tone}>{badge.label}</window.Badge>
      </div>

      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12,
            marginBottom: 5,
          }}
        >
          <span style={{ color: 'var(--text-3)' }}>
            {building ? `${ready}/${total || '…'} lessons ready` : `${done}/${total} learned`}
          </span>
          <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            {course.model || ''}
          </span>
        </div>
        <Bar value={building ? ready : done} total={total || 1} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <window.Button size="sm" variant="subtle" icon={building ? 'pulse' : 'fwd'}>
          {building ? 'Watch it build' : done > 0 ? 'Continue' : 'Start'}
        </window.Button>
        <window.IconButton
          name="trash"
          label="Delete course"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        />
      </div>
    </window.Card>
  );
}

/* ================================================================ course player */
function lessonSig(snap) {
  if (!snap) return '';
  const ready = snap.lessons.filter((l) => l.status === 'ready').length;
  const failed = snap.lessons.filter((l) => l.status === 'failed').length;
  return `${snap.status}|${snap.title || ''}|${ready}|${failed}`;
}

function CoursePlayer({ courseId, onBack }) {
  const [tree, setTree] = useState(null);
  const [snap, setSnap] = useState(null);
  const [currentLessonId, setCurrentLessonId] = useState(null);
  const [review, setReview] = useState(false);
  const esRef = useRef(null);
  const sigRef = useRef('');

  const fetchTree = useCallback(async () => {
    const r = await window.api.get(`/api/tudor/courses/${courseId}`);
    if (r.ok) setTree(r.data);
    return r.ok ? r.data : null;
  }, [courseId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await fetchTree();
      if (!alive || !t) return;
      if (t.course.status === 'generating') {
        esRef.current = window.api.streamSSE(`/api/tudor/courses/${courseId}/events`, {
          onMessage: (_e, raw) => {
            let d;
            try {
              d = JSON.parse(raw);
            } catch (err) {
              return;
            }
            if (d.type === 'snapshot') {
              setSnap(d);
              const sig = lessonSig(d);
              if (sig !== sigRef.current) {
                sigRef.current = sig;
                fetchTree();
              }
            } else if (d.type === 'done') {
              fetchTree();
              if (esRef.current) esRef.current.close();
            }
          },
        });
      }
    })();
    return () => {
      alive = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [courseId, fetchTree]);

  const allLessons = useMemo(
    () =>
      tree
        ? tree.modules.flatMap((m) => m.lessons.map((l) => ({ ...l, moduleTitle: m.title })))
        : [],
    [tree],
  );
  const currentLesson = allLessons.find((l) => l.id === currentLessonId) || null;
  const readyLessons = allLessons.filter((l) => l.status === 'ready');
  const doneCount = allLessons.filter((l) => l.progress === 'done').length;

  const recordProgress = useCallback(
    async (lessonId, state, confidence) => {
      await window.api.post(`/api/tudor/courses/${courseId}/progress`, {
        lessonId,
        state,
        confidence: confidence == null ? 0 : confidence,
      });
      fetchTree();
    },
    [courseId, fetchTree],
  );

  const openLesson = useCallback(
    (id) => {
      setReview(false);
      setCurrentLessonId(id);
      const l = allLessons.find((x) => x.id === id);
      if (l && l.progress === 'unseen') recordProgress(id, 'in_progress', 0);
    },
    [allLessons, recordProgress],
  );

  const nextAfter = useCallback(
    (id) => {
      const idx = readyLessons.findIndex((l) => l.id === id);
      return idx >= 0 && idx + 1 < readyLessons.length ? readyLessons[idx + 1] : null;
    },
    [readyLessons],
  );

  if (!tree) return <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading course…</div>;

  const course = tree.course;
  const building = course.status === 'generating';
  const job = snap || tree.job || { phase: 'outline', done: 0, total: 0 };

  return (
    <div>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <window.IconButton name="back" label="Back to courses" onClick={onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 21, lineHeight: 1.2 }}>{course.title || course.topic}</h2>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {course.topic} · {course.model || ''}
          </div>
        </div>
        {!building && readyLessons.length > 0 && (
          <window.Button
            variant={review ? 'primary' : 'subtle'}
            icon="copy"
            onClick={() => {
              setReview((v) => !v);
              setCurrentLessonId(null);
            }}
          >
            Review
          </window.Button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Ring value={doneCount} total={allLessons.length || 1} />
          <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {doneCount}/{allLessons.length} learned
          </span>
        </div>
      </div>

      {building && <GeneratingBanner job={job} />}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* course map */}
        <div style={{ width: 290, flex: 'none' }}>
          <CourseMap tree={tree} currentLessonId={currentLessonId} onPick={openLesson} />
        </div>

        {/* main panel */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {review ? (
            <ReviewMode tree={tree} onExit={() => setReview(false)} />
          ) : currentLesson ? (
            <LessonView
              key={currentLesson.id}
              courseId={courseId}
              lesson={currentLesson}
              hasNext={!!nextAfter(currentLesson.id)}
              onProgress={recordProgress}
              onNext={() => {
                const n = nextAfter(currentLesson.id);
                if (n) openLesson(n.id);
                else setCurrentLessonId(null);
              }}
            />
          ) : (
            <Overview
              course={course}
              building={building}
              readyLessons={readyLessons}
              onStart={() => readyLessons[0] && openLesson(readyLessons[0].id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function GeneratingBanner({ job }) {
  const phase = job.phase === 'lessons' ? 'Writing lessons' : 'Designing the course';
  const detail =
    job.phase === 'lessons' && job.total
      ? `${job.done} of ${job.total} lessons ready`
      : 'Mapping out the modules…';
  return (
    <window.Card
      pad={14}
      style={{
        marginBottom: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'var(--accent-soft)',
        borderColor: 'transparent',
      }}
    >
      <window.StatusDot state="starting" size={10} pulse />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{phase}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          {detail} — you can start any lesson the moment it's ready.
        </div>
      </div>
      {job.phase === 'lessons' && job.total > 0 && (
        <div style={{ width: 130 }}>
          <Bar value={job.done} total={job.total} />
        </div>
      )}
    </window.Card>
  );
}

function Overview({ course, building, readyLessons, onStart }) {
  return (
    <window.Card pad={26} style={{ textAlign: 'center' }}>
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'var(--accent-soft)',
          color: 'var(--accent-strong)',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 14px',
        }}
      >
        <window.Icon name="spark" size={26} />
      </span>
      <h3 style={{ fontSize: 18, marginBottom: 6 }}>{course.title || course.topic}</h3>
      <p style={{ color: 'var(--text-3)', fontSize: 14, maxWidth: 420, margin: '0 auto 18px' }}>
        {building
          ? 'Your course is building. Pick a lesson from the map as soon as it lights up — the rest keep compiling in the background.'
          : 'Pick up where you left off, or start from the top. Each lesson steps you through one idea at a time, then checks what stuck.'}
      </p>
      {readyLessons.length > 0 ? (
        <window.Button variant="primary" icon="fwd" onClick={onStart}>
          Start learning
        </window.Button>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13.5 }}>
          <window.StatusDot state="starting" size={9} pulse /> &nbsp;Preparing the first lesson…
        </div>
      )}
    </window.Card>
  );
}

/* ---------------------------------------------------------------- course map */
function CourseMap({ tree, currentLessonId, onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {tree.modules.map((m, mi) => (
        <div key={m.id}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 7 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text-3)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {String(mi + 1).padStart(2, '0')}
            </span>
            <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text)' }}>{m.title}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {m.lessons.map((l) => {
              const active = l.id === currentLessonId;
              const ready = l.status === 'ready';
              const failed = l.status === 'failed';
              return (
                <button
                  key={l.id}
                  disabled={!ready}
                  onClick={() => ready && onPick(l.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid',
                    borderColor: active ? 'transparent' : 'var(--border)',
                    background: active
                      ? 'var(--accent-soft)'
                      : ready
                        ? 'var(--surface)'
                        : 'transparent',
                    color: ready ? 'var(--text)' : 'var(--text-3)',
                    cursor: ready ? 'pointer' : 'default',
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <LessonDot lesson={l} />
                  <span style={{ flex: 1, lineHeight: 1.3 }}>{l.title}</span>
                  {l.progress === 'done' && l.confidence > 0 && (
                    <span style={{ fontSize: 13 }} title={`Confidence ${l.confidence}/3`}>
                      {['', '😕', '🙂', '😎'][l.confidence]}
                    </span>
                  )}
                  {failed && (
                    <window.Icon name="alert" size={13} style={{ color: 'var(--warn)' }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function LessonDot({ lesson }) {
  if (lesson.status === 'generating') return <window.StatusDot state="starting" size={8} pulse />;
  if (lesson.status === 'pending')
    return (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 99,
          background: 'var(--border-2)',
          flex: 'none',
        }}
      />
    );
  if (lesson.progress === 'done')
    return <window.Icon name="check" size={14} style={{ color: 'var(--ok)' }} />;
  return <window.StatusDot state={lesson.status === 'failed' ? 'error' : 'ok'} size={8} />;
}

/* ---------------------------------------------------------------- lesson view */
function LessonView({ courseId, lesson, hasNext, onProgress, onNext }) {
  // phase: walk segments, then quiz (if any), then a confidence rating.
  const segs = lesson.segments || [];
  const quizzes = lesson.quizzes || [];
  const [step, setStep] = useState(0); // 0..segs.length-1 = segment; segs.length = quiz/done
  const atQuiz = step >= segs.length;
  const total = segs.length;
  const containerRef = useRef(null);

  // keyboard navigation
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') setStep((s) => Math.min(segs.length, s + 1));
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [segs.length]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [step]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>
          {lesson.moduleTitle}
        </span>
        {lesson.est_minutes ? (
          <window.Badge tone="neutral">{lesson.est_minutes} min</window.Badge>
        ) : null}
      </div>
      <h3 style={{ fontSize: 19, marginBottom: 14 }}>{lesson.title}</h3>

      {/* stepper dots */}
      {total > 0 && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 16 }}>
          {segs.map((_, i) => (
            <div
              key={i}
              onClick={() => setStep(i)}
              style={{
                height: 5,
                flex: 1,
                borderRadius: 99,
                cursor: 'pointer',
                background: i <= step ? 'var(--accent)' : 'var(--border-2)',
                transition: 'background .2s',
              }}
            />
          ))}
          <div
            style={{
              height: 5,
              flex: 1,
              borderRadius: 99,
              background: atQuiz ? 'var(--accent)' : 'var(--border-2)',
            }}
          />
        </div>
      )}

      <div ref={containerRef} style={{ minHeight: 220 }}>
        {atQuiz ? (
          <LessonEnd
            quizzes={quizzes}
            onComplete={(confidence) => onProgress(lesson.id, 'done', confidence)}
            onNext={onNext}
            hasNext={hasNext}
          />
        ) : (
          <SegmentCard key={segs[step].id} segment={segs[step]} />
        )}
      </div>

      {/* nav */}
      {!atQuiz && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 18 }}>
          <window.Button
            variant="ghost"
            icon="back"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            Back
          </window.Button>
          <window.Button variant="primary" icon="fwd" onClick={() => setStep((s) => s + 1)}>
            {step === segs.length - 1 ? (quizzes.length ? 'Check yourself' : 'Finish') : 'Next'}
          </window.Button>
        </div>
      )}
    </div>
  );
}

function SegmentCard({ segment }) {
  const meta = kindMeta(segment.kind);
  const [variant, setVariant] = useState(null); // {mode, text} or {mode, loading:true}
  const cacheRef = useRef({});

  const rephrase = useCallback(
    async (mode) => {
      if (cacheRef.current[mode]) {
        setVariant({ mode, text: cacheRef.current[mode] });
        return;
      }
      setVariant({ mode, loading: true });
      const r = await window.api.post(`/api/tudor/segments/${segment.id}/rephrase`, { mode });
      if (r.ok && r.data && r.data.text) {
        cacheRef.current[mode] = r.data.text;
        setVariant({ mode, text: r.data.text });
      } else {
        setVariant({ mode, error: (r.data && r.data.error) || 'Could not rephrase right now.' });
      }
    },
    [segment.id],
  );

  return (
    <window.Card pad={22} style={{ animation: 'rise .2s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <window.Badge tone={meta.tone}>
          <window.Icon name={meta.icon} size={13} />
          {meta.label}
        </window.Badge>
      </div>
      <MD text={segment.body_md} />

      <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
        <window.Button size="sm" variant="subtle" onClick={() => rephrase('simpler')}>
          Explain it simpler
        </window.Button>
        <window.Button size="sm" variant="subtle" onClick={() => rephrase('deeper')}>
          Go deeper
        </window.Button>
      </div>

      {variant && (
        <div
          style={{
            marginTop: 14,
            padding: '14px 16px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
          }}
        >
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              color: 'var(--text-3)',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {variant.mode === 'simpler' ? 'Simpler' : 'Deeper'}
            <button
              onClick={() => setVariant(null)}
              style={{
                marginLeft: 'auto',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                color: 'var(--text-3)',
              }}
              aria-label="Dismiss"
            >
              <window.Icon name="x" size={14} />
            </button>
          </div>
          {variant.loading ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                color: 'var(--text-3)',
                fontSize: 13.5,
              }}
            >
              <window.StatusDot state="starting" size={9} pulse />
              Thinking… (local model — this can take up to a minute)
            </div>
          ) : variant.error ? (
            <div style={{ color: 'var(--err)', fontSize: 13.5 }}>{variant.error}</div>
          ) : (
            <MD text={variant.text} />
          )}
        </div>
      )}
    </window.Card>
  );
}

function LessonEnd({ quizzes, onComplete, onNext, hasNext }) {
  const [done, setDone] = useState(false);
  const [rated, setRated] = useState(false);

  return (
    <div>
      {quizzes.length > 0 && <Quiz quizzes={quizzes} onAllAnswered={() => setDone(true)} />}
      {(quizzes.length === 0 || done) && !rated && (
        <window.Card pad={22} style={{ marginTop: quizzes.length ? 16 : 0, textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
            How solid do you feel?
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16 }}>
            This fills your mastery map so you know what to revisit.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            {[
              { c: 1, emoji: '😕', label: 'Shaky' },
              { c: 2, emoji: '🙂', label: 'Okay' },
              { c: 3, emoji: '😎', label: 'Solid' },
            ].map((o) => (
              <button
                key={o.c}
                onClick={() => {
                  onComplete(o.c);
                  setRated(true);
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  padding: '12px 20px',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--text-2)',
                }}
              >
                <span style={{ fontSize: 26 }}>{o.emoji}</span>
                {o.label}
              </button>
            ))}
          </div>
        </window.Card>
      )}
      {rated && (
        <window.Card pad={22} style={{ marginTop: 16, textAlign: 'center' }}>
          <window.Icon
            name="check"
            size={28}
            style={{ color: 'var(--ok)', margin: '0 auto 8px' }}
          />
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 14 }}>Lesson complete!</div>
          {hasNext ? (
            <window.Button variant="primary" icon="fwd" onClick={onNext}>
              Next lesson
            </window.Button>
          ) : (
            <window.Button variant="subtle" icon="check" onClick={onNext}>
              Back to course
            </window.Button>
          )}
        </window.Card>
      )}
    </div>
  );
}

function Quiz({ quizzes, onAllAnswered }) {
  const [answers, setAnswers] = useState({}); // qIdx -> chosenIdx
  useEffect(() => {
    if (Object.keys(answers).length >= quizzes.length) onAllAnswered();
  }, [answers, quizzes.length, onAllAnswered]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {quizzes.map((q, qi) => {
        const choices = JSON.parse(q.choices_json);
        const chosen = answers[qi];
        const answered = chosen != null;
        return (
          <window.Card key={q.id} pad={20}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <window.Badge tone="ok">
                <window.Icon name="pulse" size={13} />
                Check
              </window.Badge>
            </div>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12, color: 'var(--text)' }}>
              {q.question}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {choices.map((choice, ci) => {
                const isCorrect = ci === q.answer_idx;
                const isChosen = ci === chosen;
                let bg = 'var(--surface-2)';
                let bd = 'var(--border)';
                let col = 'var(--text)';
                if (answered) {
                  if (isCorrect) {
                    bg = 'color-mix(in oklab, var(--ok) 14%, var(--surface))';
                    bd = 'color-mix(in oklab, var(--ok) 40%, transparent)';
                  } else if (isChosen) {
                    bg = 'color-mix(in oklab, var(--err) 12%, var(--surface))';
                    bd = 'color-mix(in oklab, var(--err) 38%, transparent)';
                  }
                }
                return (
                  <button
                    key={ci}
                    disabled={answered}
                    onClick={() => setAnswers((a) => ({ ...a, [qi]: ci }))}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      textAlign: 'left',
                      padding: '11px 13px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${bd}`,
                      background: bg,
                      color: col,
                      cursor: answered ? 'default' : 'pointer',
                      fontSize: 14,
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        flex: 'none',
                        display: 'grid',
                        placeItems: 'center',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--text-3)',
                      }}
                    >
                      {String.fromCharCode(65 + ci)}
                    </span>
                    <span style={{ flex: 1 }}>{choice}</span>
                    {answered && isCorrect && (
                      <window.Icon name="check" size={16} style={{ color: 'var(--ok)' }} />
                    )}
                    {answered && isChosen && !isCorrect && (
                      <window.Icon name="x" size={16} style={{ color: 'var(--err)' }} />
                    )}
                  </button>
                );
              })}
            </div>
            {answered && q.explain_md && (
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 13px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-2)',
                  fontSize: 13.5,
                  color: 'var(--text-2)',
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: chosen === q.answer_idx ? 'var(--ok)' : 'var(--text)' }}>
                  {chosen === q.answer_idx ? 'Correct. ' : 'Not quite. '}
                </strong>
                {q.explain_md}
              </div>
            )}
          </window.Card>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- review (flashcards) */
function buildCards(tree) {
  const cards = [];
  for (const m of tree.modules) {
    for (const l of m.lessons) {
      if (l.status !== 'ready') continue;
      for (const q of l.quizzes || []) {
        const choices = JSON.parse(q.choices_json);
        cards.push({
          front: q.question,
          back: `${choices[q.answer_idx]}${q.explain_md ? `\n\n${q.explain_md}` : ''}`,
          tag: l.title,
        });
      }
      for (const s of l.segments || []) {
        if (s.kind === 'keypoints')
          cards.push({ front: `Key points — ${l.title}`, back: s.body_md, tag: m.title });
      }
    }
  }
  return cards;
}

function ReviewMode({ tree, onExit }) {
  const cards = useMemo(() => buildCards(tree), [tree]);
  const [order, setOrder] = useState(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    // shuffle once on entry for varied recall practice
    setOrder((o) => {
      const a = [...o];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    });
  }, []);

  if (cards.length === 0) {
    return (
      <window.Card pad={26} style={{ textAlign: 'center', color: 'var(--text-3)' }}>
        No review cards yet — finish a lesson with a quiz or key points first.
        <div style={{ marginTop: 14 }}>
          <window.Button variant="subtle" onClick={onExit}>
            Back to course
          </window.Button>
        </div>
      </window.Card>
    );
  }

  const done = pos >= order.length;
  const card = !done ? cards[order[pos]] : null;

  const advance = (again) => {
    setFlipped(false);
    if (again) {
      // push this card to the end for another pass
      setOrder((o) => {
        const a = [...o];
        const [c] = a.splice(pos, 1);
        a.push(c);
        return a;
      });
    } else {
      setPos((p) => p + 1);
    }
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <window.Badge tone="accent">
          <window.Icon name="copy" size={13} />
          Flashcard review
        </window.Badge>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {Math.min(pos + 1, order.length)} / {order.length}
        </span>
      </div>

      {done ? (
        <window.Card pad={30} style={{ textAlign: 'center' }}>
          <window.Icon
            name="check"
            size={30}
            style={{ color: 'var(--ok)', margin: '0 auto 10px' }}
          />
          <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 14 }}>
            Review complete — nicely done.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <window.Button
              variant="subtle"
              icon="refresh"
              onClick={() => {
                setPos(0);
                setFlipped(false);
              }}
            >
              Again
            </window.Button>
            <window.Button variant="primary" onClick={onExit}>
              Back to course
            </window.Button>
          </div>
        </window.Card>
      ) : (
        <>
          <window.Card
            pad={30}
            onClick={() => setFlipped((f) => !f)}
            style={{
              cursor: 'pointer',
              minHeight: 200,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            <div
              style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 12, fontWeight: 600 }}
            >
              {card.tag}
            </div>
            {!flipped ? (
              <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>
                {card.front}
              </div>
            ) : (
              <MD text={card.back} />
            )}
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-3)' }}>
              {flipped ? '' : 'Click to reveal the answer'}
            </div>
          </window.Card>
          {flipped && (
            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
              <window.Button variant="subtle" icon="refresh" onClick={() => advance(true)}>
                Review again
              </window.Button>
              <window.Button variant="ok" icon="check" onClick={() => advance(false)}>
                Got it
              </window.Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

Object.assign(window, { LearnHub });
