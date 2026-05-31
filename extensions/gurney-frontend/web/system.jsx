/* global React, window */
// System & Diagnostics — the CLI power-features, integrated:
//   Status  → /api/state            (gurney status)
//   Doctor  → /api/doctor           (gurney doctor)
//   Logs    → /api/logs/stream SSE  (gurney logs -f)
//   Maint.  → /api/maintenance/update + Reset hand-off (gurney update / fresh)
//   Commands→ /api/commands         (the real core + extension Telegram commands)
const { useState: useStateSys, useEffect: useEffectSys, useRef: useRefSys } = React;

const SYSTEM_COMMAND_LABELS = {
  status: 'gurney status',
  doctor: 'gurney doctor',
  logs: 'gurney logs',
  commands: 'gurney --help',
};

function SystemTab({ state, onReset }) {
  const [sub, setSub] = useStateSys('status');
  const [cmd, setCmd] = useStateSys({
    running: true,
    result: { ok: true, command: SYSTEM_COMMAND_LABELS.status, output: '' },
  });
  const commandSeq = useRefSys(0);
  const subs = [
    { id: 'status', label: 'Status' },
    { id: 'doctor', label: 'Doctor' },
    { id: 'logs', label: 'Logs' },
    { id: 'maintenance', label: 'Maintenance' },
    { id: 'commands', label: 'Commands' },
  ];

  const runSystemTabCommand = async (name = sub) => {
    const command = SYSTEM_COMMAND_LABELS[name];
    if (!command) return;
    const seq = ++commandSeq.current;
    setCmd({ running: true, result: { ok: true, command, output: '' } });
    const result = await runPanelCommand(name);
    if (seq === commandSeq.current) setCmd({ running: false, result });
  };

  const showCommandOutput = (name, result = null) => {
    commandSeq.current += 1;
    setCmd({
      running: false,
      result: result || {
        ok: true,
        command: name === 'maintenance' ? 'gurney update' : SYSTEM_COMMAND_LABELS[name] || '',
        output: '',
      },
    });
  };

  const runMaintenanceUpdate = async () => {
    const seq = ++commandSeq.current;
    setCmd({ running: true, result: { ok: true, command: 'gurney update', output: '' } });
    const r = await window.api.post('/api/maintenance/update');
    const data = r.data || {};
    const result = {
      ok: r.ok && data.ok !== false,
      code: data.code,
      command: data.command || 'gurney update',
      output: data.output || r.error || '',
    };
    if (seq === commandSeq.current) setCmd({ running: false, result });
    return result;
  };

  const changeSub = (next) => {
    setSub(next);
    if (SYSTEM_COMMAND_LABELS[next]) {
      void runSystemTabCommand(next);
    } else {
      showCommandOutput(next);
    }
  };

  useEffectSys(() => {
    void runSystemTabCommand('status');
  }, []);

  return (
    <div>
      <window.SectionTitle sub="The deeper controls — health checks, logs, and maintenance. Everything the terminal can do.">
        System &amp; Diagnostics
      </window.SectionTitle>
      <div style={{ marginBottom: 20 }}>
        <window.Segmented value={sub} onChange={changeSub} options={subs} />
      </div>
      {sub === 'status' && <StatusDashboard state={state} />}
      {sub === 'doctor' && <Doctor onRunCommand={() => runSystemTabCommand('doctor')} />}
      {sub === 'logs' && <LogViewer />}
      {sub === 'maintenance' && (
        <Maintenance state={state} onReset={onReset} onUpdate={runMaintenanceUpdate} />
      )}
      {sub === 'commands' && <Commands />}
      <div style={{ marginTop: 16 }}>
        <CommandOutput
          result={cmd.result}
          running={cmd.running}
          onRun={SYSTEM_COMMAND_LABELS[sub] ? () => runSystemTabCommand(sub) : undefined}
          empty={sub === 'maintenance' ? 'Run a maintenance action to see output here.' : undefined}
        />
      </div>
    </div>
  );
}

async function runPanelCommand(name) {
  const fallback = SYSTEM_COMMAND_LABELS[name] || `gurney ${name}`;
  const r = await window.api.post(`/api/system/${name}`);
  const data = r.data || {};
  return {
    ok: r.ok && data.ok !== false,
    code: data.code,
    command: data.command || fallback,
    output: data.output || r.error || '',
  };
}

