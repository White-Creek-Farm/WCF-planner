// MentionTextarea — plain <textarea> with an @-triggered profile picker.
//
// Storage format (inline, reversible):
//   @[Display Name](profile:<uuid>)
// The server-side _extract_mention_uuids and the client-side
// extractMentionUuids in activityApi.js BOTH parse this same form.
//
// Props:
//   sb         supabase client (used to load eligible profiles via
//              tasksCenterApi's loadTaskAssignableProfilesById — single
//              source of truth for "who is mentionable")
//   value      current body text (string)
//   mentions   current mention uuids ([uuid])
//   onChange   ({body, mentions}) called on every keystroke / pick /
//              programmatic update
//   placeholder
//   disabled
import React from 'react';
import {loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';
import {extractMentionUuids, buildMentionToken} from '../lib/activityApi.js';

const TEXTAREA_STYLE = {
  width: '100%',
  minHeight: 64,
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  resize: 'vertical',
  lineHeight: 1.45,
};

const POPOVER_STYLE = {
  position: 'absolute',
  zIndex: 220,
  top: '100%',
  left: 0,
  marginTop: 4,
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  boxShadow: '0 6px 18px rgba(0,0,0,.12)',
  minWidth: 220,
  maxWidth: 320,
  maxHeight: 240,
  overflowY: 'auto',
  padding: 4,
};
const POPOVER_ITEM = {
  display: 'block',
  width: '100%',
  padding: '6px 10px',
  background: 'none',
  border: 'none',
  borderRadius: 6,
  textAlign: 'left',
  fontSize: 13,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const POPOVER_ITEM_ACTIVE = {
  ...POPOVER_ITEM,
  background: '#ecfdf5',
  color: '#085041',
};

export default function MentionTextarea({sb, value = '', mentions = [], onChange, placeholder, disabled}) {
  const [eligible, setEligible] = React.useState([]); // [{id, full_name}]
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const taRef = React.useRef(null);
  const anchorRef = React.useRef(null);

  // Load eligible profiles once. Re-uses the canonical Tasks v2
  // availability helper — single source of truth for "who can be
  // mentioned" (active + visible in Public Tasks availability config).
  React.useEffect(() => {
    if (!sb) return;
    let cancelled = false;
    loadTaskAssignableProfilesById(sb)
      .then((map) => {
        if (cancelled) return;
        const list = Object.values(map || {});
        list.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        setEligible(list);
      })
      .catch((e) => {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('MentionTextarea: profile load failed', e && e.message ? e.message : e);
        }
        if (!cancelled) setEligible([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sb]);

  function emit(nextBody) {
    const next = {body: nextBody, mentions: extractMentionUuids(nextBody)};
    if (onChange) onChange(next);
    return next;
  }

  // After every change, scan back from the caret for an @<query> token
  // (only if no closing ']' or whitespace breaks it). If found, open the
  // popover with the matching profiles.
  function updateMentionState() {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) {
      setOpen(false);
      return;
    }
    const seg = before.slice(at + 1);
    // If the @ is already closed off with a paren-pair, we're inside an
    // existing mention token — don't re-trigger.
    if (/[\s\])(]/.test(seg)) {
      setOpen(false);
      return;
    }
    // Allow alphanumerics + dot + apostrophe + space (rare in name picker
    // but doesn't hurt). Cap query length.
    if (seg.length > 32) {
      setOpen(false);
      return;
    }
    setQuery(seg.toLowerCase());
    setHighlight(0);
    setOpen(true);
  }

  function pickProfile(profile) {
    const ta = taRef.current;
    if (!ta || !profile) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, caret);
    const after = ta.value.slice(caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return;
    const head = before.slice(0, at);
    const token = buildMentionToken(profile);
    const nextBody = head + token + ' ' + after;
    emit(nextBody);
    setOpen(false);
    setQuery('');
    // Restore caret after the inserted token + trailing space.
    requestAnimationFrame(() => {
      const ta2 = taRef.current;
      if (!ta2) return;
      const pos = (head + token + ' ').length;
      ta2.focus();
      ta2.setSelectionRange(pos, pos);
    });
  }

  const filtered = React.useMemo(() => {
    if (!query) return eligible.slice(0, 8);
    return eligible.filter((p) => (p.full_name || '').toLowerCase().includes(query)).slice(0, 8);
  }, [eligible, query]);

  function onKeyDown(e) {
    if (!open || filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickProfile(filtered[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={anchorRef} style={{position: 'relative'}} data-mention-textarea-wrap="1">
      <textarea
        ref={taRef}
        data-mention-textarea="1"
        value={value}
        placeholder={placeholder || 'Comment…'}
        disabled={disabled}
        onChange={(e) => {
          emit(e.target.value);
          requestAnimationFrame(updateMentionState);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Close after a tick so a popover click can fire first.
          setTimeout(() => setOpen(false), 100);
        }}
        onFocus={updateMentionState}
        onClick={updateMentionState}
        style={TEXTAREA_STYLE}
        rows={3}
      />
      {open && filtered.length > 0 && (
        <div data-mention-picker="1" style={POPOVER_STYLE}>
          {filtered.map((p, i) => (
            <button
              key={p.id}
              type="button"
              data-mention-picker-item={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pickProfile(p);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={i === highlight ? POPOVER_ITEM_ACTIVE : POPOVER_ITEM}
            >
              <span style={{fontWeight: 600}}>{p.full_name || '(unnamed)'}</span>
              {p.role && <span style={{fontSize: 11, color: '#6b7280', marginLeft: 6}}>{p.role}</span>}
            </button>
          ))}
        </div>
      )}
      {/* Hidden field exposing current mention uuids for tests + parent. */}
      <input type="hidden" data-mention-uuids={mentions.join(',')} data-mention-count={mentions.length} />
    </div>
  );
}
