/* global React, window */
// Chat Hub — the home screen. A hero control bar (start/stop/restart/new-chat/
// proactive) over a live direct-chat column and a right-hand activity strip.
//
// The chat talks to POST /api/chat, which streams through Gurney's orchestrator:
// same profile routing, tools, history, and guardrails as Telegram.
const { useState: useStateCH, useRef: useRefCH, useEffect: useEffectCH } = React;

function ChatHub({
  agent,
  onStart,
  onStop,
  onRestart,
  proactive,
  onProactive,
  health,
  activeModel,
  lastError,
  busy,
}) {
  const running = agent === 'running';
  const [messages, setMessages] = useStateCH([]);
  const [draft, setDraft] = useStateCH('');
  const [phase, setPhase] = useStateCH('idle'); // idle | streaming
  const [streamText, setStreamText] = useStateCH('');
  const scrollRef = useRefCH(null);
  const streamRef = useRefCH(null); // active postStream handle (for abort)

  useEffectCH(
    () => () => {
      if (streamRef.current) streamRef.current.abort();
    },
    [],
  );

  useEffectCH(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, phase]);

  const send = () => {
    if (!draft.trim() || !running || phase !== 'idle') return;
    const text = draft.trim();
    setDraft('');
    setMessages((m) => [...m, { id: Date.now(), role: 'user', text, time: now() }]);
    setPhase('streaming');
    setStreamText('');

    let acc = '';
    streamRef.current = window.api.postStream(
      '/api/chat',
      { text },
      {
        onEvent: (ev, data) => {
          if (ev === 'delta' && data && data.delta) {
            acc += data.delta;
            setStreamText(acc);
          } else if (ev === 'replace' && data && typeof data.text === 'string') {
            acc = data.text;
            setStreamText(acc);
          } else if (ev === 'done') {
            setMessages((m) => [
              ...m,
              { id: Date.now(), role: 'assistant', text: (data && data.text) || acc, time: now() },
            ]);
            setStreamText('');
            setPhase('idle');
            streamRef.current = null;
          } else if (ev === 'error') {
            setMessages((m) => [
              ...m,
              {
                id: Date.now(),
                role: 'assistant',
                text: '⚠️ ' + ((data && data.message) || 'The model could not be reached.'),
                time: now(),
                error: true,
              },
            ]);
            setStreamText('');
            setPhase('idle');
            streamRef.current = null;
          }
        },
      },
    );
    streamRef.current.done.catch(() => {
      setStreamText('');
      setPhase('idle');
      streamRef.current = null;
    });
  };

  const abort = () => {
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
    }
    if (streamText)
      setMessages((m) => [
        ...m,
        { id: Date.now(), role: 'assistant', text: streamText, time: now() },
      ]);
    setStreamText('');
    setPhase('idle');
  };
  const newChat = () => {
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
    }
    setStreamText('');
    setPhase('idle');
    setMessages([]);
    window.api.post('/api/chat/clear');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <AgentControlBar
        agent={agent}
        busy={busy}
        onStart={onStart}
        onStop={onStop}
        proactive={proactive}
        onProactive={onProactive}
        onRestart={() => {
          newChat();
          onRestart();
        }}
        onNewChat={newChat}
        onAbort={abort}
        streaming={phase !== 'idle'}
      />

      <div
        style={{ display: 'flex', gap: calc(16), flex: 1, minHeight: 0, marginTop: calc(16) }}
        className="chat-grid"
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-sm)',
          }}
        >
          <div
            style={{
              padding: '12px 18px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flex: 'none',
            }}
          >
            <window.Icon name="chat" size={17} style={{ color: 'var(--text-3)' }} />
            <span style={{ fontWeight: 600, fontSize: 14.5 }}>Direct chat</span>
            <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              — talks to your local model{activeModel ? ` (${activeModel})` : ''}
            </span>
          </div>

          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 18, minHeight: 120 }}>
            {messages.length === 0 && phase === 'idle' && <EmptyChat running={running} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {messages.map((m) => (
                <Bubble key={m.id} m={m} />
              ))}
              {phase === 'streaming' && !streamText && <Thinking label="Thinking…" />}
              {phase === 'streaming' && streamText && (
                <Bubble m={{ role: 'assistant', text: streamText, time: now() }} streaming />
              )}
            </div>
          </div>

          <div
            style={{
              padding: 14,
              borderTop: '1px solid var(--border)',
              flex: 'none',
              background: 'var(--surface)',
            }}
          >
            {!running && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                  color: 'var(--text-3)',
                  fontSize: 13,
                }}
              >
                <window.StatusDot state="stopped" /> Agent is stopped — start it to send messages.
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={running ? 'Message Gurney…' : 'Start the agent to chat'}
                disabled={!running}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--accent)';
                  e.target.style.boxShadow = '0 0 0 3px var(--accent-ring)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--border-2)';
                  e.target.style.boxShadow = 'none';
                }}
                style={{
                  flex: 1,
                  resize: 'none',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 14.5,
                  lineHeight: 1.5,
                  color: 'var(--text)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-2)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '11px 14px',
                  outline: 'none',
                  maxHeight: 140,
                  minHeight: 44,
                  transition: 'border-color .15s, box-shadow .15s',
                  opacity: running ? 1 : 0.6,
                }}
              />
              {phase === 'streaming' ? (
                <window.Button variant="subtle" icon="stop" onClick={abort} style={{ height: 44 }}>
                  Stop
                </window.Button>
              ) : (
                <window.Button
                  variant="primary"
                  icon="send"
                  onClick={send}
                  disabled={!running || !draft.trim()}
                  style={{ height: 44, opacity: !running || !draft.trim() ? 0.5 : 1 }}
                >
                  Send
                </window.Button>
              )}
            </div>
          </div>
        </div>

        <ActivityStrip
          agent={agent}
          health={health}
          activeModel={activeModel}
          phase={phase}
          lastError={lastError}
        />
      </div>
    </div>
  );
}

