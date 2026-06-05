/* global React, window */
const { useState, useEffect, useCallback } = React;

// The mission-control dashboard, wired to the live agent engine. Layout mirrors
// the Gurney Control Center mockup: active-workflow cards on top, a clickable
// workflow diagram that shows the selected task's delegation tree, then a run
// log on the left with agent status / system health stacked on the right.
//
// Data sources (all real):
//   - workflows / run log / agent status: /api/agents + /api/agents/tasks
//   - system health: the `system` block on /api/state (passed in as `state`)
// A "workflow" is a top-level task (parentId === null); its pipeline is that
// task plus the sub-agent tasks it delegated (parentId === root.id).
//
// Approvals and Project Memory have no backend yet, so their panels show an
// honest empty state rather than fabricated rows.

// Per-status presentation, shared by cards, the diagram, the run log, and the
// agent roster. `node` maps a task status onto a pipeline-node state.
const TASK_STATUS = {
  queued: { tone: 'yellow', label: 'Queued', node: 'pending', icon: 'clock', spin: false },
  running: { tone: 'blue', label: 'Running', node: 'active', icon: 'loader', spin: true },
  done: { tone: 'green', label: 'Done', node: 'done', icon: 'check-circle', spin: false },
  error: { tone: 'red', label: 'Error', node: 'error', icon: 'alert-triangle', spin: false },
  cancelled: { tone: 'gray', label: 'Cancelled', node: 'pending', icon: 'x', spin: false },
};
const TAG_TONES = ['green', 'blue', 'purple', 'yellow', 'gray'];
const tagTone = (agentId) =>
  TAG_TONES[((agentId % TAG_TONES.length) + TAG_TONES.length) % TAG_TONES.length];
const statusOf = (s) => TASK_STATUS[s] || TASK_STATUS.queued;

function relTime(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function truncate(text, n) {
  const t = String(text || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Build the renderable workflow objects: each top-level task, with its child
// (delegated) tasks resolved and a progress figure derived from them.
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
      const meta = statusOf(root.status);
      // Progress: real child-completion ratio when the task delegated; else a
      // coarse status-based figure so the bar still reads sensibly.
      const percent = children.length
        ? Math.round((doneKids / children.length) * 100)
        : ({ queued: 5, running: 50, done: 100, error: 100, cancelled: 100 }[root.status] ?? 0);
      const stepLabel = children.length
        ? `${doneKids} / ${children.length} sub-agents`
        : meta.label;
      // Unique agents taking part, in pipeline order.
      const seen = new Set();
      const tags = [];
      for (const t of [root, ...children]) {
        if (t.agentName && !seen.has(t.agentName)) {
          seen.add(t.agentName);
          tags.push({ tone: tagTone(t.agentId), label: t.agentName });
        }
      }
      return { root, children, percent, stepLabel, meta, tags };
    });
}

function WorkflowCard({ wf, selected, onSelect }) {
  const cls = `dash-card clickable${selected ? ' selected' : ''}`;
  const title = wf.root.agentName || `Task #${wf.root.id}`;
  return (
    <div
      className={cls}
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
          <h3 title={wf.root.prompt}>{truncate(title, 30)}</h3>
          <span className={`status-label ${wf.meta.tone}`}>
            <span className={`dot ${wf.meta.tone}`}></span> {wf.meta.label}
          </span>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.4 }}>
        {truncate(wf.root.prompt, 88)}
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
          #{wf.root.id} · {relTime(wf.root.createdAt)}
        </span>
      </div>
    </div>
  );
}

