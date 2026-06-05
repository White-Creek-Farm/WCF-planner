import React from 'react';
import {findSequenceNeighbors} from '../lib/recordSequence.js';

// Fixed Previous/Next record navigation. Renders nothing unless the current
// record sits inside a valid sequence handed through route state (see
// src/lib/recordSequence.js). The control is FIXED so users can move
// record-to-record without scrolling — the single source of truth for prev/next
// on every operational record page.
//
// Visual: the compact, flat pill cluster Ronnie approved — "‹ <prev>  <i> of
// <n>  <next> ›" — light gray border, white pills, plain muted position text.
// It is rendered as one fixed bottom-center cluster (not split to the screen
// edges) so it reads exactly like the inline top control while staying pinned.
// An enabled button shows its neighbor's actual title (CSS-truncated; full
// title in the tooltip); a disabled boundary button shows a muted generic
// chevron + label.
//
// Props: seq, currentId, onNavigate, formatLabel
// Hooks (locked by the *_sequence_nav.spec.js suites):
//   data-record-seq-nav / -prev / -next / -position / -fixed

function defaultFormatLabel(item) {
  if (!item) return '';
  if (item.label) return item.label;
  return item.tag ? '#' + item.tag : 'Untagged';
}

const BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  maxWidth: 180,
  background: 'white',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  padding: '5px 10px',
  fontSize: 13,
  fontWeight: 600,
  color: '#374151',
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: '0 1px 2px rgba(0,0,0,.08)',
};
const BTN_DISABLED = {...BTN, color: '#9ca3af', background: '#f9fafb', cursor: 'default', boxShadow: 'none'};
const CHEVRON = {fontSize: 15, lineHeight: 1};
const LABEL = {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'};
const POSITION = {fontSize: 12, color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap'};

export default function RecordSequenceNav({seq, currentId, onNavigate, formatLabel = defaultFormatLabel}) {
  const {index, total, prev, next} = findSequenceNeighbors(seq, currentId);
  // No reliable sequence → render nothing (direct link, notification, related
  // click-through, or single-record list).
  if (index === -1) return null;

  return (
    <div
      data-record-seq-nav="1"
      data-record-seq-fixed="1"
      style={{
        position: 'fixed',
        bottom: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'calc(100vw - 24px)',
        padding: '6px 8px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.92)',
        boxShadow: '0 2px 10px rgba(0,0,0,.12)',
        backdropFilter: 'saturate(150%) blur(2px)',
      }}
    >
      <button
        type="button"
        data-record-seq-prev="1"
        disabled={!prev}
        onClick={() => prev && onNavigate(prev.id)}
        title={prev ? 'Previous: ' + formatLabel(prev) : 'No previous record'}
        style={prev ? BTN : BTN_DISABLED}
      >
        <span aria-hidden="true" style={CHEVRON}>
          ‹
        </span>
        <span style={LABEL}>{prev ? formatLabel(prev) : 'Prev'}</span>
      </button>

      <span data-record-seq-position="1" style={POSITION}>
        {index + 1} of {total}
      </span>

      <button
        type="button"
        data-record-seq-next="1"
        disabled={!next}
        onClick={() => next && onNavigate(next.id)}
        title={next ? 'Next: ' + formatLabel(next) : 'No next record'}
        style={next ? BTN : BTN_DISABLED}
      >
        <span style={LABEL}>{next ? formatLabel(next) : 'Next'}</span>
        <span aria-hidden="true" style={CHEVRON}>
          ›
        </span>
      </button>
    </div>
  );
}