function now() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}
function calc(px) {
  return `calc(${px}px * var(--gap))`;
}

/* ---- Agent control bar (hero) ---- */
function AgentControlBar({
  agent,
  busy,
  onStart,
  onStop,
  proactive,
  onProactive,
  onRestart,
  onNewChat,
  onAbort,
  streaming,
}) {
  const running = agent === 'running';
  const starting = agent === 'starting' || busy;
  const label =
    { running: 'Running', stopped: 'Stopped', starting: 'Starting…', error: 'Error' }[agent] ||
    'Stopped';
  const sub =
    {
      running: 'Gurney is live and answering messages on Telegram.',
      stopped: 'The agent is not running. Start it to begin answering messages.',
      starting: 'Bringing the agent online…',
      error: 'Something went wrong starting the agent. Check Diagnostics.',
    }[agent] || 'The agent is not running.';

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: calc(16),
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 240 }}>
        <span
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            flex: 'none',
            display: 'grid',
            placeItems: 'center',
            background: running
              ? 'var(--accent-soft)'
              : starting
                ? 'color-mix(in oklab, var(--warn) 16%, transparent)'
                : agent === 'error'
                  ? 'color-mix(in oklab, var(--err) 13%, transparent)'
                  : 'var(--surface-2)',
            color: running
              ? 'var(--accent-strong)'
              : starting
                ? 'var(--warn)'
                : agent === 'error'
                  ? 'var(--err)'
                  : 'var(--text-3)',
            border: '1px solid var(--border)',
          }}
        >
          {starting ? (
            <window.Icon name="refresh" size={22} className="spin" />
          ) : (
            <window.Icon name="power" size={22} />
          )}
        </span>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <window.StatusDot state={starting ? 'starting' : agent} size={10} pulse={running} />
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
              {starting ? 'Starting…' : label}
            </span>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 3, maxWidth: 380 }}>{sub}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
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
          title="Let Gurney message you first with nudges and briefings."
        >
          <window.Toggle checked={proactive} onChange={onProactive} label="Proactive nudges" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>Proactive</span>
        </div>
        <window.Button
          variant="ghost"
          size="sm"
          icon="plus"
          onClick={onNewChat}
          title="Clear the conversation and start fresh"
        >
          New chat
        </window.Button>
        <window.Button
          variant="subtle"
          size="sm"
          icon="refresh"
          onClick={onRestart}
          disabled={!running || starting}
          style={{ opacity: running && !starting ? 1 : 0.5 }}
        >
          Restart
        </window.Button>
        <window.Button
          variant={running ? 'default' : 'primary'}
          icon={running ? 'stop' : 'power'}
          onClick={running ? onStop : onStart}
          disabled={starting}
          style={
            running
              ? {
                  borderColor: 'color-mix(in oklab, var(--err) 40%, transparent)',
                  color: 'var(--err)',
                }
              : {}
          }
        >
          {running ? 'Stop' : starting ? 'Starting…' : 'Start agent'}
        </window.Button>
      </div>
    </div>
  );
}