function CommandOutput({ result, running, onRun, empty = 'No output yet.' }) {
  const command = (result && result.command) || '';
  const output = result && result.output ? result.output : '';
  const ok = !result || result.ok;
  return (
    <div
      style={{
        borderRadius: 'var(--radius)',
        border: `1px solid ${
          result && !ok ? 'color-mix(in oklab, var(--err) 32%, var(--border))' : 'var(--border)'
        }`,
        background: 'var(--code-bg)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'color-mix(in oklab, var(--surface) 70%, transparent)',
        }}
      >
        <window.Icon
          name={running ? 'refresh' : ok ? 'terminal' : 'alert'}
          size={15}
          className={running ? 'spin' : ''}
        />
        <span
          className="mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            color: ok ? 'var(--text-2)' : 'var(--err)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {command || (running ? 'running command' : 'command output')}
          {result && typeof result.code === 'number' ? ` (exit ${result.code})` : ''}
        </span>
        {onRun && (
          <window.Button
            size="sm"
            variant="subtle"
            icon="refresh"
            onClick={onRun}
            disabled={running}
          >
            {running ? 'Running' : 'Run'}
          </window.Button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          minHeight: 86,
          maxHeight: 300,
          overflow: 'auto',
          padding: 14,
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          color: output ? 'var(--text)' : 'var(--text-3)',
        }}
      >
        {running && !output ? 'Running...' : output || empty}
      </pre>
    </div>
  );
}

/* ---- status dashboard ---- */
function StatusDashboard({ state }) {
  const s = state || {};
  const agent = s.agent || {};
  const health = s.health || {};
  const models = s.models || {};
  const exts = s.extensions || {};
  const agentState = agent.running ? 'running' : 'stopped';
  const cards = [
    {
      label: 'Agent',
      value: agent.running ? 'Running' : 'Stopped',
      dot: agentState,
      sub: agent.pid ? `pid ${agent.pid}` : 'not running',
    },
    {
      label: 'Ollama',
      value: health.ollama ? 'Reachable' : 'Unreachable',
      dot: health.ollama ? 'ok' : 'err',
      sub: health.ollamaUrl || '',
    },
    { label: 'Models loaded', value: models.loaded ?? 0, sub: models.chat || '—' },
    { label: 'Allowlist', value: s.allowlistCount ?? 0, sub: 'users allowed' },
    {
      label: 'Extensions enabled',
      value: exts.enabled ?? 0,
      sub: `${exts.installed ?? 0} installed`,
    },
    { label: 'Queue depth', value: s.queueDepth ?? 0, sub: 'messages waiting', dot: 'ok' },
  ];

  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 'calc(14px * var(--gap))',
        }}
      >
        {cards.map((c) => (
          <window.Card key={c.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--text-3)',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              }}
            >
              {c.label}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              {c.dot && <window.StatusDot state={c.dot} size={9} pulse={c.dot === 'running'} />}
              <span
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: 0,
                  fontFamily: typeof c.value === 'number' ? 'var(--font-mono)' : 'var(--font-ui)',
                }}
              >
                {c.value}
              </span>
            </div>
            {c.sub && (
              <span
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-3)',
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {c.sub}
              </span>
            )}
          </window.Card>
        ))}
      </div>
      {s.ramGb != null && (
        <p
          style={{
            fontSize: 12.5,
            color: 'var(--text-3)',
            marginTop: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <window.Icon name="shield" size={13} />{' '}
          {s.freeRamGb != null
            ? `${s.freeRamGb} GB free of ${s.ramGb} GB RAM`
            : `${s.ramGb} GB RAM`}{' '}
          · tier {s.tier} · v{s.version}
        </p>
      )}
    </div>
  );
}

