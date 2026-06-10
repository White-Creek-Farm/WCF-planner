// MentionTextarea — plain <textarea> with an @-triggered profile picker.
//
// User-visible format (per Codex polish review):
//   The textarea contains ONLY plain "@DisplayName" text — uuids are
//   never shown. The structured mention identity travels in the parent's
//   `mentions` state array (deduped uuids).
//
// Why this matters: mig 058's original wire format was
//   @[Display Name](profile:<uuid>)
// which leaked uuids into the visible composer and the rendered
// timeline. Mig 060 dropped the body-must-contain-uuid validation; the
// server now trusts p_mentions[] outright. So the textarea inserts a
// plain "@DisplayName " on pick and tracks the picked uuid alongside.
//
// Props:
//   sb         supabase client (used to load eligible profiles via
//              tasksCenterApi's loadTaskAssignableProfilesById — single
//              source of truth for "who is mentionable")
//   value      current body text (string)
//   mentions   current mention uuids ([uuid]) — authoritative; parent owns
//   onChange   ({body, mentions}) called on every keystroke / pick
//   placeholder
//   disabled
//
// Behavior:
//   - Typing updates body. mentions[] is NOT re-derived from body — it is
//     only mutated on explicit picks.
//   - Picking from popover REPLACES the partial "@query" with the picked
//     "@FullName ", appends the uuid to mentions[] if not already present.
//   - Deleting "@FullName" text after picking does NOT remove the uuid
//     from mentions[]. Per Codex: explicit pick = authoritative intent.
//     The renderer simply won't chip what isn't in the body anymore.
import React from 'react';
import {loadTaskAssignableProfilesById} from '../lib/tasksCenterApi.js';

const TEXTAREA_STYLE = {
  width: '100%',
  minHeight: 64,
  padding: '8px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
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
  borderRadius: 6,
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

export default function MentionTextarea({
  sb,
  value = '',
  mentions = [],
  onChange,
  placeholder,
  disabled,
  loadProfiles,
}) {
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
    const loader = loadProfiles || ((s) => loadTaskAssignableProfilesById(s).then((map) => Object.values(map || {})));
    loader(sb)
      .then((list) => {
        if (cancelled) return;
        const sorted = Array.isArray(list) ? list : Object.values(list || {});
        sorted.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        setEligible(sorted);
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

  function emit(nextBody, nextMentions) {
    if (onChange) onChange({body: nextBody, mentions: nextMentions});
  }

  // After every change, scan back from the caret for an @<query> token
  // (only if no whitespace/punctuation breaks it). If found, open the
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
    // Allow letters / digits / apostrophe / spaces inside the query so
    // users can type "@Test Adm" before picking — sortedNames in the
    // popover match against the lowercased full_name with includes().
    // Anything else (newline, punctuation) closes the popover.
    if (/[\n\t\r.,!?;:)\](){}<>/\\]/.test(seg)) {
      setOpen(false);
      return;
    }
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
    const display = profile.full_name || profile.name || 'Unknown';
    // Plain "@DisplayName " — uuid stays out of the visible body.
    // Trailing space puts the caret past the chip so users can keep typing.
    const inserted = '@' + display + ' ';
    const nextBody = head + inserted + after;
    const nextMentions = mentions.includes(profile.id) ? mentions : [...mentions, profile.id];
    emit(nextBody, nextMentions);
    setOpen(false);
    setQuery('');
    requestAnimationFrame(() => {
      const ta2 = taRef.current;
      if (!ta2) return;
      const pos = (head + inserted).length;
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
          // Body changes do not mutate mentions[]; the picker owns that.
          emit(e.target.value, mentions);
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
