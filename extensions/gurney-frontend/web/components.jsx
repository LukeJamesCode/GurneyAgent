/* global React, window */
// Pure presentational primitives, attached to window so the other browser-
// transpiled modules can use them without an import system. No app state lives
// here — these are the building blocks (icons, buttons, inputs, modal, badges).
const { useState, useEffect } = React;

/* ---------------------------------------------------------------- Icons
   Minimal stroke icons. Sized 1em, inherit color. Keep the set small. */
const PATHS = {
  power: 'M12 4v8 M7.5 7a7 7 0 1 0 9 0',
  stop: '', // drawn as rect below
  refresh: 'M4 11a8 8 0 0 1 14-5l2 2 M20 13a8 8 0 0 1-14 5l-2-2 M18 4v4h-4 M6 20v-4h4',
  chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.4A8 8 0 1 1 21 12Z',
  plug: 'M9 7V3 M15 7V3 M7 7h10v4a5 5 0 0 1-10 0V7Z M12 16v5',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 6.8 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 13H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 5 6.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 11 3V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11h.1a2 2 0 0 1 0 4H21Z',
  pulse: 'M3 12h4l2.5 7 5-14L18 12h3',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12 M18 6 6 18',
  send: 'M5 12h14 M13 6l6 6-6 6',
  plus: 'M12 5v14 M5 12h14',
  back: 'M15 6l-6 6 6 6',
  fwd: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M20 20l-4-4',
  alert:
    'M12 9v4 M12 17h.01 M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z',
  shield: 'M12 3 5 6v6c0 4 3 6.5 7 9 4-2.5 7-5 7-9V6l-7-3Z',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3 M5 11h14v9H5z',
  copy: 'M9 9h10v10H9z M5 15V5h10',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeoff:
    'M3 3l18 18 M10.6 10.6a3 3 0 0 0 4.2 4.2 M9.4 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3.3 4 M6.6 6.6A16 16 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 2.6-.4',
  link: 'M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 17l1-1',
  trash:
    'M4 7h16 M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2 M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13',
  doc: 'M14 3v5h5 M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2 M12 20v2 M4 12H2 M22 12h-2 M5 5 4 4 M20 20l-1-1 M19 5l1-1 M4 20l1-1',
  moon: 'M21 13A8.5 8.5 0 0 1 11 3a7 7 0 1 0 10 10Z',
  terminal: 'M5 7l4 4-4 4 M13 15h6',
  download: 'M12 4v10 M8 10l4 4 4-4 M5 20h14',
  spark:
    'M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5 18 18 M18 6l-2.5 2.5 M8.5 15.5 6 18',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
};
function Icon({ name, size = 18, fill, style, ...rest }) {
  const d = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: 'none', display: 'block', ...style }}
      aria-hidden="true"
      {...rest}
    >
      {name === 'stop' ? (
        <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none" />
      ) : name === 'dot' ? (
        <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
      ) : (
        <path d={d} />
      )}
    </svg>
  );
}

/* ---------------------------------------------------------------- Button */
function Button({ variant = 'default', size = 'md', icon, children, style, danger, ...rest }) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: 'var(--font-ui)',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid transparent',
    transition: 'background .15s, border-color .15s, color .15s, transform .05s, box-shadow .15s',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    userSelect: 'none',
  };
  const sizes = {
    sm: { padding: '7px 11px', fontSize: 13 },
    md: { padding: '10px 15px', fontSize: 14 },
    lg: { padding: '13px 20px', fontSize: 15.5 },
  };
  const variants = {
    primary: {
      background: 'var(--accent)',
      color: 'var(--on-accent)',
      boxShadow: 'var(--shadow-sm)',
    },
    default: { background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border-2)' },
    ghost: { background: 'transparent', color: 'var(--text-2)' },
    subtle: { background: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
    danger: { background: 'var(--err)', color: '#fff' },
    outline_danger: {
      background: 'transparent',
      color: 'var(--err)',
      borderColor: 'color-mix(in oklab, var(--err) 45%, transparent)',
    },
  };
  return (
    <button
      {...rest}
      onMouseDown={(e) => {
        e.currentTarget.style.transform = 'translateY(1px)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = '';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = '';
      }}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  );
}

