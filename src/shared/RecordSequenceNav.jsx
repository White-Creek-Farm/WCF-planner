import React from 'react';
import {findSequenceNeighbors} from '../lib/recordSequence.js';

// Fixed Previous/Next record navigation. Renders nothing unless the current
// record sits inside a valid sequence handed through route state (see
// src/lib/recordSequence.js). The controls are FIXED to the LEFT and RIGHT
// screen edges (vertically centered), exactly like the original broiler-batch
// side navigation Ronnie wanted — Prev on the left, Next on the right — so they
// stay reachable while scrolling and are never visually buried.
//
// Visual: compact, sleek flat pills (light gray border, white, soft shadow).
// An enabled button shows its neighbor's actual title (CSS-truncated; full title
// in the tooltip); a disabled boundary button is an icon-only chevron. The
// "<i> of <n>" indicator is a small pill pinned bottom-center.
//
// Props: seq, currentId, onNavigate, formatLabel
// Hooks (locked by the *_sequence_nav.spec.js suites):
//   data-record-seq-nav / -prev / -next / -position / -fixed

function defaultFormatLabel(item) {
  if (!item) return '';
  if (item.label) return item.label;
  return item.tag ? '#' + item.tag : 'Untagged';
}

// Sit just outside a centered content column on wide screens (like the broiler
// side nav), and clamp to 12px from the edge on narrow screens.
const LEFT_EDGE = 'max(12px, calc(50% - 580px))';
const RIGHT_EDGE = 'max(12px, calc(50% - 580px))';

const SIDE = {
  position: 'fixed',
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 600,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  maxWidth: 200,
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(0,0,0,.14), 0 1px 2px rgba(0,0,0,.06)',
};
const SIDE_DISABLED = {
  ...SIDE,
  color: '#9ca3af',
  background: '#f9fafb',
  cursor: 'default',
  boxShadow: '0 1px 2px rgba(0,0,0,.05)',
};
const CHEVRON = {fontSize: 16, lineHeight: 1};
// CSS-only truncation so the button's DOM text stays the full neighbor name.
const LABEL = {maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'};
const POSITION_PILL = {
  pointerEvents: 'auto',
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 11,
  fontWeight: 600,
  color: '#6b7280',
  boxShadow: '0 1px 3px rgba(0,0,0,.1)',
};

export default function RecordSequenceNav({seq, currentId, onNavigate, formatLabel = defaultFormatLabel}) {
  const {index, total, prev, next} = findSequenceNeighbors(seq, currentId);
  // No reliable sequence → render nothing (direct link, notification, related
  // click-through, or single-record list).
  if (index === -1) return null;

  // Container is a full-width bottom strip (pointer-events:none so it never
  // blocks content) whose only in-flow child is the position pill — that gives
  // data-record-seq-nav a real, visible box. The prev/next buttons are
  // position:fixed (the container has no transform, so they resolve against the
  // viewport) and pinned to the left/right edges.
  return (
    <div
      data-record-seq-nav="1"
      data-record-seq-fixed="1"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 14,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 600,
      }}
    >
      <button
        type="button"
        data-record-seq-prev="1"
        disabled={!prev}
        onClick={() => prev && onNavigate(prev.id)}
        title={prev ? 'Previous: ' + formatLabel(prev) : 'No previous record'}
        style={{...(prev ? SIDE : SIDE_DISABLED), left: LEFT_EDGE, pointerEvents: 'auto'}}
      >
        <span aria-hidden="true" style={CHEVRON}>
          ‹
        </span>
        {prev && <span style={LABEL}>{formatLabel(prev)}</span>}
      </button>

      <span data-record-seq-position="1" style={POSITION_PILL}>
        {index + 1} of {total}
      </span>

      <button
        type="button"
        data-record-seq-next="1"
        disabled={!next}
        onClick={() => next && onNavigate(next.id)}
        title={next ? 'Next: ' + formatLabel(next) : 'No next record'}
        style={{...(next ? SIDE : SIDE_DISABLED), right: RIGHT_EDGE, pointerEvents: 'auto'}}
      >
        {next && <span style={LABEL}>{formatLabel(next)}</span>}
        <span aria-hidden="true" style={CHEVRON}>
          ›
        </span>
      </button>
    </div>
  );
}
