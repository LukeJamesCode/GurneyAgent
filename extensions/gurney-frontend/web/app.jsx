/* global React, ReactDOM, window */
// Root app. Holds the shared agent/health state (polled from /api/state),
// decides between the first-run wizard and the main hub, and owns the agent
// start/stop/restart actions (which POST to /api/agent/* — the server shells
// out to `gurney start --detach` / `gurney stop`). Theme is a simple
// localStorage-backed light/dark toggle; light is the default.
const { useState, useEffect, useCallback, useRef } = React;

const NAV = [
  { id: 'chat', label: 'Chat Hub', icon: 'chat' },
  { id: 'extensions', label: 'Extensions', icon: 'plug' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
  { id: 'system', label: 'System', icon: 'pulse' },
];

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('gurney_theme') || 'light';
    } catch (e) {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('gurney_theme', theme);
    } catch (e) {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

function useDensity() {
  const [density, setDensity] = useState(() => {
    try {
      return localStorage.getItem('gurney_density') || 'balanced';
    } catch (e) {
      return 'balanced';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-density', density);
    try {
      localStorage.setItem('gurney_density', density);
    } catch (e) {
      /* ignore */
    }
  }, [density]);
  return [density, setDensity];
}

function App() {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useDensity();
  const [state, setState] = useState(null);
  const [offline, setOffline] = useState(false);
  const [route, setRoute] = useState('chat');
  const [busy, setBusy] = useState(false); // agent action in flight
  const [forcedView, setForcedView] = useState(null); // override configured-based view
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    const r = await window.api.get('/api/state');
    if (r.ok) {
      setState(r.data);
      setOffline(false);
    } else if (r.offline) setOffline(true);
    return r.ok ? r.data : null;
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [refresh]);

  const agentAction = useCallback(
    async (action) => {
      setBusy(true);
      await window.api.post(`/api/agent/${action}`);
      await refresh();
      // Poll a couple more times — the daemon takes a beat to come up/down.
      setTimeout(refresh, 1200);
      setTimeout(() => {
        refresh();
        setBusy(false);
      }, 2600);
    },
    [refresh],
  );

  const setProactive = useCallback(
    async (on) => {
      setState((s) => ({ ...s, proactive: on }));
      await window.api.post('/api/agent/proactive', { on });
      refresh();
    },
    [refresh],
  );

  // ---- loading / boot ----
  if (!state && !offline) {
    return (
      <div className="boot">
        <span className="boot-mark">g</span>
        <span className="boot-text">Loading Gurney…</span>
      </div>
    );
  }

  if (!state && offline) {
    return (
      <div className="boot">
        <span className="boot-mark" style={{ background: 'var(--err)' }}>
          !
        </span>
        <span className="boot-text">Can’t reach the Gurney panel server.</span>
        <window.Button variant="subtle" icon="refresh" onClick={refresh}>
          Retry
        </window.Button>
      </div>
    );
  }

  const configured = !!state.configured;
  const view = forcedView || (configured ? 'hub' : 'wizard');
  const agentStatus = busy
    ? 'starting'
    : state.agent && state.agent.running
      ? 'running'
      : 'stopped';

  if (view === 'wizard') {
    return (
      <window.Wizard
        suggestedTier={state.suggestedTier}
        ramGb={state.ramGb}
        onExit={() => setForcedView('hub')}
        onFinish={async () => {
          setForcedView('hub');
          setRoute('chat');
          await refresh();
          agentAction('start');
        }}
      />
    );
  }

  const health = state.health || {};
  const models = state.models || {};

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        setRoute={setRoute}
        agentStatus={agentStatus}
        onStart={() => agentAction('start')}
        onStop={() => agentAction('stop')}
        busy={busy}
        extCount={state.extensions ? state.extensions.enabled : 0}
        theme={theme}
        setTheme={setTheme}
        density={density}
        setDensity={setDensity}
      />

      <main className="main-panel">
        {offline && <OfflineBar onRetry={refresh} />}
        {state.cfgError && <ConfigErrorBar message={state.cfgError} />}
        <div className="content-shell">
          {route === 'chat' && (
            <window.ChatHub
              agent={agentStatus}
              busy={busy}
              onStart={() => agentAction('start')}
              onStop={() => agentAction('stop')}
              onRestart={() => agentAction('restart')}
              proactive={state.proactive}
              onProactive={setProactive}
              health={{ telegram: !!health.telegram, ollama: !!health.ollama }}
              activeModel={[
                models.chat,
                models.tools ? `tools ${models.tools}` : null,
                models.reason ? `reason ${models.reason}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              lastError={state.lastError || null}
              scheduler={state.scheduler}
              extensions={state.extensions}
              tier={state.tier}
              allowlistCount={state.allowlistCount}
            />
          )}
          {route === 'extensions' && <window.ExtensionsTab />}
          {route === 'settings' && (
            <window.SettingsTab onReRunWizard={() => setForcedView('wizard')} onSaved={refresh} />
          )}
          {route === 'system' && (
            <window.SystemTab state={state} onReset={() => setForcedView('wizard')} />
          )}
        </div>
      </main>
    </div>
  );
}

function OfflineBar({ onRetry }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--err) 12%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--err)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>
        Lost connection to the panel server — showing the last known state.
      </span>
      <window.Button size="sm" variant="subtle" icon="refresh" onClick={onRetry}>
        Retry
      </window.Button>
    </div>
  );
}

function ConfigErrorBar({ message }) {
  return (
    <div
      style={{
        background: 'color-mix(in oklab, var(--warn) 14%, var(--surface))',
        borderBottom: '1px solid color-mix(in oklab, var(--warn) 34%, transparent)',
        padding: '10px 22px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        fontSize: 13.5,
      }}
    >
      <window.Icon name="alert" size={16} style={{ color: 'var(--warn)' }} />
      <span style={{ flex: 1, color: 'var(--text-2)' }}>Config problem: {message}</span>
    </div>
  );
}

/* ---------------- global status pill + start/stop ---------------- */
function GlobalStatus({ agentStatus, onStart, onStop, busy }) {
  const running = agentStatus === 'running';
  const starting = agentStatus === 'starting' || busy;
  const labels = { running: 'Running', stopped: 'Stopped', starting: 'Starting', error: 'Error' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 12px',
          borderRadius: 99,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          flex: 1,
          minWidth: 0,
        }}
      >
        <window.StatusDot state={starting ? 'starting' : agentStatus} size={9} pulse={running} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {starting ? 'Starting' : labels[agentStatus]}
        </span>
      </div>
      <window.Button
        size="sm"
        variant={running ? 'default' : 'primary'}
        icon={running ? 'stop' : 'power'}
        onClick={running ? onStop : onStart}
        disabled={starting}
        style={
          running
            ? {
                color: 'var(--err)',
                borderColor: 'color-mix(in oklab, var(--err) 38%, transparent)',
              }
            : {}
        }
      >
        {running ? 'Stop' : starting ? '…' : 'Start'}
      </window.Button>
    </div>
  );
}

function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          background: 'var(--accent)',
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <span
          className="display"
          style={{ color: 'var(--on-accent)', fontWeight: 700, fontSize: 18, lineHeight: 1 }}
        >
          g
        </span>
      </span>
      <div style={{ lineHeight: 1.05 }}>
        <div className="display" style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: 0 }}>
          Gurney
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>
          home control panel
        </div>
      </div>
    </div>
  );
}

/* ---------------- sidebar ---------------- */
function Sidebar({
  route,
  setRoute,
  agentStatus,
  onStart,
  onStop,
  busy,
  extCount,
  theme,
  setTheme,
  density,
  setDensity,
}) {
  return (
    <aside
      style={{
        width: 236,
        flex: 'none',
        background: 'var(--bg-2)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '14px 12px',
      }}
      className="sidebar"
    >
      <div
        style={{
          padding: '2px 6px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Wordmark />
        <window.IconButton
          name={theme === 'dark' ? 'sun' : 'moon'}
          label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {NAV.map((n) => {
          const on = route === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setRoute(n.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                background: on ? 'var(--surface)' : 'transparent',
                color: on ? 'var(--text)' : 'var(--text-2)',
                boxShadow: on ? 'var(--shadow-sm)' : 'none',
                fontWeight: on ? 600 : 500,
                fontSize: 14,
                transition: 'background .12s, color .12s',
              }}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.background = 'transparent';
              }}
            >
              <window.Icon
                name={n.icon}
                size={18}
                style={{ color: on ? 'var(--accent-strong)' : 'var(--text-3)' }}
              />
              <span style={{ flex: 1 }}>{n.label}</span>
              {n.id === 'extensions' && extCount > 0 && (
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--text-3)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {extCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div style={{ flex: 1 }} />
      <div
        style={{
          padding: '10px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: 'var(--text-3)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0,
          }}
        >
          Agent
        </span>
        <GlobalStatus agentStatus={agentStatus} onStart={onStart} onStop={onStop} busy={busy} />
        <div className="density-control" aria-label="Layout density">
          {[
            { id: 'compact', icon: 'menu', label: 'Compact' },
            { id: 'balanced', icon: 'pulse', label: 'Balanced' },
            { id: 'roomy', icon: 'spark', label: 'Roomy' },
          ].map((d) => (
            <button
              key={d.id}
              className="density-button"
              data-active={density === d.id}
              title={`${d.label} density`}
              aria-label={`${d.label} density`}
              onClick={() => setDensity(d.id)}
            >
              <window.Icon name={d.icon} size={14} />
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}

Object.assign(window, { App });

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