function IconButton({ name, size = 18, label, active, style, ...rest }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 34,
        height: 34,
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent-strong)' : 'var(--text-2)',
        border: '1px solid',
        borderColor: active ? 'transparent' : 'var(--border)',
        transition: 'background .15s, color .15s',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--surface-2)';
          e.currentTarget.style.color = 'var(--text)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-2)';
        }
      }}
    >
      <Icon name={name} size={size} />
    </button>
  );
}

/* ---------------------------------------------------------------- Card */
function Card({ children, pad = 18, style, hover, ...rest }) {
  return (
    <div
      {...rest}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: pad,
        boxShadow: 'var(--shadow-sm)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Toggle */
function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 99,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--border-2)',
        position: 'relative',
        transition: 'background .2s',
        flex: 'none',
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: 99,
          background: '#fff',
          transition: 'left .2s cubic-bezier(.3,1.4,.5,1)',
          boxShadow: '0 1px 2px rgba(0,0,0,.3)',
        }}
      />
    </button>
  );
}

/* ---------------------------------------------------------------- StatusDot */
const STATUS_COLOR = {
  running: 'var(--ok)',
  ok: 'var(--ok)',
  pass: 'var(--ok)',
  starting: 'var(--warn)',
  warn: 'var(--warn)',
  stopped: 'var(--text-3)',
  error: 'var(--err)',
  err: 'var(--err)',
  fail: 'var(--err)',
};
function StatusDot({ state, size = 9, pulse }) {
  const c = STATUS_COLOR[state] || 'var(--text-3)';
  return (
    <span
      style={{
        position: 'relative',
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-block',
      }}
    >
      {pulse && (
        <span
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: 99,
            background: c,
            opacity: 0.3,
            animation: 'pulse-dot 1.6s ease-in-out infinite',
          }}
        />
      )}
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 99,
          background: c,
          animation: state === 'starting' ? 'pulse-dot 1s linear infinite' : 'none',
        }}
      />
    </span>
  );
}