// Pipeline diagram for one workflow: an input node, the lead agent, then each
// delegated sub-agent — every node coloured by the task's real status.
function WorkflowDiagram({ wf }) {
  const nodes = [
    {
      icon: 'file-text',
      title: 'Input',
      desc: truncate(wf.root.prompt, 36),
      state: 'source',
    },
    {
      icon: 'spark',
      title: wf.root.agentName || `#${wf.root.id}`,
      desc: 'Lead agent',
      state: statusOf(wf.root.status).node,
    },
    ...wf.children.map((c) => ({
      icon: 'spark',
      title: c.agentName || `#${c.id}`,
      desc: truncate(c.prompt, 36),
      state: statusOf(c.status).node,
    })),
  ];
  return (
    <div className="workflow-diagram">
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

function DashboardTab({ state, onConfigureAgents }) {
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    const [a, t] = await Promise.all([
      window.api.get('/api/agents'),
      window.api.get('/api/agents/tasks'),
    ]);
    if (a.ok) setAgents(a.data.agents || []);
    if (t.ok) setTasks(t.data.tasks || []);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 3500);
    return () => clearInterval(id);
  }, [load]);

  const workflows = buildWorkflows(tasks);
  // Keep a stable selection: prefer the chosen id, else the first workflow.
  const selected = workflows.find((w) => w.root.id === selectedId) || workflows[0] || null;

  // ---- system health (real) ----
  const sys = state && state.system ? state.system : null;
  const cpu = sys && typeof sys.cpuPercent === 'number' ? sys.cpuPercent : null;
  const ram =
    sys && typeof sys.ramPercent === 'number'
      ? sys.ramPercent
      : state && state.ramGb
        ? Math.round((1 - state.freeRamGb / state.ramGb) * 100)
        : null;
  const queueDepth = sys
    ? sys.queueDepth
    : tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
  const errors24h = sys ? sys.errors24h : tasks.filter((t) => t.status === 'error').length;

  // ---- agent roster status (derived from live tasks) ----
  const agentStateOf = (agentId) => {
    const mine = tasks.filter((t) => t.agentId === agentId);
    if (mine.some((t) => t.status === 'running')) return { tone: 'green', label: 'Running' };
    if (mine.some((t) => t.status === 'queued')) return { tone: 'yellow', label: 'Queued' };
    return { tone: 'gray', label: 'Idle' };
  };

  return (
    <div className="dashboard-root">
      <div className="dash-header">
        <h2>Active Workflows</h2>
        <div className="dash-header-actions">
          <button className="dash-btn" onClick={onConfigureAgents}>
            <window.Icon name="spark" size={14} /> Configure Agents
          </button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="dash-card" style={{ marginBottom: 16 }}>
          <div style={{ color: 'var(--text-3)', fontSize: 14, padding: '8px 2px' }}>
            No active workflows. Dispatch a task to an agent from{' '}
            <button
              className="dash-btn sub"
              style={{ display: 'inline-flex', padding: '2px 6px' }}
              onClick={onConfigureAgents}
            >
              Configure Agents
            </button>{' '}
            and it will appear here.
          </div>
        </div>
      ) : (
        <div className="dash-grid">
          {workflows.map((wf) => (
            <WorkflowCard
              key={wf.root.id}
              wf={wf}
              selected={selected && wf.root.id === selected.root.id}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      )}

      {selected && (
        <div className="dash-section">
          <div className="section-header">
            <h3>
              <window.Icon name="git-merge" size={16} className="green-text" /> Workflow:{' '}
              {selected.root.agentName || `Task #${selected.root.id}`}
            </h3>
            <span className={`status-label ${selected.meta.tone}`}>
              <span className={`dot ${selected.meta.tone}`}></span> {selected.meta.label}
            </span>
          </div>
          <WorkflowDiagram wf={selected} />
        </div>
      )}

      <div className="dash-bottom-grid">
        <div className="dash-col-left">
          <div className="dash-panel">
            <div className="panel-header">
              <h3>
                <window.Icon name="activity" size={16} /> Live Run Log
              </h3>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onConfigureAgents && onConfigureAgents();
                }}
              >
                View all
              </a>
            </div>
            {tasks.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '6px 2px' }}>
                No agent activity yet.
              </div>
            ) : (
              <div className="log-table">
                {tasks.slice(0, 8).map((t) => {
                  const meta = statusOf(t.status);
                  const when = t.finishedAt || t.startedAt || t.createdAt;
                  return (
                    <div
                      key={t.id}
                      className={`log-row${t.status === 'error' ? ' yellow-bg' : ''}`}
                    >
                      <span className="time">{relTime(when)}</span>
                      <window.Icon
                        name={meta.icon}
                        size={14}
                        className={`${meta.tone}-text${meta.spin ? ' spin' : ''}`}
                      />
                      <span className={`msg${t.status === 'error' ? ' red-text' : ''}`}>
                        {t.status === 'error' && t.error ? t.error : truncate(t.prompt, 90)}
                      </span>
                      <span className={`tag ${tagTone(t.agentId)}`}>
                        {t.agentName || `#${t.agentId}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="dash-col-right">
          <div className="dash-panel">
            <div className="panel-header">
              <h3>
                <window.Icon name="activity" size={16} /> Agent Status
              </h3>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onConfigureAgents && onConfigureAgents();
                }}
              >
                Configure
              </a>
            </div>
            {agents.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '4px 2px' }}>
                No agents yet.
              </div>
            ) : (
              <div className="status-list">
                {agents.map((a) => {
                  const st = agentStateOf(a.id);
                  return (
                    <div className="status-item" key={a.id}>
                      <span className={`dot ${st.tone}`}></span> {a.name} <span>{st.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3>
                <window.Icon name="server" size={16} /> System Health
              </h3>
            </div>
            <div className="health-stats">
              <div className="stat-row">
                <span>
                  <window.Icon name="cpu" size={14} /> CPU
                </span>
                <div className="val">
                  {cpu == null ? '—' : `${cpu}%`}{' '}
                  <div className="mini-bar">
                    <div
                      className="fill green"
                      style={{ width: `${cpu == null ? 0 : cpu}%` }}
                    ></div>
                  </div>
                </div>
              </div>
              <div className="stat-row">
                <span>
                  <window.Icon name="database" size={14} /> RAM
                </span>
                <div className="val">
                  {ram == null ? '—' : `${ram}%`}{' '}
                  <div className="mini-bar">
                    <div
                      className="fill green"
                      style={{ width: `${ram == null ? 0 : ram}%` }}
                    ></div>
                  </div>
                </div>
              </div>
              <div className="stat-row">
                <span>
                  <window.Icon name="layers" size={14} /> Queue
                </span>
                <div className="val">{queueDepth}</div>
              </div>
              <div className="stat-row">
                <span>
                  <window.Icon name="alert-triangle" size={14} /> Errors (24h)
                </span>
                <div className={`val${errors24h > 0 ? ' red-text' : ''}`}>{errors24h}</div>
              </div>
            </div>
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3>
                <window.Icon name="shield" size={16} /> Approvals
              </h3>
            </div>
            <div
              style={{ color: 'var(--text-3)', fontSize: 13, padding: '4px 2px', lineHeight: 1.5 }}
            >
              No pending approvals. Agents currently run without a human-approval gate.
            </div>
          </div>

          <div className="dash-panel">
            <div className="panel-header">
              <h3>
                <window.Icon name="database" size={16} /> Memory
              </h3>
            </div>
            <div
              style={{ color: 'var(--text-3)', fontSize: 13, padding: '4px 2px', lineHeight: 1.5 }}
            >
              Project memory isn’t wired up. Enable the memory extension to surface stored facts
              here.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DashboardTab });
