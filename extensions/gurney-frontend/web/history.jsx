/* global React, window */
// Conversation history — a read-only browser over the same conversations/
// messages tables the orchestrator writes. Because the panel's direct chat and
// Telegram both run through that orchestrator under the owner chatId, a
// transcript here unifies both surfaces. Master/detail: a list of recent
// conversations on the left, the selected transcript on the right.
const { useState: useStateHist, useEffect: useEffectHist } = React;

// "2:30 PM" today, "Yesterday 2:30 PM", else "Mar 3 2:30 PM".
function fmtConvDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function HistoryTab() {
  const [list, setList] = useStateHist(null);
  const [selectedId, setSelectedId] = useStateHist(null);
  const [detail, setDetail] = useStateHist(null);
  const [error, setError] = useStateHist(null);
  const [loadingDetail, setLoadingDetail] = useStateHist(false);

  const loadList = async () => {
    const r = await window.api.get('/api/conversations');
    if (r.ok && r.data) {
      setList(r.data.conversations || []);
      setError(null);
    } else {
      setError(r.error || 'Could not load conversations.');
    }
  };

  useEffectHist(() => {
    void loadList();
  }, []);

  useEffectHist(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    window.api.get(`/api/conversations/${selectedId}/messages`).then((r) => {
      if (cancelled) return;
      setLoadingDetail(false);
      if (r.ok && r.data && !r.data.error) setDetail(r.data);
      else
        setDetail({ error: (r.data && r.data.error) || r.error || 'Could not load transcript.' });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div>
      <window.SectionTitle
        sub="Every conversation, from Telegram and this panel alike. Read-only."
        right={
          <window.Button size="sm" variant="subtle" icon="refresh" onClick={loadList}>
            Refresh
          </window.Button>
        }
      >
        Conversation history
      </window.SectionTitle>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
            padding: 14,
            borderRadius: 'var(--radius)',
            border: '1px solid color-mix(in oklab, var(--err) 30%, transparent)',
            background: 'color-mix(in oklab, var(--err) 7%, var(--surface))',
          }}
        >
          <window.Icon name="alert" size={18} style={{ color: 'var(--err)' }} />
          <span style={{ flex: 1, fontSize: 13.5, color: 'var(--text-2)' }}>{error}</span>
          <window.Button size="sm" variant="subtle" icon="refresh" onClick={loadList}>
            Retry
          </window.Button>
        </div>
      )}

      <div className="history-grid" style={{ display: 'flex', gap: 'calc(14px * var(--gap))' }}>
        <ConversationList list={list} selectedId={selectedId} onSelect={setSelectedId} />
        <Transcript detail={detail} loading={loadingDetail} hasSelection={selectedId != null} />
      </div>
    </div>
  );
}

function ConversationList({ list, selectedId, onSelect }) {
  return (
    <div
      className="history-list"
      style={{
        width: 320,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxHeight: 'calc(100vh - 220px)',
        overflowY: 'auto',
      }}
    >
      {list == null && (
        <div style={{ color: 'var(--text-3)', fontSize: 13.5, padding: 12 }}>Loading…</div>
      )}
      {list && list.length === 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: '40px 16px',
            border: '1px dashed var(--border-2)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-3)',
            fontSize: 13.5,
          }}
        >
          No conversations yet. Chat with Gurney here or on Telegram to start one.
        </div>
      )}
      {list &&
        list.map((c) => {
          const on = c.id === selectedId;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              style={{
                textAlign: 'left',
                cursor: 'pointer',
                border: '1px solid',
                borderColor: on ? 'var(--accent)' : 'var(--border)',
                background: on ? 'var(--accent-soft)' : 'var(--surface)',
                borderRadius: 'var(--radius)',
                padding: '11px 13px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                boxShadow: 'var(--shadow-sm)',
                font: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)', flex: 1 }}>
                  {fmtConvDate(c.lastAt || c.startedAt)}
                </span>
                {c.current && <window.Badge tone="accent">Current</window.Badge>}
                <span
                  className="mono"
                  style={{ fontSize: 11.5, color: 'var(--text-3)' }}
                  title={`${c.messageCount} messages`}
                >
                  {c.messageCount}
                </span>
              </div>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--text)',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  lineHeight: 1.4,
                }}
              >
                {c.preview || <span style={{ color: 'var(--text-3)' }}>No user messages</span>}
              </span>
            </button>
          );
        })}
    </div>
  );
}

