/* global React, window */
// Learn Hub — the gurney-tudor front end. A topic goes in; a full interactive
// course comes out and you step through it. All playback reads pre-generated
// data (no model calls), so it's instant; only the build, the on-demand
// rephrase, and (optional) web research ever touch a model or the network.
// Self-contained: talks to /api/tudor/*.
const { useState, useEffect, useRef, useCallback, useMemo } = React;

/* ---------------------------------------------------------------- tiny markdown
   A small, safe markdown -> React renderer. Everything renders as React
   children (escaped by React), so there's no innerHTML / XSS surface. Handles
   the subset a lesson uses: headings, lists, blockquotes, fenced code, and
   inline **bold** / *italic* / `code`. */
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
      i++;
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

/* ---------------------------------------------------------------- segment theme
   Each kind gets a distinct hue + icon so a lesson has visual rhythm and the
   learner can tell "here's an analogy" from "watch out" at a glance. */
const KIND = {
  explain: {
    icon: 'doc',
    label: 'Concept',
    color: 'var(--accent-strong)',
    soft: 'var(--accent-soft)',
  },
  example: {
    icon: 'terminal',
    label: 'Example',
    color: 'var(--info)',
    soft: 'color-mix(in oklab, var(--info) 13%, transparent)',
  },
  analogy: {
    icon: 'spark',
    label: 'Analogy',
    color: 'oklch(0.58 0.14 300)',
    soft: 'oklch(0.58 0.14 300 / 0.13)',
  },
  keypoints: {
    icon: 'check',
    label: 'Key points',
    color: 'var(--accent-strong)',
    soft: 'var(--accent-soft)',
  },
  checkpoint: {
    icon: 'pulse',
    label: 'Checkpoint',
    color: 'var(--warn)',
    soft: 'color-mix(in oklab, var(--warn) 15%, transparent)',
  },
  warning: {
    icon: 'alert',
    label: 'Watch out',
    color: 'var(--err)',
    soft: 'color-mix(in oklab, var(--err) 12%, transparent)',
  },
};
function kindMeta(k) {
  return KIND[k] || KIND.explain;
}
function KindChip({ kind }) {
  const m = kindMeta(kind);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 700,
        padding: '4px 10px',
        borderRadius: 99,
        color: m.color,
        background: m.soft,
      }}
    >
      <window.Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

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
  const [models, setModels] = useState([]); // installed local model tags
  const [topic, setTopic] = useState('');
  const [depth, setDepth] = useState('standard');
  const [generator, setGenerator] = useState('local');
  const [modelTag, setModelTag] = useState(''); // exact local model for this build
  const [websearch, setWebsearch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Web-access approval modal: phase = 'searching' | 'choose' | 'none' | null.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [modalPhase, setModalPhase] = useState(null);
  const [sources, setSources] = useState(null);
  const [approved, setApproved] = useState(() => new Set());

  const load = useCallback(async () => {
    const [s, c, m] = await Promise.all([
      window.api.get('/api/tudor/status'),
      window.api.get('/api/tudor/courses'),
      window.api.get('/api/models'),
    ]);
    const list = m.ok && m.data && Array.isArray(m.data.models) ? m.data.models : [];
    setModels(list);
    if (s.ok) {
      setStatus(s.data);
      setDepth(s.data.defaults.depth || 'standard');
      setGenerator(s.data.defaults.generator || 'local');
      setWebsearch(!!s.data.defaults.useWebsearch);
      // Default the model picker to the configured default if it's installed.
      const def =
        s.data.localModel && list.indexOf(s.data.localModel) !== -1
          ? s.data.localModel
          : list[0] || '';
      setModelTag(def);
    }
    if (c.ok) setCourses(c.data.courses);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const webAvail = status && status.websearchAvailable;

  // The actual build request. `approvedSources`: an array (the websites the user
  // approved — may be empty), or undefined to let the job research on its own.
  const doCreate = useCallback(
    async (approvedSources) => {
      const t = topic.trim();
      if (!t || busy) return;
      setConfirmOpen(false);
      setBusy(true);
      setErr(null);
      const body = { topic: t, depth, generator, useWebsearch: websearch };
      if (generator === 'local' && modelTag) body.localModel = modelTag;
      if (approvedSources !== undefined) body.approvedSources = approvedSources;
      const r = await window.api.post('/api/tudor/courses', body);
      setBusy(false);
      if (r.ok && r.data && r.data.id) {
        setTopic('');
        onOpen(r.data.id);
      } else {
        setErr((r.data && r.data.error) || r.error || 'Could not start the course.');
      }
    },
    [topic, depth, generator, websearch, modelTag, busy, onOpen],
  );

  // Build click: if this course will touch the web and the gate is on, run the
  // search first and let the user approve each website before anything is used.
  const create = useCallback(async () => {
    const t = topic.trim();
    if (!t || busy) return;
    if (websearch && webAvail && status.confirmBeforeSearch) {
      setSources(null);
      setApproved(new Set());
      setModalPhase('searching');
      setConfirmOpen(true);
      const r = await window.api.post('/api/tudor/research/preview', { topic: t });
      const found = r.ok && r.data && Array.isArray(r.data.sources) ? r.data.sources : [];
      setSources(found);
      setApproved(new Set(found.map((_, i) => i)));
      setModalPhase(found.length ? 'choose' : 'none');
      return;
    }
    doCreate(undefined);
  }, [topic, busy, websearch, webAvail, status, doCreate]);

  const toggleApprove = useCallback((i) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  // Build with exactly the websites the user ticked (may be none).
  const buildSelected = useCallback(() => {
    const picked = (sources || []).filter((_, i) => approved.has(i));
    doCreate(picked);
  }, [sources, approved, doCreate]);

  // "Always allow" turns the gate off (persisted) and builds with every site
  // found. Re-enable any time from Extensions → gurney-websearch.
  const allowAlways = useCallback(async () => {
    await window.api.post('/api/extensions/gurney-websearch/settings', {
      confirm_before_search: false,
    });
    setStatus((s) => (s ? { ...s, confirmBeforeSearch: false } : s));
    doCreate(sources || []);
  }, [doCreate, sources]);

  const remove = useCallback(
    async (id) => {
      await window.api.post(`/api/tudor/courses/${id}/delete`, {});
      load();
    },
    [load],
  );

  const codex = status && status.codexAvailable;
  const localLabel = modelTag || (status && status.localModel) || 'local model';

  return (
    <div>
      <window.Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={modalPhase === 'choose' ? 'Approve websites for this topic' : 'Web access'}
        tone="shield"
        width={540}
        footer={
          modalPhase === 'choose' ? (
            <>
              <window.Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </window.Button>
              <window.Button variant="subtle" onClick={allowAlways}>
                Always allow
              </window.Button>
              <window.Button variant="primary" icon="spark" onClick={buildSelected}>
                {approved.size > 0
                  ? `Build with ${approved.size} site${approved.size === 1 ? '' : 's'}`
                  : 'Build without sources'}
              </window.Button>
            </>
          ) : modalPhase === 'none' ? (
            <>
              <window.Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </window.Button>
              <window.Button variant="primary" icon="spark" onClick={() => doCreate([])}>
                Build anyway
              </window.Button>
            </>
          ) : null
        }
      >
        {modalPhase === 'searching' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0' }}>
            <window.StatusDot state="starting" size={10} pulse />
            <span>
              Searching the web for <strong>“{topic.trim()}”</strong>…
            </span>
          </div>
        )}
        {modalPhase === 'none' && (
          <div>
            No web results came back for <strong>“{topic.trim()}”</strong>. You can build the course
            from the model’s own knowledge instead.
          </div>
        )}
        {modalPhase === 'choose' && (
          <div>
            <div style={{ marginBottom: 12, color: 'var(--text-2)' }}>
              Gurney found these websites. Approve which ones it may read for this topic — only the
              ones you allow are used, and they’re treated as untrusted reference, never as
              instructions.
            </div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 340,
                overflow: 'auto',
              }}
            >
              {(sources || []).map((s, i) => (
                <label
                  key={s.url + i}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 11,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    background: approved.has(i) ? 'var(--accent-soft)' : 'var(--surface-2)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ marginTop: 1 }}>
                    <window.Toggle
                      checked={approved.has(i)}
                      onChange={() => toggleApprove(i)}
                      label={`Allow ${s.domain || s.url}`}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
                      {s.title}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--accent-strong)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {s.domain || s.url}
                    </div>
                    {s.snippet && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--text-3)',
                          marginTop: 3,
                          lineHeight: 1.45,
                        }}
                      >
                        {s.snippet}
                      </div>
                    )}
                  </div>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
              “Always allow” builds with every site and stops asking — re-enable under Extensions →
              gurney-websearch.
            </div>
          </div>
        )}
      </window.Modal>

      <window.SectionTitle sub="Turn any topic into a course you can actually walk through — built once, then instant to learn.">
        Learn
      </window.SectionTitle>

      {/* composer */}
      <window.Card pad={22} style={{ marginBottom: 24, animation: 'rise .3s ease both' }}>
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
              <window.Badge tone="neutral">Local</window.Badge>
            )}
          </div>
          {generator === 'local' && models.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>Model</span>
              <window.Select
                value={modelTag}
                onChange={(e) => setModelTag(e.target.value)}
                style={{ minWidth: 170 }}
              >
                {models.map((mTag) => (
                  <option key={mTag} value={mTag}>
                    {mTag}
                  </option>
                ))}
              </window.Select>
            </div>
          )}
          {webAvail && (
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
              title="Search the web for current facts before designing the course"
            >
              <window.Toggle
                checked={websearch}
                onChange={setWebsearch}
                label="Research the web first"
              />
              <span style={{ fontSize: 12.5, color: 'var(--text-2)', fontWeight: 600 }}>
                <window.Icon
                  name="search"
                  size={13}
                  style={{ verticalAlign: -2, marginRight: 4 }}
                />
                Research first
              </span>
            </label>
          )}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-3)' }}>
          {generator === 'codex'
            ? 'Codex is faster but uses your daily budget. Falls back to local automatically.'
            : `Built locally on ${localLabel} — free, and a few minutes on a small box.`}
          {websearch && webAvail ? ' · You’ll approve which websites it uses first.' : ''}
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
  const complete = !building && total > 0 && done >= total;
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
        <window.Badge tone={complete ? 'accent' : badge.tone}>
          {complete ? 'Mastered' : badge.label}
        </window.Badge>
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
      // Don't mark a failed lesson as "in progress" — it has no content yet.
      if (l && l.status === 'ready' && l.progress === 'unseen')
        recordProgress(id, 'in_progress', 0);
    },
    [allLessons, recordProgress],
  );

  const retryLesson = useCallback(
    async (lessonId) => {
      await window.api.post(`/api/tudor/lessons/${lessonId}/regenerate`, {});
      await fetchTree();
    },
    [fetchTree],
  );

  const stopGeneration = useCallback(async () => {
    await window.api.post(`/api/tudor/courses/${courseId}/cancel`, {});
    fetchTree();
  }, [courseId, fetchTree]);

  const exportCourse = useCallback(() => {
    if (!tree) return;
    const lines = [];
    const sep = '='.repeat(80);
    lines.push(tree.course.title || tree.course.topic);
    if (tree.course.title) lines.push(`Topic: ${tree.course.topic}`);
    if (tree.course.model) lines.push(`Model: ${tree.course.model}`);
    lines.push(`Exported: ${new Date().toLocaleString()}`);
    lines.push('');
    tree.modules.forEach((mod, mi) => {
      lines.push(sep);
      lines.push(`MODULE ${mi + 1}: ${mod.title}`);
      lines.push('');
      mod.lessons.forEach((les, li) => {
        if (les.status !== 'ready') return;
        lines.push(`  LESSON ${li + 1}: ${les.title}${les.est_minutes ? ` (${les.est_minutes} min)` : ''}`);
        lines.push('');
        (les.segments || []).forEach((seg) => {
          const meta = kindMeta(seg.kind);
          lines.push(`    [${meta.label}]`);
          (seg.body_md || '').split('\n').forEach((l) => lines.push(`    ${l}`));
          lines.push('');
        });
        const quizzes = les.quizzes || [];
        if (quizzes.length) {
          lines.push('    QUIZ:');
          quizzes.forEach((q, qi) => {
            const choices = JSON.parse(q.choices_json);
            lines.push(`    Q${qi + 1}: ${q.question}`);
            choices.forEach((ch, ci) => lines.push(`    ${String.fromCharCode(65 + ci)}) ${ch}`));
            lines.push(`    Correct: ${String.fromCharCode(65 + q.answer_idx)}) ${choices[q.answer_idx]}`);
            if (q.explain_md) lines.push(`    Explanation: ${q.explain_md}`);
            lines.push('');
          });
        }
      });
    });
    lines.push(sep);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(tree.course.title || tree.course.topic).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [tree]);

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
  const complete = !building && allLessons.length > 0 && doneCount >= allLessons.length;

  return (
    <div>
      {/* hero header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 18,
          padding: '16px 18px',
          borderRadius: 'var(--radius)',
          background: 'linear-gradient(120deg, var(--accent-soft), transparent 70%)',
          border: '1px solid var(--border)',
        }}
      >
        <window.IconButton name="back" label="Back to courses" onClick={onBack} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 21, lineHeight: 1.2 }}>{course.title || course.topic}</h2>
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {course.topic} · {course.model || ''}
          </div>
        </div>
        {building && (
          <window.Button
            variant="subtle"
            icon="stop"
            onClick={stopGeneration}
            style={{ color: 'var(--err)', borderColor: 'color-mix(in oklab, var(--err) 38%, transparent)' }}
          >
            Stop
          </window.Button>
        )}
        {!building && readyLessons.length > 0 && (
          <window.Button variant="subtle" icon="doc" onClick={exportCourse}>
            Export
          </window.Button>
        )}
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
      {complete && !review && !currentLesson && <CompleteBanner onReview={() => setReview(true)} />}

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* course map */}
        <div style={{ width: 290, flex: 'none' }}>
          <CourseMap tree={tree} currentLessonId={currentLessonId} onPick={openLesson} />
        </div>

        {/* main panel */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {review ? (
            <ReviewMode tree={tree} onExit={() => setReview(false)} />
          ) : currentLesson && currentLesson.status === 'failed' ? (
            <FailedLessonView key={currentLesson.id} lesson={currentLesson} onRetry={retryLesson} />
          ) : currentLesson ? (
            <LessonView
              key={currentLesson.id}
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
            <>
              <Overview
                course={course}
                building={building}
                complete={complete}
                readyLessons={readyLessons}
                onStart={() => readyLessons[0] && openLesson(readyLessons[0].id)}
              />
              <SourcesPanel sources={tree.sources} />
            </>
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
      : 'Researching and mapping out the modules…';
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

function CompleteBanner({ onReview }) {
  return (
    <window.Card
      pad={16}
      style={{
        marginBottom: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'var(--accent-soft)',
        borderColor: 'transparent',
      }}
    >
      <span className="tudor-pop" style={{ fontSize: 24 }}>
        🎉
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
          You've completed every lesson!
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          Lock it in with a quick flashcard review.
        </div>
      </div>
      <window.Button variant="primary" icon="copy" onClick={onReview}>
        Review
      </window.Button>
    </window.Card>
  );
}

function SourcesPanel({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <window.Card pad={18} style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <window.Icon name="link" size={16} style={{ color: 'var(--accent-strong)' }} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>Websites used for this topic</span>
        <window.Badge tone="neutral">{sources.length}</window.Badge>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sources.map((s) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              textDecoration: 'none',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
            }}
          >
            <window.Icon name="doc" size={15} style={{ color: 'var(--text-3)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.title}
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--accent-strong)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {s.domain || s.url}
              </div>
            </div>
            <window.Icon name="link" size={14} style={{ color: 'var(--text-3)' }} />
          </a>
        ))}
      </div>
    </window.Card>
  );
}

function Overview({ course, building, complete, readyLessons, onStart }) {
  return (
    <window.Card pad={26} style={{ textAlign: 'center' }}>
      <span
        className="tudor-pop"
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
        <window.Icon name={complete ? 'check' : 'spark'} size={26} />
      </span>
      <h3 style={{ fontSize: 18, marginBottom: 6 }}>{course.title || course.topic}</h3>
      <p style={{ color: 'var(--text-3)', fontSize: 14, maxWidth: 420, margin: '0 auto 18px' }}>
        {building
          ? 'Your course is building. Pick a lesson from the map as soon as it lights up — the rest keep compiling in the background.'
          : 'Pick up where you left off, or start from the top. Each lesson steps you through one idea at a time, then checks what stuck.'}
      </p>
      {readyLessons.length > 0 ? (
        <window.Button variant="primary" icon="fwd" onClick={onStart}>
          {complete ? 'Revisit lessons' : 'Start learning'}
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
              const pendingish = l.status === 'pending' || l.status === 'generating';
              const openable = ready || failed; // failed lessons open a retry panel
              return (
                <button
                  key={l.id}
                  disabled={!openable}
                  onClick={() => openable && onPick(l.id)}
                  className={l.status === 'generating' ? 'tudor-shimmer' : ''}
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
                    cursor: openable ? 'pointer' : 'default',
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    opacity: pendingish && l.status === 'pending' ? 0.6 : 1,
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

/* ---------------------------------------------------------------- failed lesson */
function FailedLessonView({ lesson, onRetry }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const retry = async () => {
    setBusy(true);
    setErr(false);
    try {
      await onRetry(lesson.id);
      // On success the parent refetches and re-renders this lesson as ready, so
      // this component unmounts. If it's still here, the retry failed again.
      setErr(true);
    } catch (e) {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600, marginBottom: 4 }}>
        {lesson.moduleTitle}
      </div>
      <h3 style={{ fontSize: 19, marginBottom: 14 }}>{lesson.title}</h3>
      <window.Card pad={26} style={{ textAlign: 'center' }}>
        <span
          style={{
            width: 50,
            height: 50,
            borderRadius: 14,
            background: 'color-mix(in oklab, var(--warn) 15%, transparent)',
            color: 'var(--warn)',
            display: 'grid',
            placeItems: 'center',
            margin: '0 auto 14px',
          }}
        >
          <window.Icon name={busy ? 'refresh' : 'alert'} size={24} />
        </span>
        <h3 style={{ fontSize: 17, marginBottom: 6 }}>
          {busy ? 'Regenerating this lesson…' : "This lesson didn't generate"}
        </h3>
        <p style={{ color: 'var(--text-3)', fontSize: 14, maxWidth: 420, margin: '0 auto 18px' }}>
          {busy
            ? 'Building it now on the local model — this can take up to a minute.'
            : 'The model likely timed out or returned nothing — common for the first lessons while it warms up. Give it another go.'}
        </p>
        {err && !busy && (
          <div style={{ color: 'var(--err)', fontSize: 13, marginBottom: 12 }}>
            Still no luck. Check that Ollama is running, then try once more.
          </div>
        )}
        <window.Button variant="primary" icon="refresh" disabled={busy} onClick={retry}>
          {busy ? 'Working…' : 'Retry lesson'}
        </window.Button>
      </window.Card>
    </div>
  );
}

/* ---------------------------------------------------------------- visualization
   On-demand HTML visualization for a lesson. The model returns a full
   self-contained document; we render it inside a sandboxed iframe (srcDoc +
   sandbox="allow-scripts", null origin) so any JS in there can't reach the
   panel. The first build is slow (one local model call); the result is cached
   server-side, so a reopen is instant. "Regenerate" forces a fresh call. */
function VisualizationModal({ lessonId, lessonTitle, cachedHtml, onClose, onCached }) {
  const [html, setHtml] = useState(cachedHtml || null);
  const [busy, setBusy] = useState(!cachedHtml);
  const [err, setErr] = useState(null);

  const fetchViz = useCallback(
    async (force) => {
      setBusy(true);
      setErr(null);
      const r = await window.api.post(`/api/tudor/lessons/${lessonId}/visualize`, {
        force: !!force,
      });
      setBusy(false);
      if (r.ok && r.data && r.data.html) {
        setHtml(r.data.html);
        onCached(r.data.html);
      } else {
        setErr((r.data && r.data.error) || r.error || 'Could not build the visualization.');
      }
    },
    [lessonId, onCached],
  );

  useEffect(() => {
    if (!cachedHtml) fetchViz(false);
    // Only fire once on open; cachedHtml is captured at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openInTab = useCallback(() => {
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Tab can't be revoked instantly without breaking it; bounded leak.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [html]);

  return (
    <window.Modal
      open
      onClose={onClose}
      title={`Visualization · ${lessonTitle}`}
      width={980}
      footer={
        <>
          <window.Button variant="ghost" onClick={onClose}>
            Close
          </window.Button>
          {html && (
            <window.Button variant="subtle" icon="link" onClick={openInTab}>
              Open in tab
            </window.Button>
          )}
          <window.Button
            variant={html ? 'subtle' : 'primary'}
            icon="refresh"
            onClick={() => fetchViz(true)}
            disabled={busy}
          >
            {html ? 'Regenerate' : 'Try again'}
          </window.Button>
        </>
      }
    >
      {busy && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 0',
            color: 'var(--text-2)',
          }}
        >
          <window.StatusDot state="starting" size={10} pulse />
          <span>
            Building the visualization on the local model — this can take a minute the first time.
          </span>
        </div>
      )}
      {err && !busy && (
        <div style={{ color: 'var(--err)', fontSize: 13, padding: '10px 0' }}>
          <window.Icon name="alert" size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          {err}
        </div>
      )}
      {html && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            background: '#0f1115',
          }}
        >
          <iframe
            title={`Visualization for ${lessonTitle}`}
            srcDoc={html}
            sandbox="allow-scripts"
            style={{ width: '100%', height: 600, border: 'none', display: 'block' }}
          />
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
        Rendered in a sandboxed frame — its scripts can't reach the panel.
      </div>
    </window.Modal>
  );
}

/* ---------------------------------------------------------------- lesson view */
function LessonView({ lesson, hasNext, onProgress, onNext }) {
  const segs = lesson.segments || [];
  const quizzes = lesson.quizzes || [];
  const [step, setStep] = useState(0);
  const atQuiz = step >= segs.length;
  const containerRef = useRef(null);
  const [vizOpen, setVizOpen] = useState(false);
  // Local mirror of the cached HTML so a regenerate inside the modal sticks
  // for this lesson view without forcing a full course refetch.
  const [cachedViz, setCachedViz] = useState(lesson.visualization_html || null);
  useEffect(() => {
    setCachedViz(lesson.visualization_html || null);
  }, [lesson.id, lesson.visualization_html]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|button/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        if (e.key === ' ') e.preventDefault();
        setStep((s) => Math.min(segs.length, s + 1));
      }
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <h3 style={{ fontSize: 19, flex: 1, minWidth: 0 }}>{lesson.title}</h3>
        <window.Button
          size="sm"
          variant={cachedViz ? 'primary' : 'subtle'}
          icon="spark"
          onClick={() => setVizOpen(true)}
          title={
            cachedViz
              ? 'Open the visualization for this lesson'
              : 'Build an HTML visualization for this lesson'
          }
        >
          Visualize
        </window.Button>
      </div>

      {vizOpen && (
        <VisualizationModal
          lessonId={lesson.id}
          lessonTitle={lesson.title}
          cachedHtml={cachedViz}
          onClose={() => setVizOpen(false)}
          onCached={setCachedViz}
        />
      )}

      {segs.length > 0 && (
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

      {!atQuiz && (
        <>
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
          <div
            style={{ textAlign: 'center', marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}
          >
            Tip: use <kbd>←</kbd> <kbd>→</kbd> or <kbd>space</kbd> to move through the lesson
          </div>
        </>
      )}
    </div>
  );
}

function SegmentCard({ segment }) {
  const meta = kindMeta(segment.kind);
  // Checkpoint segments are a retrieval prompt: hide the body so the learner
  // tries to answer in their head first, then reveals. Active recall > re-reading.
  const isCheckpoint = segment.kind === 'checkpoint';
  const [revealed, setRevealed] = useState(!isCheckpoint);
  const [variant, setVariant] = useState(null);
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
    <window.Card
      pad={22}
      style={{ animation: 'rise .22s ease both', borderLeft: `3px solid ${meta.color}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <KindChip kind={segment.kind} />
      </div>

      {revealed ? (
        <MD text={segment.body_md} />
      ) : (
        <div style={{ textAlign: 'center', padding: '18px 0' }}>
          <div style={{ fontSize: 14.5, color: 'var(--text-2)', marginBottom: 14 }}>
            <window.Icon
              name="pulse"
              size={16}
              style={{ verticalAlign: -3, marginRight: 6, color: meta.color }}
            />
            Pause and try to answer this in your head first.
          </div>
          <window.Button variant="subtle" icon="eye" onClick={() => setRevealed(true)}>
            Reveal
          </window.Button>
        </div>
      )}

      {revealed && (
        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          <window.Button size="sm" variant="subtle" onClick={() => rephrase('simpler')}>
            Explain it simpler
          </window.Button>
          <window.Button size="sm" variant="subtle" onClick={() => rephrase('deeper')}>
            Go deeper
          </window.Button>
        </div>
      )}

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
                  transition: 'transform .08s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')}
                onMouseLeave={(e) => (e.currentTarget.style.transform = '')}
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
          <div className="tudor-pop" style={{ fontSize: 30, marginBottom: 4 }}>
            🎯
          </div>
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
  const [answers, setAnswers] = useState({});
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
              <KindChip kind="checkpoint" />
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
                      color: 'var(--text)',
                      cursor: answered ? 'default' : 'pointer',
                      fontSize: 14,
                      transition: 'background .15s, border-color .15s',
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
                      <span className="tudor-pop">
                        <window.Icon name="check" size={16} style={{ color: 'var(--ok)' }} />
                      </span>
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
          back: `**${choices[q.answer_idx]}**${q.explain_md ? `\n\n${q.explain_md}` : ''}`,
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

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ReviewMode({ tree, onExit }) {
  const cards = useMemo(() => buildCards(tree), [tree]);
  const [order, setOrder] = useState(() => shuffle(cards.map((_, i) => i)));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [recall, setRecall] = useState('');
  const [missed, setMissed] = useState(() => new Set());

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

  const advance = (got) => {
    setFlipped(false);
    setRecall('');
    if (!got) setMissed((s) => new Set(s).add(order[pos]));
    setPos((p) => p + 1);
  };

  const restart = (onlyMissed) => {
    const base = onlyMissed ? [...missed] : cards.map((_, i) => i);
    setOrder(shuffle(base));
    setPos(0);
    setFlipped(false);
    setRecall('');
    setMissed(new Set());
  };

  const score = order.length - missed.size;

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
          <div className="tudor-pop" style={{ fontSize: 34, marginBottom: 8 }}>
            {missed.size === 0 ? '🏆' : '✅'}
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>
            {score} / {order.length} on the first try
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text-3)', marginBottom: 18 }}>
            {missed.size === 0
              ? 'Perfect recall — this has really stuck.'
              : `${missed.size} to firm up. Spaced practice is how it sticks.`}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {missed.size > 0 && (
              <window.Button variant="primary" icon="refresh" onClick={() => restart(true)}>
                Review the {missed.size} I missed
              </window.Button>
            )}
            <window.Button variant="subtle" icon="refresh" onClick={() => restart(false)}>
              Shuffle &amp; go again
            </window.Button>
            <window.Button variant="ghost" onClick={onExit}>
              Back to course
            </window.Button>
          </div>
        </window.Card>
      ) : (
        <>
          <window.Card
            pad={28}
            style={{
              minHeight: 210,
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
              <>
                <div
                  style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}
                >
                  {card.front}
                </div>
                <textarea
                  value={recall}
                  onChange={(e) => setRecall(e.target.value)}
                  placeholder="Type what you remember (optional) — then reveal…"
                  rows={2}
                  style={{
                    marginTop: 16,
                    width: '100%',
                    resize: 'vertical',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 14,
                    color: 'var(--text)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-2)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px',
                    outline: 'none',
                  }}
                />
              </>
            ) : (
              <>
                {recall.trim() && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-3)',
                      marginBottom: 10,
                      fontStyle: 'italic',
                    }}
                  >
                    You wrote: “{recall.trim()}”
                  </div>
                )}
                <MD text={card.back} />
              </>
            )}
          </window.Card>
          {!flipped ? (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <window.Button variant="primary" icon="eye" onClick={() => setFlipped(true)}>
                Reveal answer
              </window.Button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
              <window.Button variant="subtle" icon="refresh" onClick={() => advance(false)}>
                Didn't get it
              </window.Button>
              <window.Button variant="ok" icon="check" onClick={() => advance(true)}>
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