/* ---- chat bubble ---- */
function Bubble({ m, streaming }) {
  const isUser = m.role === 'user';
  return (
    <div
      className="rise"
      style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}
    >
      <div
        style={{
          maxWidth: '76%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isUser ? 'flex-end' : 'flex-start',
          gap: 4,
        }}
      >
        {m.tool && !isUser && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11.5,
              color: 'var(--text-3)',
              fontFamily: 'var(--font-mono)',
              marginBottom: 1,
            }}
          >
            <window.Icon name="plug" size={12} /> {m.tool}
          </span>
        )}
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 14,
            fontSize: 14.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            background: isUser
              ? 'var(--accent)'
              : m.error
                ? 'color-mix(in oklab, var(--err) 10%, var(--surface-2))'
                : 'var(--surface-2)',
            color: isUser ? 'var(--on-accent)' : 'var(--text)',
            border: isUser ? 'none' : '1px solid var(--border)',
            borderBottomRightRadius: isUser ? 4 : 14,
            borderBottomLeftRadius: isUser ? 14 : 4,
          }}
        >
          {m.text}
          {streaming && (
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 15,
                background: 'var(--text-2)',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'blink 1s steps(1) infinite',
              }}
            />
          )}
        </div>
        {m.time && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{m.time}</span>}
      </div>
    </div>
  );
}

function Thinking({ label, tool }) {
  return (
    <div className="rise" style={{ display: 'flex' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          padding: '9px 14px',
          borderRadius: 14,
          borderBottomLeftRadius: 4,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}
      >
        {tool ? (
          <window.Icon name="plug" size={14} style={{ color: 'var(--accent-strong)' }} />
        ) : null}
        <span style={{ fontSize: 13.5, color: 'var(--text-2)', fontWeight: tool ? 600 : 400 }}>
          {label}
          {tool && (
            <span className="mono" style={{ color: 'var(--text-3)', marginLeft: 6 }}>
              {tool}
            </span>
          )}
        </span>
        <span style={{ display: 'inline-flex', gap: 3 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: 99,
                background: 'var(--text-3)',
                animation: `dots 1.2s ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

function EmptyChat({ running }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        color: 'var(--text-3)',
        padding: 40,
        gap: 10,
      }}
    >
      <span
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-3)',
        }}
      >
        <window.Icon name="chat" size={24} />
      </span>
      <p style={{ fontWeight: 600, color: 'var(--text-2)', fontSize: 15 }}>No messages yet</p>
      <p style={{ fontSize: 13.5, maxWidth: 280 }}>
        {running
          ? 'Say hello below — this talks to the same local model your Telegram bot uses.'
          : 'Start the agent to begin chatting.'}
      </p>
    </div>
  );
}

/* ---- activity strip ---- */
function ActivityStrip({ agent, health, activeModel, phase, lastError }) {
  const running = agent === 'running';
  const rows = [
    {
      label: 'Model in use',
      value: activeModel || '—',
      mono: true,
      dot: running ? 'ok' : 'stopped',
    },
    {
      label: 'Queue depth',
      value: phase !== 'idle' ? '1 message' : '0',
      dot: phase !== 'idle' ? 'warn' : 'ok',
    },
    {
      label: 'Telegram',
      value: health.telegram ? 'Connected' : 'Offline',
      dot: health.telegram && running ? 'ok' : 'stopped',
    },
    {
      label: 'Ollama',
      value: health.ollama ? 'Reachable' : 'Unreachable',
      dot: health.ollama ? 'ok' : 'err',
    },
  ];
  return (
    <div
      className="activity-strip"
      style={{ width: 280, flex: 'none', display: 'flex', flexDirection: 'column', gap: calc(16) }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-sm)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <window.Icon name="pulse" size={16} style={{ color: 'var(--text-3)' }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Live activity</span>
        </div>
        <div>
          {rows.map((r, i) => (
            <div
              key={r.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '11px 16px',
                borderTop: i ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-2)', flex: 'none' }}>{r.label}</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: r.mono ? 'var(--font-mono)' : 'var(--font-ui)',
                  color: 'var(--text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: 160,
                }}
              >
                <window.StatusDot state={r.dot} size={7} /> {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-sm)',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <window.Icon
            name={lastError ? 'alert' : 'check'}
            size={16}
            style={{ color: lastError ? 'var(--warn)' : 'var(--ok)' }}
          />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Last error</span>
        </div>
        {lastError ? (
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--text-2)',
              lineHeight: 1.5,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {lastError}
          </p>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>None reported. All clear.</p>
        )}
      </div>

      <div
        style={{
          borderRadius: 'var(--radius)',
          padding: 16,
          border: '1px dashed var(--border-2)',
          background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
          display: 'flex',
          gap: 11,
        }}
      >
        <window.Icon
          name="shield"
          size={17}
          style={{ color: 'var(--accent-strong)', marginTop: 1 }}
        />
        <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Everything here runs on <b style={{ color: 'var(--text)' }}>this machine</b>. Your
          messages and data stay local unless an extension says otherwise.
        </p>
      </div>
    </div>
  );
}

Object.assign(window, { ChatHub });
