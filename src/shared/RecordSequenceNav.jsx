import React from 'react';
import {findSequenceNeighbors} from '../lib/recordSequence.js';

// Compact Previous/Next record navigation. Renders nothing unless the current
// record sits inside a valid sequence handed through route state (see
// src/lib/recordSequence.js). Belongs near the record-page title/back area —
// it is NOT part of Comments or Activity.
//
// Props:
//   seq         — ordered [{id, tag}] from the originating list (route state)
//   currentId   — the id of the record on screen
//   onNavigate  — (id) => void; should carry the sequence forward
//   formatLabel — optional (item) => string for the neighbor label

function defaultFormatLabel(item) {
  if (!item) return '';
  return item.tag ? '#' + item.tag : 'Untagged';
}

const BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'white',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  padding: '5px 10px',
  fontSize: 13,
  fontWeight: 600,
  color: '#374151',
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const BTN_DISABLED = {...BTN, color: '#9ca3af', cursor: 'default', background: '#f9fafb'};

export default function RecordSequenceNav({seq, currentId, onNavigate, formatLabel = defaultFormatLabel}) {
  const {index, total, prev, next} = findSequenceNeighbors(seq, currentId);
  // No reliable sequence → render nothing (direct link, notification, related
  // click-through, or single-record list).
  if (index === -1) return null;

  return (
    <div
      data-record-seq-nav="1"
      style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap'}}
    >
      <button
        type="button"
        data-record-seq-prev="1"
        disabled={!prev}
        onClick={() => prev && onNavigate(prev.id)}
        title={prev ? 'Previous: ' + formatLabel(prev) : 'No previous record'}
        style={prev ? BTN : BTN_DISABLED}
      >
        <span aria-hidden="true">‹</span>
        {prev ? formatLabel(prev) : 'Previous'}
      </button>
      <span data-record-seq-position="1" style={{fontSize: 12, color: '#6b7280'}}>
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
        {next ? formatLabel(next) : 'Next'}
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