/* ---- doctor ---- */
function Doctor({ onRunCommand }) {
  const [running, setRunning] = useStateSys(false);
  const [checks, setChecks] = useStateSys(null);
  const [error, setError] = useStateSys(null);

  const run = async (includeCommand = true) => {
    setRunning(true);
    setError(null);
    const [r] = await Promise.all([
      window.api.get('/api/doctor'),
      includeCommand ? onRunCommand() : Promise.resolve(),
    ]);
    setRunning(false);
    if (r.ok) setChecks(r.data.checks);
    else setError(r.error || 'Could not run diagnostics.');
  };

  useEffectSys(() => {
    run(false);
  }, []);

  const summary = checks
    ? {
        pass: checks.filter((c) => c.status === 'pass').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      }
    : null;

  return (
    <div style={{ maxWidth: 720 }}>
      <window.Card
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Health check</div>
          <p style={{ fontSize: 13.5, color: 'var(--text-3)', marginTop: 3 }}>
            Runs the same preflight checks as <span className="mono">gurney doctor</span>.
          </p>
        </div>
        {summary && (
          <div style={{ display: 'flex', gap: 8 }}>
            <window.Badge tone="ok">{summary.pass} pass</window.Badge>
            {summary.warn > 0 && <window.Badge tone="warn">{summary.warn} warn</window.Badge>}
            {summary.fail > 0 && <window.Badge tone="err">{summary.fail} fail</window.Badge>}
          </div>
        )}
        <window.Button
          variant="primary"
          icon={running ? undefined : 'pulse'}
          onClick={() => run(true)}
          disabled={running}
        >
          {running ? (
            <>
              <window.Icon name="refresh" size={16} className="spin" /> Running…
            </>
          ) : checks ? (
            'Run again'
          ) : (
            'Run check'
          )}
        </window.Button>
      </window.Card>

      {error && <ErrorNote text={error} />}

      {checks ? (
        <window.Card pad={0}>
          {checks.map((c, i) => (
            <div
              key={c.id}
              className="rise"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 13,
                padding: '14px 18px',
                borderTop: i ? '1px solid var(--border)' : 'none',
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 99,
                  flex: 'none',
                  display: 'grid',
                  placeItems: 'center',
                  marginTop: 1,
                  background:
                    c.status === 'pass'
                      ? 'color-mix(in oklab, var(--ok) 16%, transparent)'
                      : c.status === 'warn'
                        ? 'color-mix(in oklab, var(--warn) 18%, transparent)'
                        : 'color-mix(in oklab, var(--err) 14%, transparent)',
                  color:
                    c.status === 'pass'
                      ? 'var(--ok)'
                      : c.status === 'warn'
                        ? 'var(--warn)'
                        : 'var(--err)',
                }}
              >
                <window.Icon
                  name={c.status === 'pass' ? 'check' : c.status === 'warn' ? 'alert' : 'x'}
                  size={14}
                />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 14.5 }}>{c.label}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{c.detail}</div>
                {c.fix && c.status !== 'pass' && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: 'var(--text-3)',
                      marginTop: 5,
                      display: 'flex',
                      gap: 6,
                    }}
                  >
                    <window.Icon
                      name="spark"
                      size={13}
                      style={{ color: 'var(--warn)', flex: 'none', marginTop: 1 }}
                    />{' '}
                    {c.fix}
                  </div>
                )}
              </div>
            </div>
          ))}
        </window.Card>
      ) : (
        !error &&
        !running && (
          <div
            style={{
              textAlign: 'center',
              padding: '50px 20px',
              border: '1px dashed var(--border-2)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-3)',
            }}
          >
            <window.Icon name="pulse" size={28} style={{ margin: '0 auto 10px' }} />
            <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
              No checks run yet
            </p>
            <p style={{ fontSize: 13, marginTop: 3 }}>
              Press “Run check” to see how Gurney is doing.
            </p>
          </div>
        )
      )}
    </div>
  );
}

/* ---- log viewer ---- */
const LEVEL_COLOR = {
  debug: 'var(--text-3)',
  info: 'var(--info)',
  warn: 'var(--warn)',
  error: 'var(--err)',
};
function parseLine(raw) {
  // Daemon logs are JSON lines {t, level, msg, ...fields}; fall back to raw text.
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && o.msg !== undefined) {
      const { t, level, msg, ...f } = o;
      const time = t ? String(t).slice(11, 23) : '';
      return { t: time, level: level || 'info', msg: String(msg), f };
    }
  } catch (e) {
    /* not JSON */
  }
  return { t: '', level: 'info', msg: raw, f: {} };
}

