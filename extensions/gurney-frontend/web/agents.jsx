/* global React, window */
// Agent command center. Lists personas (the "fleet"), lets you create/edit
// them, dispatch a task to one, and watch tasks stream through queued ->
// running -> done with their transcript and sub-agent tree. Mirrors the
// Hermes/OpenClaw control-plane idea: one screen to drive many agents.
//
// The panel only does CRUD + dispatch over HTTP; the daemon's resource-aware
// queue actually runs the tasks (and the heavy-model slot stays single-owner).
const { useState, useEffect, useCallback } = React;

const STATUS_TONE = {
  queued: 'neutral',
  running: 'accent',
  done: 'ok',
  error: 'err',
  cancelled: 'neutral',
};

const EMPTY_AGENT = {
  name: '',
  role: '',
  systemPrompt: '',
  profile: 'chat',
  toolAllowlist: null, // null = all tools
  maxToolRounds: 4,
  budgetTokens: null,
  executionMode: 'sequential',
  maxConcurrency: 1,
  canDelegate: false,
  delegatableAgents: [],
};

function listToText(list) {
  return Array.isArray(list) ? list.join(', ') : '';
}
function textToList(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Active Workflows — a visual read of the task table. A "workflow" is a
// top-level task (parentId == null); its pipeline is that task plus the
// sub-agent tasks it delegated. Clicking a card shows that delegation tree.
// ---------------------------------------------------------------------------

const WF_STATUS = {
  queued: { tone: 'yellow', label: 'Queued', node: 'pending', icon: 'clock', spin: false },
  running: { tone: 'blue', label: 'Running', node: 'active', icon: 'loader', spin: true },
  done: { tone: 'green', label: 'Done', node: 'done', icon: 'check-circle', spin: false },
  error: { tone: 'red', label: 'Error', node: 'error', icon: 'alert-triangle', spin: false },
  cancelled: { tone: 'gray', label: 'Cancelled', node: 'pending', icon: 'x', spin: false },
};
const WF_TAG_TONES = ['green', 'blue', 'purple', 'yellow', 'gray'];
const wfTagTone = (id) =>
  WF_TAG_TONES[((id % WF_TAG_TONES.length) + WF_TAG_TONES.length) % WF_TAG_TONES.length];
const wfStatusOf = (s) => WF_STATUS[s] || WF_STATUS.queued;

function wfRelTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function wfClip(text, n) {
  const t = String(text || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function buildWorkflows(tasks) {
  const childrenByParent = new Map();
  for (const t of tasks) {
    if (t.parentId != null) {
      const list = childrenByParent.get(t.parentId) || [];
      list.push(t);
      childrenByParent.set(t.parentId, list);
    }
  }
  return tasks
    .filter((t) => t.parentId == null)
    .slice(0, 6)
    .map((root) => {
      const children = (childrenByParent.get(root.id) || []).sort((a, b) => a.id - b.id);
      const doneKids = children.filter((c) => c.status === 'done').length;
      const meta = wfStatusOf(root.status);
      const percent = children.length
        ? Math.round((doneKids / children.length) * 100)
        : ({ queued: 5, running: 50, done: 100, error: 100, cancelled: 100 }[root.status] ?? 0);
      const stepLabel = children.length
        ? `${doneKids} / ${children.length} sub-agents`
        : meta.label;
      const seen = new Set();
      const tags = [];
      for (const t of [root, ...children]) {
        if (t.agentName && !seen.has(t.agentName)) {
          seen.add(t.agentName);
          tags.push({ tone: wfTagTone(t.agentId), label: t.agentName });
        }
      }
      return { root, children, percent, stepLabel, meta, tags };
    });
}

function WorkflowCard({ wf, selected, onSelect }) {
  const title = wf.root.agentName || `Task #${wf.root.id}`;
  return (
    <div
      className={`dash-card clickable${selected ? ' selected' : ''}`}
      onClick={() => onSelect(wf.root.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(wf.root.id);
        }
      }}
      aria-pressed={selected}
    >
      <div className="card-header">
        <div className={`card-icon ${wf.meta.tone}`}>
          <window.Icon name="spark" size={20} className={wf.meta.spin ? 'spin' : undefined} />
        </div>
        <div className="card-title">
          <h3 title={wf.root.prompt}>{wfClip(title, 30)}</h3>
          <span className={`status-label ${wf.meta.tone}`}>
            <span className={`dot ${wf.meta.tone}`}></span> {wf.meta.label}
          </span>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.4 }}>
        {wfClip(wf.root.prompt, 88)}
      </div>
      <div className="progress-section">
        <div className="progress-labels">
          <span>{wf.stepLabel}</span>
          <span>{wf.percent}%</span>
        </div>
        <div className="progress-bar">
          <div
            className={`progress-fill ${wf.meta.tone}`}
            style={{ width: `${wf.percent}%` }}
          ></div>
        </div>
      </div>
      {wf.tags.length > 0 && (
        <div className="agent-tags">
          {wf.tags.slice(0, 3).map((tag, i) => (
            <span key={i} className={`agent-tag ${tag.tone}`}>
              <window.Icon name="spark" size={12} /> {tag.label}
            </span>
          ))}
        </div>
      )}
      <div className="card-actions single">
        <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
          #{wf.root.id} · {wfRelTime(wf.root.createdAt)}
        </span>
      </div>
    </div>
  );
}