/* ---------------------------------------------------------------- Badge */
function Badge({ tone = 'neutral', children, soft = true, style }) {
  const tones = {
    neutral: { c: 'var(--text-2)', bg: 'var(--surface-2)', bd: 'var(--border)' },
    ok: {
      c: 'var(--ok)',
      bg: 'color-mix(in oklab, var(--ok) 14%, transparent)',
      bd: 'color-mix(in oklab, var(--ok) 30%, transparent)',
    },
    warn: {
      c: 'color-mix(in oklab, var(--warn) 78%, var(--text))',
      bg: 'color-mix(in oklab, var(--warn) 16%, transparent)',
      bd: 'color-mix(in oklab, var(--warn) 34%, transparent)',
    },
    err: {
      c: 'var(--err)',
      bg: 'color-mix(in oklab, var(--err) 13%, transparent)',
      bd: 'color-mix(in oklab, var(--err) 30%, transparent)',
    },
    accent: { c: 'var(--accent-strong)', bg: 'var(--accent-soft)', bd: 'transparent' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 99,
        color: t.c,
        lineHeight: 1.3,
        background: soft ? t.bg : 'transparent',
        border: `1px solid ${t.bd}`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- Form fields */
function Label({ children, hint, htmlFor }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 13.5,
        fontWeight: 600,
        color: 'var(--text)',
        marginBottom: 6,
      }}
    >
      {children}
      {hint && (
        <span
          style={{
            display: 'block',
            fontWeight: 400,
            color: 'var(--text-3)',
            fontSize: 12.5,
            marginTop: 3,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}

const inputStyle = (extra) => ({
  width: '100%',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--text)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border-2)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px 12px',
  outline: 'none',
  transition: 'border-color .15s, box-shadow .15s',
  ...extra,
});
function focusOn(e) {
  e.target.style.borderColor = 'var(--accent)';
  e.target.style.boxShadow = '0 0 0 3px var(--accent-ring)';
}
function focusOff(e) {
  e.target.style.borderColor = 'var(--border-2)';
  e.target.style.boxShadow = 'none';
}

function Input({ mono, invalid, style, ...rest }) {
  return (
    <input
      {...rest}
      onFocus={focusOn}
      onBlur={focusOff}
      style={inputStyle({
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)',
        borderColor: invalid ? 'var(--err)' : undefined,
        ...style,
      })}
    />
  );
}

function SecretInput({ value, onChange, placeholder, name }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        name={name}
        onFocus={focusOn}
        onBlur={focusOff}
        style={inputStyle({
          fontFamily: 'var(--font-mono)',
          paddingRight: 42,
          letterSpacing: show ? 0 : 1,
        })}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide' : 'Show'}
        style={{
          position: 'absolute',
          right: 6,
          top: 6,
          width: 30,
          height: 30,
          border: 'none',
          background: 'transparent',
          color: 'var(--text-3)',
          cursor: 'pointer',
          display: 'grid',
          placeItems: 'center',
          borderRadius: 6,
        }}
      >
        <Icon name={show ? 'eyeoff' : 'eye'} size={17} />
      </button>
    </div>
  );
}

function Select({ value, onChange, children, style }) {
  return (
    <div style={{ position: 'relative' }}>
      <select
        value={value}
        onChange={onChange}
        onFocus={focusOn}
        onBlur={focusOff}
        style={inputStyle({ appearance: 'none', paddingRight: 36, cursor: 'pointer', ...style })}
      >
        {children}
      </select>
      <Icon
        name="fwd"
        size={15}
        style={{
          position: 'absolute',
          right: 11,
          top: '50%',
          transform: 'translateY(-50%) rotate(90deg)',
          color: 'var(--text-3)',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- Segmented control */
function Segmented({ value, onChange, options, size = 'md' }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const lbl = typeof o === 'string' ? o : o.label;
        const on = v === value;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            style={{
              border: 'none',
              cursor: 'pointer',
              borderRadius: 6,
              fontWeight: 600,
              padding: size === 'sm' ? '5px 10px' : '7px 13px',
              fontSize: size === 'sm' ? 12.5 : 13.5,
              background: on ? 'var(--raised)' : 'transparent',
              color: on ? 'var(--text)' : 'var(--text-3)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              transition: 'all .15s',
              textTransform: 'capitalize',
            }}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Modal */
function Modal({ open, onClose, title, children, footer, width = 460, tone }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'oklch(0 0 0 / 0.45)',
        backdropFilter: 'blur(3px)',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        animation: 'fade .15s ease',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width,
          maxWidth: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border-2)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-pop)',
          animation: 'rise .22s cubic-bezier(.2,.7,.3,1)',
        }}
      >
        <div style={{ padding: '20px 22px 0', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {tone && (
            <span
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                display: 'grid',
                placeItems: 'center',
                flex: 'none',
                background:
                  tone === 'err'
                    ? 'color-mix(in oklab, var(--err) 14%, transparent)'
                    : 'var(--accent-soft)',
                color: tone === 'err' ? 'var(--err)' : 'var(--accent-strong)',
              }}
            >
              <Icon name={tone === 'err' ? 'alert' : 'shield'} size={20} />
            </span>
          )}
          <h3 style={{ fontSize: 18, flex: 1 }}>{title}</h3>
          <IconButton
            name="x"
            label="Close"
            onClick={onClose}
            style={{ marginTop: -4, marginRight: -6 }}
          />
        </div>
        <div
          style={{ padding: '12px 22px 0', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.55 }}
        >
          {children}
        </div>
        {footer && (
          <div
            style={{
              padding: '20px 22px 22px',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 10,
              marginTop: 8,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Tooltip (hover help) */
function Help({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 99,
          border: '1px solid var(--border-2)',
          color: 'var(--text-3)',
          fontSize: 11,
          fontWeight: 700,
          display: 'grid',
          placeItems: 'center',
          cursor: 'help',
        }}
      >
        ?
      </span>
      {show && (
        <span
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 220,
            background: 'var(--raised)',
            color: 'var(--text)',
            border: '1px solid var(--border-2)',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12.5,
            lineHeight: 1.45,
            fontWeight: 400,
            boxShadow: 'var(--shadow-pop)',
            zIndex: 50,
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- Section header */
function SectionTitle({ children, sub, right }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 18,
      }}
    >
      <div>
        <h2 style={{ fontSize: 22, letterSpacing: '-0.02em' }}>{children}</h2>
        {sub && <p style={{ color: 'var(--text-3)', fontSize: 14, marginTop: 4 }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

Object.assign(window, {
  Icon,
  Button,
  IconButton,
  Card,
  Toggle,
  StatusDot,
  STATUS_COLOR,
  Badge,
  Label,
  Input,
  SecretInput,
  Select,
  Segmented,
  Modal,
  Help,
  SectionTitle,
});