function LogViewer() {
  const [lines, setLines] = useStateSys([]);
  const [follow, setFollow] = useStateSys(true);
  const [filter, setFilter] = useStateSys('all');
  const [q, setQ] = useStateSys('');
  const [connected, setConnected] = useStateSys(false);
  const boxRef = useRefSys(null);
  const esRef = useRefSys(null);

  useEffectSys(() => {
    if (!follow) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
        setConnected(false);
      }
      return;
    }
    const es = window.api.streamSSE('/api/logs/stream', {
      onOpen: () => setConnected(true),
      onMessage: (_ev, data) => {
        let raw = data;
        try {
          raw = JSON.parse(data);
        } catch (e) {
          /* data is already a string */
        }
        setLines((l) => [...l.slice(-400), parseLine(raw)]);
      },
      onError: () => setConnected(false),
    });
    esRef.current = es;
    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [follow]);

  useEffectSys(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, follow]);

  const shown = lines.filter(
    (l) =>
      (filter === 'all' || l.level === filter) &&
      (!q || (l.msg + JSON.stringify(l.f)).toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <window.Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={['all', 'debug', 'info', 'warn', 'error']}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 180, maxWidth: 320 }}>
          <window.Icon
            name="search"
            size={15}
            style={{
              position: 'absolute',
              left: 11,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-3)',
              zIndex: 1,
            }}
          />
          <window.Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search logs…"
            style={{ paddingLeft: 34, fontSize: 13 }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px 6px 6px',
            borderRadius: 99,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}
        >
          <window.Toggle checked={follow} onChange={setFollow} label="Follow logs" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
            Follow
            {follow && connected && (
              <span style={{ marginLeft: 6, color: 'var(--ok)' }}>● live</span>
            )}
          </span>
        </div>
      </div>
      <div
        ref={boxRef}
        style={{
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: 14,
          height: 460,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          lineHeight: 1.7,
        }}
      >
        {shown.length === 0 && (
          <div style={{ color: 'var(--text-3)', padding: 20, textAlign: 'center' }}>
            {follow
              ? 'Waiting for log lines… (the daemon writes here while running)'
              : 'Follow is off.'}
          </div>
        )}
        {shown.map((l, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 12, whiteSpace: 'pre-wrap', padding: '1px 0' }}
          >
            {l.t && <span style={{ color: 'var(--text-3)', flex: 'none' }}>{l.t}</span>}
            <span
              style={{
                color: LEVEL_COLOR[l.level] || 'var(--text-3)',
                fontWeight: 600,
                width: 46,
                flex: 'none',
                textTransform: 'uppercase',
                fontSize: 11,
              }}
            >
              {l.level}
            </span>
            <span style={{ color: 'var(--text)', flex: 'none' }}>{l.msg}</span>
            <span style={{ color: 'var(--text-3)' }}>
              {Object.entries(l.f)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join(' ')}
            </span>
          </div>
        ))}
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: 'var(--text-3)',
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <window.Icon name="shield" size={13} /> Secrets and tokens are automatically redacted in
        logs.
      </p>
    </div>
  );
}