function Transcript({ detail, loading, hasSelection }) {
  if (!hasSelection)
    return (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          placeItems: 'center',
          minHeight: 320,
          border: '1px dashed var(--border-2)',
          borderRadius: 'var(--radius)',
          color: 'var(--text-3)',
          textAlign: 'center',
          padding: 24,
        }}
      >
        <div>
          <window.Icon name="doc" size={28} style={{ margin: '0 auto 10px' }} />
          <p style={{ fontSize: 14, color: 'var(--text-2)', fontWeight: 600 }}>
            Select a conversation
          </p>
          <p style={{ fontSize: 13, marginTop: 3 }}>Pick one on the left to read its transcript.</p>
        </div>
      </div>
    );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        maxHeight: 'calc(100vh - 220px)',
      }}
    >
      {loading && !detail && (
        <div style={{ padding: 20, color: 'var(--text-3)', fontSize: 13.5 }}>
          Loading transcript…
        </div>
      )}
      {detail && detail.error && (
        <div style={{ padding: 20, color: 'var(--err)', fontSize: 13.5 }}>{detail.error}</div>
      )}
      {detail && !detail.error && (
        <>
          {detail.summary && (
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
                background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
                fontSize: 12.5,
                color: 'var(--text-2)',
                lineHeight: 1.5,
                display: 'flex',
                gap: 9,
              }}
            >
              <window.Icon
                name="spark"
                size={15}
                style={{ color: 'var(--accent-strong)', flex: 'none', marginTop: 1 }}
              />
              <span>
                <b style={{ color: 'var(--text)' }}>Summary:</b> {detail.summary}
              </span>
            </div>
          )}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {detail.messages.length === 0 && (
              <p
                style={{ color: 'var(--text-3)', fontSize: 13.5, textAlign: 'center', padding: 20 }}
              >
                This conversation has no messages.
              </p>
            )}
            {detail.messages.map((m, i) => (
              <TranscriptMessage key={i} m={m} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TranscriptMessage({ m }) {
  const isUser = m.role === 'user';
  const isTool = m.role === 'tool';
  const isSystem = m.role === 'system';
  const time = m.createdAt
    ? new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  if (isTool || isSystem) {
    return (
      <div
        style={{
          alignSelf: 'center',
          maxWidth: '92%',
          width: '100%',
          background: 'var(--code-bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11.5,
            color: 'var(--text-3)',
            fontFamily: 'var(--font-mono)',
            marginBottom: 4,
          }}
        >
          <window.Icon name={isTool ? 'plug' : 'gear'} size={12} />
          {isTool ? m.toolName || 'tool' : 'system'}
        </div>
        <div
          style={{
            fontSize: 12.5,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 220,
            overflow: 'auto',
          }}
        >
          {m.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '78%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: isUser ? 'flex-end' : 'flex-start',
          gap: 4,
        }}
      >
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 14,
            fontSize: 14.5,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: isUser ? 'var(--accent)' : 'var(--surface-2)',
            color: isUser ? 'var(--on-accent)' : 'var(--text)',
            border: isUser ? 'none' : '1px solid var(--border)',
            borderBottomRightRadius: isUser ? 4 : 14,
            borderBottomLeftRadius: isUser ? 14 : 4,
          }}
        >
          {m.content}
        </div>
        {time && (
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {time}
            {typeof m.tokens === 'number' && m.tokens > 0 && (
              <span className="mono" style={{ marginLeft: 6 }}>
                · {m.tokens} tok
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { HistoryTab });