function WorkflowDiagram({ wf }) {
  const nodes = [
    { icon: 'file-text', title: 'Input', desc: wfClip(wf.root.prompt, 36), state: 'source' },
    {
      icon: 'spark',
      title: wf.root.agentName || `#${wf.root.id}`,
      desc: 'Lead agent',
      state: wfStatusOf(wf.root.status).node,
    },
    ...wf.children.map((c) => ({
      icon: 'spark',
      title: c.agentName || `#${c.id}`,
      desc: wfClip(c.prompt, 36),
      state: wfStatusOf(c.status).node,
    })),
  ];
  return (
    <div className="workflow-diagram" style={{ overflowX: 'auto' }}>
      {nodes.map((n, i) => {
        const arrowGreen = n.state === 'done' || n.state === 'active';
        return (
          <React.Fragment key={i}>
            {i > 0 && <div className={`arrow${arrowGreen ? ' green' : ''}`}>→</div>}
            <div className={`node${n.state === 'active' ? ' active' : ''}`}>
              <window.Icon name={n.icon} size={20} />
              <h4>{n.title}</h4>
              <p>{n.desc}</p>
              {n.state === 'done' && (
                <div className="status-check green">
                  <window.Icon name="check" size={12} />
                </div>
              )}
              {n.state === 'active' && (
                <div className="status-spinner">
                  <window.Icon name="loader" size={12} className="spin" />
                </div>
              )}
              {n.state === 'error' && (
                <div className="status-check red">
                  <window.Icon name="x" size={12} />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ActiveWorkflows({ tasks }) {
  const [selectedId, setSelectedId] = useState(null);
  const workflows = buildWorkflows(tasks);
  const selected = workflows.find((w) => w.root.id === selectedId) || workflows[0] || null;

  if (workflows.length === 0) {
    return (
      <window.Card>
        <div style={{ color: 'var(--text-3)', fontSize: 14, padding: '8px 2px' }}>
          No active workflows yet. Dispatch a task to an agent below and it shows up here, with any
          sub-agents it delegates to.
        </div>
      </window.Card>
    );
  }
  return (
    <div style={{ marginBottom: 26 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
          marginBottom: 14,
        }}
      >
        {workflows.map((wf) => (
          <WorkflowCard
            key={wf.root.id}
            wf={wf}
            selected={selected && wf.root.id === selected.root.id}
            onSelect={setSelectedId}
          />
        ))}
      </div>
      {selected && (
        <div className="dash-section" style={{ marginBottom: 0 }}>
          <div className="section-header">
            <h3>
              <window.Icon name="git-merge" size={16} className="green-text" /> Pipeline:{' '}
              {selected.root.agentName || `Task #${selected.root.id}`}
            </h3>
            <span className={`status-label ${selected.meta.tone}`}>
              <span className={`dot ${selected.meta.tone}`}></span> {selected.meta.label}
            </span>
          </div>
          <WorkflowDiagram wf={selected} />
        </div>
      )}
    </div>
  );
}

function AgentsTab() {
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [editing, setEditing] = useState(null); // agent object or EMPTY_AGENT when creating
  const [dispatchFor, setDispatchFor] = useState(null); // agent to dispatch to
  const [scheduleFor, setScheduleFor] = useState(null); // agent preselected for scheduling; null = choose in modal
  const [openTask, setOpenTask] = useState(null); // task id whose detail is open
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [a, t, s] = await Promise.all([
      window.api.get('/api/agents'),
      window.api.get('/api/agents/tasks'),
      window.api.get('/api/agents/schedules'),
    ]);
    if (a.ok) setAgents(a.data.agents || []);
    if (t.ok) setTasks(t.data.tasks || []);
    if (s.ok) setSchedules(s.data.schedules || []);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);

  const saveAgent = async (draft) => {
    setError('');
    const r = draft.id
      ? await fetchPut(`/api/agents/${draft.id}`, draft)
      : await window.api.post('/api/agents', draft);
    if (!r.ok) {
      setError(r.error || 'Save failed');
      return;
    }
    setEditing(null);
    load();
  };

  const removeAgent = async (agent) => {
    if (!window.confirm(`Delete agent “${agent.name}”? Its task history stays.`)) return;
    await fetchDelete(`/api/agents/${agent.id}`);
    load();
  };

  const dispatch = async (agent, prompt) => {
    setError('');
    const r = await window.api.post(`/api/agents/${agent.id}/dispatch`, { prompt });
    if (!r.ok) {
      setError(r.error || 'Dispatch failed');
      return;
    }
    setDispatchFor(null);
    load();
  };

  const cancelTask = async (task) => {
    if (!task || !['queued', 'running'].includes(task.status)) return;
    await window.api.post(`/api/agents/tasks/${task.id}/cancel`);
    load();
  };

  const createSchedule = async (draft) => {
    setError('');
    const r = await window.api.post('/api/agents/schedules', draft);
    if (!r.ok) {
      setError(r.error || 'Schedule failed');
      return;
    }
    setScheduleFor(null);
    load();
  };

  const removeSchedule = async (schedule) => {
    await fetchDelete(`/api/agents/schedules/${schedule.id}`);
    load();
  };

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', width: '100%' }}>
      <window.SectionTitle
        sub="Define personas, dispatch tasks, and watch them run. One heavy reasoning model runs at a time — tiny models can run in parallel."
        right={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <window.Button icon="send" variant="subtle" onClick={() => setScheduleFor({})}>
              Schedule
            </window.Button>
            <window.Button
              icon="plus"
              variant="primary"
              onClick={() => setEditing({ ...EMPTY_AGENT })}
            >
              New agent
            </window.Button>
          </div>
        }
      >
        Agents
      </window.SectionTitle>

      {error && (
        <div style={{ marginBottom: 14 }}>
          <window.Badge tone="err">{error}</window.Badge>
        </div>
      )}

      <window.SectionTitle sub="Live top-level tasks and the sub-agents they delegated to.">
        Active Workflows
      </window.SectionTitle>
      <ActiveWorkflows tasks={tasks} />

      <window.SectionTitle sub="Personas you can dispatch tasks to or schedule.">
        Fleet
      </window.SectionTitle>
      {agents.length === 0 ? (
        <window.Card>
          <div style={{ color: 'var(--text-3)', fontSize: 14, padding: '8px 2px' }}>
            No agents yet. Create a persona — a name, a system prompt, a model, and the tools it may
            use — then dispatch a task to it.
          </div>
        </window.Card>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 14,
            marginBottom: 26,
          }}
        >
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onEdit={() => setEditing(a)}
              onDelete={() => removeAgent(a)}
              onDispatch={() => setDispatchFor(a)}
              onSchedule={() => setScheduleFor(a)}
            />
          ))}
        </div>
      )}

      <window.SectionTitle sub="Most recent runs across all agents.">Tasks</window.SectionTitle>
      <TaskList tasks={tasks} onOpen={(id) => setOpenTask(id)} onCancel={cancelTask} />

      <window.SectionTitle sub="Timed one-shot and recurring agent work.">
        Schedules
      </window.SectionTitle>
      <ScheduleList schedules={schedules} onDelete={removeSchedule} />

      {editing && (
        <AgentEditor
          initial={editing}
          agents={agents}
          onClose={() => setEditing(null)}
          onSave={saveAgent}
          error={error}
        />
      )}
      {dispatchFor && (
        <DispatchModal
          agent={dispatchFor}
          onClose={() => setDispatchFor(null)}
          onDispatch={(p) => dispatch(dispatchFor, p)}
        />
      )}
      {scheduleFor && (
        <ScheduleModal
          agents={agents}
          initialAgent={scheduleFor.id ? scheduleFor : null}
          onClose={() => setScheduleFor(null)}
          onSchedule={createSchedule}
        />
      )}
      {openTask != null && (
        <TaskDetail
          taskId={openTask}
          onClose={() => setOpenTask(null)}
          onCancelled={() => {
            setOpenTask(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function AgentCard({ agent, onEdit, onDelete, onDispatch, onSchedule }) {
  const tools =
    agent.toolAllowlist === null
      ? 'all tools'
      : agent.toolAllowlist.length === 0
        ? 'no tools'
        : `${agent.toolAllowlist.length} tool grant${agent.toolAllowlist.length === 1 ? '' : 's'}`;
  return (
    <window.Card style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>{agent.name}</span>
        <window.Badge tone="accent">{agent.profile}</window.Badge>
        <window.Badge tone="neutral">{agent.executionMode}</window.Badge>
      </div>
      {agent.role && <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{agent.role}</div>}
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--text-3)',
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span>{tools}</span>
        {agent.canDelegate && <window.Badge tone="warn">can delegate</window.Badge>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <window.Button size="sm" variant="primary" icon="send" onClick={onDispatch}>
          Dispatch
        </window.Button>
        <window.Button size="sm" variant="subtle" icon="send" onClick={onSchedule}>
          Schedule
        </window.Button>
        <window.Button size="sm" variant="subtle" icon="gear" onClick={onEdit}>
          Edit
        </window.Button>
        <window.Button size="sm" variant="subtle" icon="trash" onClick={onDelete} />
      </div>
    </window.Card>
  );
}

function TaskList({ tasks, onOpen, onCancel }) {
  if (tasks.length === 0) {
    return (
      <window.Card>
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>No tasks dispatched yet.</div>
      </window.Card>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {tasks.map((t) => (
        <div
          key={t.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            textAlign: 'left',
            padding: '10px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          <button
            onClick={() => onOpen(t.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              minWidth: 0,
              flex: 1,
              border: 0,
              background: 'transparent',
              color: 'inherit',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <window.Badge tone={STATUS_TONE[t.status] || 'neutral'}>{t.status}</window.Badge>
            <span style={{ fontWeight: 600, fontSize: 13, minWidth: 90 }}>
              {t.agentName || `#${t.agentId}`}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 13,
                color: 'var(--text-2)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t.parentId ? '↳ ' : ''}
              {t.prompt}
            </span>
            <span
              style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}
            >
              #{t.id}
            </span>
          </button>
          {['queued', 'running'].includes(t.status) && (
            <window.Button
              size="sm"
              variant="subtle"
              icon="stop"
              danger
              onClick={() => onCancel(t)}
              title="Stop task"
            />
          )}
        </div>
      ))}
    </div>
  );
}

function DispatchModal({ agent, onClose, onDispatch }) {
  const [prompt, setPrompt] = useState('');
  return (
    <window.Modal
      open
      onClose={onClose}
      title={`Dispatch to ${agent.name}`}
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="send"
            disabled={!prompt.trim()}
            onClick={() => onDispatch(prompt.trim())}
          >
            Dispatch
          </window.Button>
        </>
      }
    >
      <window.Label hint="The agent runs this in the background; watch it under Tasks.">
        Task
      </window.Label>
      <textarea
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="e.g. Summarize my unread email and draft three replies"
        style={{
          width: '100%',
          resize: 'vertical',
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--text)',
          font: 'inherit',
        }}
      />
    </window.Modal>
  );
}

function localDateTimeValue(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function parseLocalDateTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function ScheduleList({ schedules, onDelete }) {
  if (schedules.length === 0) {
    return (
      <window.Card>
        <div style={{ color: 'var(--text-3)', fontSize: 14 }}>No schedules yet.</div>
      </window.Card>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 26 }}>
      {schedules.map((s) => (
        <div
          key={s.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <window.Badge tone={s.active ? 'accent' : 'neutral'}>
            {s.active ? s.recurrence : 'done'}
          </window.Badge>
          <span style={{ fontWeight: 600, fontSize: 13, minWidth: 130 }}>
            {(s.agentNames || []).join(', ')}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: 'var(--text-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.prompt}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
            {new Date(s.nextRunAt).toLocaleString()}
          </span>
          <window.Button size="sm" variant="subtle" icon="trash" onClick={() => onDelete(s)} />
        </div>
      ))}
    </div>
  );
}

function ScheduleModal({ agents, initialAgent, onClose, onSchedule }) {
  const [selected, setSelected] = useState(() => (initialAgent ? [initialAgent.id] : []));
  const [prompt, setPrompt] = useState('');
  const [when, setWhen] = useState(() => localDateTimeValue(Date.now() + 60 * 60_000));
  const [recurrence, setRecurrence] = useState('once');
  const toggleAgent = (id) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const nextRunAt = parseLocalDateTime(when);
  const invalidTime = nextRunAt === null || nextRunAt <= Date.now();
  return (
    <window.Modal
      open
      onClose={onClose}
      width={560}
      title="Schedule agents"
      footer={
        <>
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="send"
            disabled={selected.length === 0 || !prompt.trim() || invalidTime}
            onClick={() =>
              onSchedule({
                agentIds: selected,
                prompt: prompt.trim(),
                nextRunAt,
                recurrence,
              })
            }
          >
            Schedule
          </window.Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Agents">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => toggleAgent(a.id)}
                style={{
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${selected.includes(a.id) ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected.includes(a.id) ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 13,
                }}
              >
                {a.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Task">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="e.g. Run my morning briefing and draft today's priorities"
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          />
        </Field>
        <Row>
          <Field label="Date and time">
            <window.Input
              type="datetime-local"
              value={when}
              min={localDateTimeValue(Date.now() + 60_000)}
              onChange={(e) => setWhen(e.target.value)}
            />
          </Field>
          <Field label="Repeat">
            <window.Select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="once">once</option>
              <option value="daily">daily</option>
              <option value="weekly">weekly</option>
            </window.Select>
          </Field>
        </Row>
      </div>
    </window.Modal>
  );
}

function AgentEditor({ initial, agents, onClose, onSave, error }) {
  const [d, setD] = useState(() => ({
    ...EMPTY_AGENT,
    ...initial,
    delegatableAgents: initial.delegatableAgents || [],
  }));
  const set = (k, v) => setD((s) => ({ ...s, [k]: v }));
  const allowlistText = d.toolAllowlist === null ? '' : listToText(d.toolAllowlist);
  const otherAgents = agents.filter((a) => a.id !== d.id).map((a) => a.name);

  return (
    <window.Modal
      open
      onClose={onClose}
      width={560}
      title={d.id ? `Edit ${initial.name}` : 'New agent'}
      footer={
        <>
          {error && <window.Badge tone="err">{error}</window.Badge>}
          <window.Button variant="subtle" onClick={onClose}>
            Cancel
          </window.Button>
          <window.Button
            variant="primary"
            icon="check"
            disabled={!d.name.trim() || !d.systemPrompt.trim()}
            onClick={() => onSave(d)}
          >
            Save
          </window.Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Row>
          <Field label="Name">
            <window.Input
              value={d.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="researcher"
            />
          </Field>
          <Field label="Model profile" hint="reason = heavy 9B; chat/tools = tiny">
            <window.Select value={d.profile} onChange={(e) => set('profile', e.target.value)}>
              <option value="chat">chat</option>
              <option value="tools">tools</option>
              <option value="reason">reason (heavy)</option>
            </window.Select>
          </Field>
        </Row>
        <Field label="Role" hint="One line; shown on the card.">
          <window.Input
            value={d.role}
            onChange={(e) => set('role', e.target.value)}
            placeholder="Gathers facts from the web"
          />
        </Field>
        <Field label="System prompt">
          <textarea
            value={d.systemPrompt}
            onChange={(e) => set('systemPrompt', e.target.value)}
            rows={5}
            placeholder="You are a focused research agent. …"
            style={{
              width: '100%',
              resize: 'vertical',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              font: 'inherit',
            }}
          />
        </Field>
        <Field
          label="Tool allowlist"
          hint="Comma-separated extension or tool names. Leave blank for ALL tools; a single space-cleared value means none."
        >
          <window.Input
            value={allowlistText}
            placeholder="gurney-websearch, gurney-everyday-assistant"
            onChange={(e) => {
              const txt = e.target.value;
              set('toolAllowlist', txt.trim() === '' ? null : textToList(txt));
            }}
          />
        </Field>
        <Row>
          <Field label="Execution mode" hint="sequential = one of its tasks at a time">
            <window.Select
              value={d.executionMode}
              onChange={(e) => set('executionMode', e.target.value)}
            >
              <option value="sequential">sequential</option>
              <option value="parallel">parallel</option>
            </window.Select>
          </Field>
          <Field label="Max concurrency" hint="Parallel mode only">
            <window.Input
              type="number"
              min={1}
              max={8}
              value={d.maxConcurrency}
              onChange={(e) => set('maxConcurrency', Number(e.target.value))}
            />
          </Field>
          <Field label="Max tool rounds">
            <window.Input
              type="number"
              min={1}
              max={12}
              value={d.maxToolRounds}
              onChange={(e) => set('maxToolRounds', Number(e.target.value))}
            />
          </Field>
        </Row>
        <Field
          label="Delegation"
          hint="Allow this agent to spawn sub-agents (the spawn_agent tool)."
        >
          <window.Toggle
            checked={!!d.canDelegate}
            onChange={(v) => set('canDelegate', v)}
            label="Can delegate"
          />
        </Field>
        {d.canDelegate && (
          <Field
            label="May delegate to"
            hint="Comma-separated agent names. Leave blank to allow any agent."
          >
            <window.Input
              value={listToText(d.delegatableAgents)}
              placeholder={otherAgents.join(', ')}
              onChange={(e) => set('delegatableAgents', textToList(e.target.value))}
            />
          </Field>
        )}
      </div>
    </window.Modal>
  );
}

function TaskDetail({ taskId, onClose, onCancelled }) {
  const [detail, setDetail] = useState(null);
  const load = useCallback(async () => {
    const r = await window.api.get(`/api/agents/tasks/${taskId}`);
    if (r.ok) setDetail(r.data);
  }, [taskId]);
  useEffect(() => {
    load();
    const id = setInterval(load, 2500);
    return () => clearInterval(id);
  }, [load]);

  const task = detail && detail.task;
  const running = task && (task.status === 'queued' || task.status === 'running');
  const cancel = async () => {
    await window.api.post(`/api/agents/tasks/${taskId}/cancel`);
    onCancelled ? onCancelled() : load();
  };

  return (
    <window.Modal
      open
      onClose={onClose}
      width={640}
      title={detail ? `Task #${task.id} · ${detail.agentName || ''}` : 'Task'}
      footer={
        <>
          {task && ['queued', 'running'].includes(task.status) && (
            <window.Button variant="subtle" icon="stop" danger onClick={cancel}>
              Stop
            </window.Button>
          )}
          <window.Button variant="primary" onClick={onClose}>
            Close
          </window.Button>
        </>
      }
    >
      {!detail ? (
        <div style={{ color: 'var(--text-3)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <window.Badge tone={STATUS_TONE[task.status] || 'neutral'}>{task.status}</window.Badge>
            {running && <window.StatusDot state="starting" size={9} pulse />}
            {task.depth > 0 && (
              <window.Badge tone="neutral">sub-agent · depth {task.depth}</window.Badge>
            )}
          </div>
          <div>
            <window.Label>Prompt</window.Label>
            <div style={{ fontSize: 13.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
              {task.prompt}
            </div>
          </div>
          {task.error && (
            <div>
              <window.Label>Error</window.Label>
              <div style={{ fontSize: 13, color: 'var(--err)' }}>{task.error}</div>
            </div>
          )}
          {detail.children && detail.children.length > 0 && (
            <div>
              <window.Label>Sub-agents</window.Label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.children.map((c) => (
                  <div
                    key={c.id}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
                  >
                    <window.Badge tone={STATUS_TONE[c.status] || 'neutral'}>
                      {c.status}
                    </window.Badge>
                    <span
                      style={{
                        color: 'var(--text-2)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.prompt}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <window.Label>Transcript</window.Label>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxHeight: 320,
                overflowY: 'auto',
                padding: 4,
              }}
            >
              {detail.transcript.length === 0 && (
                <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No transcript yet.</div>
              )}
              {detail.transcript.map((m, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--surface-2)',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: 'var(--text-3)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {m.role}
                  </span>
                  <div style={{ color: 'var(--text-2)', marginTop: 2 }}>{m.content}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </window.Modal>
  );
}

/* small layout helpers */
function Row({ children }) {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{children}</div>;
}
function Field({ label, hint, children }) {
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <window.Label hint={hint}>{label}</window.Label>
      {children}
    </div>
  );
}

/* The api client exposes get/post but not PUT/DELETE; add thin helpers that
 * reuse its token handling via window.api.url(). */
async function fetchPut(path, body) {
  return rawFetch('PUT', path, body);
}
async function fetchDelete(path) {
  return rawFetch('DELETE', path);
}
async function rawFetch(method, path, body) {
  try {
    const res = await fetch(window.api.url(path), {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }
    return res.ok
      ? { ok: true, data }
      : { ok: false, status: res.status, error: (data && data.error) || res.statusText };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), offline: true };
  }
}

Object.assign(window, { AgentsTab });