/* ---- maintenance ---- */
function Maintenance({ state, onReset, onUpdate }) {
  const [updating, setUpdating] = useStateSys(false);
  const [resetOpen, setResetOpen] = useStateSys(false);
  const [confirmText, setConfirmText] = useStateSys('');
  const version = state && state.version ? state.version : '';

  const doUpdate = async () => {
    setUpdating(true);
    try {
      await onUpdate();
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: 680,
        display: 'flex',
        flexDirection: 'column',
        gap: 'calc(16px * var(--gap))',
      }}
    >
      <window.Card style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <window.Icon name="download" size={22} style={{ color: 'var(--text-3)' }} />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 600, fontSize: 15.5 }}>Update Gurney</div>
          <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 2 }}>
            Pulls the latest code, reinstalls dependencies, and rebuilds (
            <span className="mono">gurney update</span>). Restart the agent afterwards.
            {version ? ` Currently v${version}.` : ''}
          </p>
        </div>
        <window.Button variant="primary" onClick={doUpdate} disabled={updating}>
          {updating ? (
            <>
              <window.Icon name="refresh" size={16} className="spin" /> Updating…
            </>
          ) : (
            'Check & update'
          )}
        </window.Button>
      </window.Card>

      <div
        style={{
          borderRadius: 'var(--radius)',
          border: '1px solid color-mix(in oklab, var(--err) 35%, transparent)',
          background: 'color-mix(in oklab, var(--err) 6%, var(--surface))',
          padding: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <window.Icon name="alert" size={18} style={{ color: 'var(--err)' }} />
          <span style={{ fontWeight: 700, fontSize: 15.5, color: 'var(--err)' }}>Danger zone</span>
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 14 }}>
          A fresh install (<span className="mono">gurney fresh</span>) wipes{' '}
          <b>all configuration, extensions, and stored data</b> and re-runs first-time setup. This
          cannot be undone and must be confirmed in the terminal for safety.
        </p>
        <window.Button
          variant="outline_danger"
          icon="trash"
          onClick={() => {
            setResetOpen(true);
            setConfirmText('');
          }}
        >
          Fresh install / Reset…
        </window.Button>
      </div>

      <window.Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        tone="err"
        title="Reset Gurney to a fresh install?"
        width={500}
        footer={
          <>
            <window.Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </window.Button>
            <window.Button
              variant="danger"
              icon="trash"
              disabled={confirmText !== 'RESET'}
              style={{ opacity: confirmText === 'RESET' ? 1 : 0.5 }}
              onClick={() => {
                setResetOpen(false);
                onReset();
              }}
            >
              Re-run setup wizard
            </window.Button>
          </>
        }
      >
        <p>
          This permanently deletes your bot token, allowlist, model choices, every installed
          extension, and all stored data. For safety, the actual wipe runs as{' '}
          <span className="mono">gurney fresh</span> in the terminal — this button takes you back
          through the in-browser setup wizard.
        </p>
        <div style={{ marginTop: 16 }}>
          <window.Label hint="This is a safety check so it can’t happen by accident.">
            Type{' '}
            <span className="mono" style={{ color: 'var(--err)', fontWeight: 700 }}>
              RESET
            </span>{' '}
            to confirm
          </window.Label>
          <window.Input
            mono
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            invalid={confirmText.length > 0 && confirmText !== 'RESET'}
          />
        </div>
      </window.Modal>
    </div>
  );
}

/* ---- telegram commands ---- */
function Commands() {
  const [data, setData] = useStateSys(null);
  const [error, setError] = useStateSys(null);

  useEffectSys(() => {
    window.api.get('/api/commands').then((r) => {
      if (r.ok) setData(r.data);
      else setError(r.error || 'Could not load commands.');
    });
  }, []);
  if (error)
    return (
      <div style={{ maxWidth: 680 }}>
        <ErrorNote text={error} />
      </div>
    );
  if (!data)
    return <div style={{ maxWidth: 680, color: 'var(--text-3)', fontSize: 13.5 }}>Loading…</div>;
  const groups = [
    { title: 'Core commands', items: data.core || [] },
    { title: 'From extensions', items: data.extensions || [] },
  ].filter((g) => g.items.length);
  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.55 }}>
        These are the slash-commands you can type to your bot in Telegram. They do the same things
        you’d find here in the panel.
      </p>
      {groups.map((g) => (
        <div key={g.title} style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              marginBottom: 10,
            }}
          >
            {g.title}
          </div>
          <window.Card pad={0}>
            {g.items.map((c, i) => (
              <div
                key={c.cmd + i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '13px 18px',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: 'var(--accent-strong)',
                    width: 110,
                    flex: 'none',
                  }}
                >
                  {c.cmd}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{c.desc}</span>
              </div>
            ))}
          </window.Card>
        </div>
      ))}
    </div>
  );
}

function ErrorNote({ text, onRetry }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 18,
        padding: 14,
        borderRadius: 'var(--radius)',
        border: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
        background: 'color-mix(in oklab, var(--err) 7%, var(--surface))',
      }}
    >
      <window.Icon name="alert" size={18} style={{ color: 'var(--err)' }} />
      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-2)' }}>{text}</span>
      {onRetry && (
        <window.Button size="sm" variant="subtle" icon="refresh" onClick={onRetry}>
          Retry
        </window.Button>
      )}
    </div>
  );
}

Object.assign(window, { SystemTab });
