/* global React, window */
// First-run setup wizard. Mirrors `gurney init` but friendly, and writes the
// same config.json the CLI does. Live checks hit real endpoints:
//   token  → POST /api/telegram/validate
//   ollama → POST /api/ollama/test (then GET model tags)
//   finish → POST /api/config, then enable/disable chosen extensions
// The last step hands off to the hub with the agent starting.
const { useState: useStateWiz, useEffect: useEffectWiz } = React;

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'telegram', label: 'Connect Telegram' },
  { id: 'allowlist', label: 'Who can talk to it' },
  { id: 'ollama', label: 'Model server' },
  { id: 'models', label: 'Choose models' },
  { id: 'hardware', label: 'Hardware tier' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'review', label: 'Review & finish' },
];

function Wizard({ onFinish, onExit, suggestedTier, ramGb }) {
  const [step, setStep] = useStateWiz(0);
  const [saving, setSaving] = useStateWiz(false);
  const [saveErr, setSaveErr] = useStateWiz(null);
  const [models, setModels] = useStateWiz([]);
  const [data, setData] = useStateWiz({
    token: '',
    botName: '',
    botUser: '',
    tokenState: 'idle',
    tokenErr: '',
    allowlist: [],
    ollamaUrl: 'http://localhost:11434',
    ollamaState: 'idle',
    ollamaErr: '',
    chatModel: '',
    reasoningModel: '',
    toolsModel: '',
    tier: suggestedTier || 'standard',
  });
  const set = (patch) => setData((d) => ({ ...d, ...patch }));

  const canNext = () => {
    switch (STEPS[step].id) {
      case 'telegram':
        return data.tokenState === 'ok';
      case 'allowlist':
        return data.allowlist.length > 0;
      case 'ollama':
        return data.ollamaState === 'ok';
      case 'models':
        return !!data.chatModel;
      default:
        return true;
    }
  };

  const finish = async () => {
    setSaving(true);
    setSaveErr(null);
    const body = {
      token: data.token,
      allowlist: data.allowlist,
      ollamaUrl: data.ollamaUrl,
      chatModel: data.chatModel,
      reasoningModel: data.reasoningModel,
      toolsModel: data.toolsModel,
      tier: data.tier,
    };
    const r = await window.api.post('/api/config', body);
    setSaving(false);
    if (!r.ok) {
      setSaveErr(r.error || 'Could not save your setup.');
      return;
    }
    onFinish();
  };

  const next = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else finish();
  };
  const back = () => step > 0 && setStep(step - 1);
  const cur = STEPS[step].id;

  return (
    <div style={{ height: '100%', display: 'flex', background: 'var(--bg)', overflow: 'hidden' }}>
      <aside
        style={{
          width: 290,
          flex: 'none',
          background: 'var(--bg-2)',
          borderRight: '1px solid var(--border)',
          padding: '26px 22px',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="wiz-rail"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 30 }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: 'var(--accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <span
              className="display"
              style={{ color: 'var(--on-accent)', fontWeight: 700, fontSize: 18 }}
            >
              g
            </span>
          </span>
          <div>
            <div className="display" style={{ fontSize: 16, fontWeight: 700 }}>
              Gurney
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>first-time setup</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          {STEPS.map((s, i) => {
            const done = i < step,
              active = i === step;
            return (
              <button
                key={s.id}
                onClick={() => i <= step && setStep(i)}
                disabled={i > step}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '9px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  background: active ? 'var(--surface)' : 'transparent',
                  cursor: i <= step ? 'pointer' : 'default',
                  textAlign: 'left',
                  boxShadow: active ? 'var(--shadow-sm)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 99,
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 12,
                    fontWeight: 700,
                    background: done
                      ? 'var(--accent)'
                      : active
                        ? 'var(--accent-soft)'
                        : 'var(--surface-2)',
                    color: done
                      ? 'var(--on-accent)'
                      : active
                        ? 'var(--accent-strong)'
                        : 'var(--text-3)',
                    border: active ? 'none' : '1px solid var(--border)',
                  }}
                >
                  {done ? <window.Icon name="check" size={13} /> : i + 1}
                </span>
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? 'var(--text)' : done ? 'var(--text-2)' : 'var(--text-3)',
                  }}
                >
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={onExit}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            fontSize: 12.5,
            cursor: 'pointer',
            textAlign: 'left',
            padding: '8px 10px',
          }}
        >
          Skip setup — I’ll do it later →
        </button>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '46px 0' }}>
          <div
            key={cur}
            className="rise"
            style={{ maxWidth: 600, margin: '0 auto', padding: '0 32px' }}
          >
            {cur === 'welcome' && <StepWelcome />}
            {cur === 'telegram' && <StepTelegram data={data} set={set} />}
            {cur === 'allowlist' && <StepAllowlist data={data} set={set} />}
            {cur === 'ollama' && (
              <StepOllama data={data} set={set} models={models} setModels={setModels} />
            )}
            {cur === 'models' && <StepModels data={data} set={set} models={models} />}
            {cur === 'hardware' && (
              <StepHardware data={data} set={set} suggestedTier={suggestedTier} ramGb={ramGb} />
            )}
            {cur === 'extensions' && <StepExtensions />}
            {cur === 'review' && <StepReview data={data} goto={setStep} />}
          </div>
        </div>
        <div
          style={{
            flex: 'none',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-2)',
            padding: '16px 32px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          {saveErr && (
            <span
              style={{
                fontSize: 13,
                color: 'var(--err)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <window.Icon name="alert" size={14} /> {saveErr}
            </span>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                height: 5,
                flex: 1,
                maxWidth: 220,
                background: 'var(--surface-2)',
                borderRadius: 99,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${((step + 1) / STEPS.length) * 100}%`,
                  background: 'var(--accent)',
                  borderRadius: 99,
                  transition: 'width .3s',
                }}
              />
            </div>
            <span
              style={{ fontSize: 12.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}
            >
              {step + 1} / {STEPS.length}
            </span>
          </div>
          <window.Button
            variant="ghost"
            icon="back"
            onClick={back}
            disabled={step === 0}
            style={{ opacity: step === 0 ? 0.4 : 1 }}
          >
            Back
          </window.Button>
          {!canNext() && ['telegram', 'allowlist', 'ollama', 'models'].includes(cur) ? (
            <window.Button variant="default" disabled style={{ opacity: 0.55 }}>
              {cur === 'models' ? 'Pick a chat model' : 'Complete this step'}
            </window.Button>
          ) : (
            <window.Button
              variant="primary"
              icon={cur === 'review' ? 'power' : 'fwd'}
              onClick={next}
              disabled={saving}
            >
              {saving ? (
                <>
                  <window.Icon name="refresh" size={15} className="spin" /> Saving…
                </>
              ) : cur === 'review' ? (
                'Start Gurney'
              ) : (
                'Continue'
              )}
            </window.Button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepHead({ kicker, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      {kicker && (
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--accent-strong)',
            textTransform: 'uppercase',
            letterSpacing: '.07em',
            marginBottom: 10,
          }}
        >
          {kicker}
        </div>
      )}
      <h1 style={{ fontSize: 30, letterSpacing: 0, lineHeight: 1.1 }}>{title}</h1>
      {children && (
        <p style={{ fontSize: 15.5, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 12 }}>
          {children}
        </p>
      )}
    </div>
  );
}

function StepWelcome() {
  const points = [
    {
      icon: 'shield',
      title: 'Runs privately on this machine',
      desc: 'Your conversations and data stay local. Nothing leaves unless an extension explicitly sends it.',
    },
    {
      icon: 'send',
      title: 'You chat through Telegram',
      desc: 'Gurney lives in your Telegram app as a bot — and you can talk to it here too.',
    },
    {
      icon: 'plug',
      title: 'Grows with extensions',
      desc: 'Start minimal, then add calendar, voice, reminders and more whenever you like.',
    },
  ];
  return (
    <div>
      <StepHead kicker="Welcome" title="Let’s set up Gurney, your private assistant.">
        This takes about three minutes. We’ll connect your chat app, pick a model to run on this
        machine, and choose any extras you want. You can change all of it later.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {points.map((p) => (
          <div
            key={p.title}
            style={{
              display: 'flex',
              gap: 14,
              padding: 16,
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                flex: 'none',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--accent-soft)',
                color: 'var(--accent-strong)',
              }}
            >
              <window.Icon name={p.icon} size={19} />
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{p.title}</div>
              <p style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.5 }}>
                {p.desc}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HelperBox({ open, onToggle, title, children }) {
  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        background: 'var(--surface-2)',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '11px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-2)',
          fontSize: 13.5,
          fontWeight: 600,
          textAlign: 'left',
        }}
      >
        <window.Icon name="spark" size={15} style={{ color: 'var(--accent-strong)' }} /> {title}
        <window.Icon
          name="fwd"
          size={15}
          style={{
            marginLeft: 'auto',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .2s',
            color: 'var(--text-3)',
          }}
        />
      </button>
      {open && (
        <div
          className="fade"
          style={{
            padding: '0 14px 14px 38px',
            fontSize: 13.5,
            color: 'var(--text-2)',
            lineHeight: 1.6,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function StepTelegram({ data, set }) {
  const [help, setHelp] = useStateWiz(false);
  const validate = async () => {
    set({ tokenState: 'checking', tokenErr: '' });
    const r = await window.api.post('/api/telegram/validate', { token: data.token });
    if (r.ok && r.data.ok)
      set({ tokenState: 'ok', botName: r.data.botName, botUser: r.data.botUser });
    else
      set({
        tokenState: 'err',
        tokenErr: (r.data && r.data.error) || r.error || 'That doesn’t look like a valid token.',
      });
  };
  return (
    <div>
      <StepHead kicker="Step 1" title="Connect Telegram">
        Telegram is the chat app you’ll use to talk to Gurney. You need a <b>bot token</b> — a
        secret key that lets Gurney act as your personal bot.
      </StepHead>
      <window.Label hint="Paste the token here. It looks like 1234567890:AAH... and stays on this machine.">
        Bot token
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <window.SecretInput
            value={data.token}
            onChange={(e) => set({ token: e.target.value, tokenState: 'idle' })}
            placeholder="1234567890:AAH…"
          />
        </div>
        <window.Button
          variant="primary"
          onClick={validate}
          disabled={!data.token || data.tokenState === 'checking'}
          style={{ opacity: !data.token ? 0.55 : 1 }}
        >
          {data.tokenState === 'checking' ? (
            <>
              <window.Icon name="refresh" size={15} className="spin" /> Checking
            </>
          ) : (
            'Validate'
          )}
        </window.Button>
      </div>
      <CheckResult
        state={data.tokenState}
        ok={
          <>
            Connected as <b>{data.botName}</b>{' '}
            <span className="mono" style={{ color: 'var(--text-3)' }}>
              {data.botUser}
            </span>
          </>
        }
        err={
          data.tokenErr ||
          'That doesn’t look like a valid token. Check you copied the whole thing from BotFather.'
        }
      />
      <HelperBox open={help} onToggle={() => setHelp((h) => !h)} title="How do I get a token?">
        Open Telegram and message <span className="mono">@BotFather</span>. Send{' '}
        <span className="mono">/newbot</span>, pick a name and username, and BotFather replies with
        a token. Copy it and paste it above.
      </HelperBox>
    </div>
  );
}

function StepAllowlist({ data, set }) {
  const [help, setHelp] = useStateWiz(false);
  const [draft, setDraft] = useStateWiz('');
  const [err, setErr] = useStateWiz('');
  const add = () => {
    const v = draft.trim();
    if (!/^\d{4,}$/.test(v)) {
      setErr('A Telegram ID is a number, e.g. 8675309.');
      return;
    }
    if (data.allowlist.includes(v)) {
      setErr('That ID is already added.');
      return;
    }
    set({ allowlist: [...data.allowlist, v] });
    setDraft('');
    setErr('');
  };
  return (
    <div>
      <StepHead kicker="Step 2" title="Who’s allowed to talk to it?">
        For privacy, only the Telegram accounts you list here can chat with your bot. Everyone else
        is silently ignored. Add yourself first.
      </StepHead>
      <window.Label hint="Add one or more numeric Telegram user IDs.">
        Allowed user IDs
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1, maxWidth: 320 }}>
          <window.Input
            mono
            value={draft}
            invalid={!!err}
            onChange={(e) => {
              setDraft(e.target.value);
              setErr('');
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="e.g. 8675309"
          />
        </div>
        <window.Button variant="default" icon="plus" onClick={add}>
          Add
        </window.Button>
      </div>
      {err && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginTop: 9,
            fontSize: 13,
            color: 'var(--err)',
          }}
        >
          <window.Icon name="alert" size={14} /> {err}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16, minHeight: 34 }}>
        {data.allowlist.length === 0 && (
          <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>No one added yet.</span>
        )}
        {data.allowlist.map((id) => (
          <span
            key={id}
            className="rise"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 9px 7px 13px',
              borderRadius: 99,
              background: 'var(--accent-soft)',
              border: '1px solid transparent',
              fontFamily: 'var(--font-mono)',
              fontSize: 13.5,
              color: 'var(--accent-strong)',
              fontWeight: 600,
            }}
          >
            {id}
            <button
              onClick={() => set({ allowlist: data.allowlist.filter((x) => x !== id) })}
              aria-label="Remove"
              style={{
                width: 20,
                height: 20,
                borderRadius: 99,
                border: 'none',
                background: 'color-mix(in oklab, var(--accent) 25%, transparent)',
                color: 'var(--accent-strong)',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <window.Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <HelperBox open={help} onToggle={() => setHelp((h) => !h)} title="How do I find my ID?">
        In Telegram, message <span className="mono">@userinfobot</span> and it replies with your
        numeric ID. Paste that number above.
      </HelperBox>
    </div>
  );
}

function StepOllama({ data, set, models, setModels }) {
  const test = async () => {
    set({ ollamaState: 'testing', ollamaErr: '' });
    const r = await window.api.post('/api/ollama/test', { url: data.ollamaUrl });
    if (r.ok && r.data.ok) {
      set({ ollamaState: 'ok' });
      setModels(r.data.models || []);
    } else set({ ollamaState: 'err', ollamaErr: (r.data && r.data.error) || r.error || '' });
  };
  return (
    <div>
      <StepHead kicker="Step 3" title="Local model server">
        Gurney runs its AI models with <b>Ollama</b>, a small program on this machine. Let’s make
        sure Gurney can reach it.
      </StepHead>
      <window.Label hint="The address Ollama listens on. The default works for most setups.">
        Ollama URL
      </window.Label>
      <div style={{ display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <window.Input
            mono
            value={data.ollamaUrl}
            onChange={(e) => set({ ollamaUrl: e.target.value, ollamaState: 'idle' })}
          />
        </div>
        <window.Button variant="primary" onClick={test} disabled={data.ollamaState === 'testing'}>
          {data.ollamaState === 'testing' ? (
            <>
              <window.Icon name="refresh" size={15} className="spin" /> Testing
            </>
          ) : (
            'Test connection'
          )}
        </window.Button>
      </div>
      <CheckResult
        state={data.ollamaState === 'testing' ? 'checking' : data.ollamaState}
        ok={
          <>
            Reachable — found{' '}
            <b>
              {models.length} model{models.length === 1 ? '' : 's'}
            </b>{' '}
            on this machine.
          </>
        }
        err={
          data.ollamaErr
            ? `Couldn’t reach Ollama: ${data.ollamaErr}`
            : 'Couldn’t reach Ollama there. Is it running? Try the default http://localhost:11434.'
        }
      />
      {data.ollamaState === 'ok' && models.length > 0 && (
        <div
          className="fade"
          style={{
            marginTop: 16,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          {models.map((m, i) => (
            <div
              key={m}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                borderTop: i ? '1px solid var(--border)' : 'none',
                background: 'var(--surface)',
              }}
            >
              <window.Icon name="spark" size={15} style={{ color: 'var(--accent-strong)' }} />
              <span className="mono" style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>
                {m}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelSlot({ label, hint, value, onChange, models, allowSkip, skipLabel }) {
  const [manual, setManual] = useStateWiz(false);
  const useManual = manual || models.length === 0;
  return (
    <div>
      <window.Label hint={hint}>{label}</window.Label>
      {useManual ? (
        <window.Input
          mono
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="model:tag"
        />
      ) : (
        <window.Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{allowSkip ? skipLabel : 'Select a model…'}</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </window.Select>
      )}
      {models.length > 0 && (
        <button
          onClick={() => setManual((m) => !m)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-3)',
            fontSize: 12.5,
            cursor: 'pointer',
            padding: '7px 0 0',
            fontWeight: 500,
          }}
        >
          {manual ? '← Pick from detected models' : 'Enter a tag manually →'}
        </button>
      )}
    </div>
  );
}

function StepModels({ data, set, models }) {
  return (
    <div>
      <StepHead kicker="Step 4" title="Choose your models">
        Gurney uses up to three model “slots”. You only really need the first one.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <ModelSlot
          label="Chat model — your everyday default"
          hint="Fast model used for normal conversation. Required."
          value={data.chatModel}
          onChange={(v) => set({ chatModel: v })}
          models={models}
        />
        <ModelSlot
          label="Reasoning model — for hard problems"
          hint="A bigger, slower model for tricky questions. Optional."
          value={data.reasoningModel}
          onChange={(v) => set({ reasoningModel: v })}
          models={models}
          allowSkip
          skipLabel="Skip — my hardware is small"
        />
        <ModelSlot
          label="Tools model — for tool-calling"
          hint="Used when Gurney calls tools. Leave blank to reuse your Chat model."
          value={data.toolsModel}
          onChange={(v) => set({ toolsModel: v })}
          models={models}
          allowSkip
          skipLabel="Use my Chat model"
        />
      </div>
    </div>
  );
}

function StepHardware({ data, set, suggestedTier, ramGb }) {
  const tiers = [
    {
      id: 'small',
      title: 'Small',
      desc: 'Raspberry Pi or similar. Keeps things light and fast.',
      ram: '≤ 4 GB',
    },
    {
      id: 'standard',
      title: 'Standard',
      desc: 'A mini PC or laptop. A good balance for most people.',
      ram: '4–16 GB',
    },
    {
      id: 'heavy',
      title: 'Heavy',
      desc: 'A powerful desktop. Run bigger models and reasoning.',
      ram: '16 GB+',
    },
  ];
  const sug = suggestedTier || 'standard';
  return (
    <div>
      <StepHead kicker="Step 5" title="How powerful is this machine?">
        {ramGb != null ? (
          <>
            We detected <b>{ramGb} GB of RAM</b> and suggest{' '}
            <b style={{ textTransform: 'capitalize' }}>{sug}</b>.
          </>
        ) : (
          <>
            We suggest <b style={{ textTransform: 'capitalize' }}>{sug}</b>.
          </>
        )}{' '}
        This just helps Gurney pick sensible defaults — change it if you know better.
      </StepHead>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {tiers.map((t) => {
          const on = data.tier === t.id;
          return (
            <button
              key={t.id}
              onClick={() => set({ tier: t.id })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: 16,
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                textAlign: 'left',
                background: on ? 'var(--accent-soft)' : 'var(--surface)',
                border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                transition: 'all .15s',
              }}
            >
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 99,
                  flex: 'none',
                  border: `2px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                {on && (
                  <span
                    style={{ width: 10, height: 10, borderRadius: 99, background: 'var(--accent)' }}
                  />
                )}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 15.5 }}>{t.title}</span>
                  {t.id === sug && <window.Badge tone="accent">Suggested</window.Badge>}
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{t.desc}</p>
              </div>
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                {t.ram}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepExtensions() {
  const [exts, setExts] = useStateWiz(null);
  const [busy, setBusy] = useStateWiz(null);
  const load = async () => {
    const r = await window.api.get('/api/extensions');
    // Hide the panel itself — it's already running and can't be toggled here.
    if (r.ok) setExts(r.data.extensions.filter((e) => !e.self));
    else setExts([]);
  };
  useEffectWiz(() => {
    load();
  }, []);
  const toggle = async (e) => {
    setBusy(e.name);
    await window.api.post(
      `/api/extensions/${encodeURIComponent(e.name)}/${e.enabled ? 'disable' : 'enable'}`,
    );
    setBusy(null);
    load();
  };
  const pretty = (e) =>
    e.name
      .replace(/^gurney-/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const blurb = (e) => (window.EXT_BLURBS && window.EXT_BLURBS[e.name]) || e.description || '';
  return (
    <div>
      <StepHead kicker="Step 6" title="Pick your extensions">
        Turn on the capabilities you want now, or skip and add them later from the Extensions tab.
        Anything that needs an account will ask you to connect after setup.
      </StepHead>
      {exts === null && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>Loading extensions…</div>
      )}
      {exts && exts.length === 0 && (
        <div style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
          No extensions are installed yet. You can add them later with{' '}
          <span className="mono">gurney ext install</span>.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(exts || []).map((e) => (
          <div
            key={e.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 13,
              padding: 15,
              borderRadius: 'var(--radius)',
              background: 'var(--surface)',
              border: `1px solid ${e.enabled ? 'color-mix(in oklab, var(--accent) 40%, var(--border))' : 'var(--border)'}`,
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                flex: 'none',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--accent-soft)',
                color: 'var(--accent-strong)',
                fontWeight: 700,
                fontFamily: 'var(--font-display)',
                fontSize: 14,
              }}
            >
              {pretty(e)
                .replace(/[^A-Za-z ]/g, '')
                .split(' ')
                .slice(0, 2)
                .map((w) => w[0])
                .join('')}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 14.5 }}>{pretty(e)}</span>
                {e.needsAuth && !e.authConnected && (
                  <window.Badge tone="warn">
                    <window.Icon name="link" size={11} />
                    needs connection
                  </window.Badge>
                )}
                {e.needsAuth && e.authConnected && (
                  <window.Badge tone="ok">
                    <window.Icon name="check" size={11} />
                    connected
                  </window.Badge>
                )}
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.45 }}>
                {blurb(e)}
              </p>
            </div>
            {busy === e.name ? (
              <window.Icon
                name="refresh"
                size={18}
                className="spin"
                style={{ color: 'var(--text-3)' }}
              />
            ) : (
              <window.Toggle
                checked={e.enabled}
                onChange={() => toggle(e)}
                label={`Enable ${pretty(e)}`}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StepReview({ data, goto }) {
  const rows = [
    {
      label: 'Telegram bot',
      value: data.botName ? `${data.botName} ${data.botUser}` : 'Not connected',
      step: 1,
      ok: data.tokenState === 'ok',
    },
    {
      label: 'Allowlist',
      value: data.allowlist.length
        ? `${data.allowlist.length} user${data.allowlist.length > 1 ? 's' : ''}`
        : 'None',
      step: 2,
      ok: data.allowlist.length > 0,
    },
    { label: 'Ollama', value: data.ollamaUrl, step: 3, ok: data.ollamaState === 'ok' },
    { label: 'Chat model', value: data.chatModel || 'Not set', step: 4, ok: !!data.chatModel },
    { label: 'Reasoning model', value: data.reasoningModel || 'Skipped', step: 4, ok: true },
    {
      label: 'Tools model',
      value: data.toolsModel || `${data.chatModel || 'Chat model'} (fallback)`,
      step: 4,
      ok: true,
    },
    { label: 'Hardware tier', value: data.tier, step: 5, ok: true, cap: true },
  ];
  return (
    <div>
      <StepHead kicker="Almost there" title="Review &amp; finish">
        Here’s everything you chose. Press <b>Start Gurney</b> to save your setup and land in the
        hub with the agent coming online.
      </StepHead>
      <window.Card pad={0}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '13px 16px',
              borderTop: i ? '1px solid var(--border)' : 'none',
            }}
          >
            <window.StatusDot state={r.ok ? 'ok' : 'warn'} size={7} />
            <span style={{ fontSize: 13.5, color: 'var(--text-3)', width: 130, flex: 'none' }}>
              {r.label}
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                flex: 1,
                textTransform: r.cap ? 'capitalize' : 'none',
                fontFamily:
                  r.label.includes('model') || r.label === 'Ollama'
                    ? 'var(--font-mono)'
                    : 'var(--font-ui)',
              }}
            >
              {r.value}
            </span>
            <button
              onClick={() => goto(r.step)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-strong)',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Edit
            </button>
          </div>
        ))}
      </window.Card>
      <div
        style={{
          display: 'flex',
          gap: 11,
          marginTop: 16,
          padding: 14,
          borderRadius: 'var(--radius)',
          border: '1px dashed var(--border-2)',
          background: 'color-mix(in oklab, var(--accent) 5%, var(--surface))',
        }}
      >
        <window.Icon
          name="shield"
          size={18}
          style={{ color: 'var(--accent-strong)', flex: 'none', marginTop: 1 }}
        />
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Your token and settings are saved only on this machine. You can change any of this later
          in Settings.
        </p>
      </div>
    </div>
  );
}

function CheckResult({ state, ok, err }) {
  if (state === 'idle' || !state) return null;
  if (state === 'checking')
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 11,
          fontSize: 13.5,
          color: 'var(--text-2)',
        }}
      >
        <window.Icon name="refresh" size={15} className="spin" /> Checking…
      </div>
    );
  if (state === 'ok')
    return (
      <div
        className="fade"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 11,
          fontSize: 13.5,
          color: 'var(--ok)',
        }}
      >
        <window.Icon name="check" size={16} /> <span>{ok}</span>
      </div>
    );
  return (
    <div
      className="fade"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        marginTop: 11,
        fontSize: 13.5,
        color: 'var(--err)',
      }}
    >
      <window.Icon name="alert" size={16} style={{ flex: 'none', marginTop: 1 }} />{' '}
      <span>{err}</span>
    </div>
  );
}

Object.assign(window, { Wizard });
