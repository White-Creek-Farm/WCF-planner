// Stuck-submission modal — surfaced by useOfflineSubmit on the next form
// open after one or more submissions have failed 3 times. Each row exposes:
//   - last error (truncated)
//   - first-attempt date
//   - Retry  (resets retry_count and fires sync immediately)
//   - Discard (removes the row outright)
//
// Phase 1B canary uses this for fuel_supply only; Phase 1C reuses across
// the 4 fan-out forms. Keep the rendering payload-shape-agnostic — the
// modal shows a one-line label per row plus the timestamp; form-specific
// detail comes from the queue entry's payload field if a future caller
// wants to render more.

import React from 'react';

function fmtTs(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export default function StuckSubmissionsModal({
  rows,
  onRetry,
  onDiscard,
  onClose,
  formLabel = 'submission',
  describeRow,
}) {
  if (!rows || rows.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-label="Stuck submissions"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.55)',
        zIndex: 9100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          padding: '20px 22px',
          maxWidth: 520,
          width: '100%',
          boxShadow: '0 8px 32px rgba(0,0,0,.25)',
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        <div style={{fontSize: 20, marginBottom: 6}}>⚠️</div>
        <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 4}}>
          {rows.length} stuck {formLabel}
          {rows.length === 1 ? '' : 's'}
        </div>
        <div style={{fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14, lineHeight: 1.5}}>
          These submissions failed 3 sync attempts and are sitting on this device. Retry to send them now, or discard if
          you've already entered the data another way.
        </div>

        <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          {rows.map((row) => {
            const summary = describeRow ? describeRow(row) : `${row.form_kind} · ${row.csid.slice(0, 12)}`;
            return (
              <div
                key={row.csid}
                data-stuck-csid={row.csid}
                style={{
                  border: '1px solid #fde68a',
                  background: '#fffbeb',
                  borderRadius: 10,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: '#78716c',
                }}
              >
                <div style={{fontWeight: 600, color: 'var(--ink)', marginBottom: 2}}>{summary}</div>
                <div style={{marginBottom: 4}}>
                  Last error: <span style={{color: '#b91c1c'}}>{truncate(row.last_error || 'unknown', 80)}</span>
                </div>
                <div style={{marginBottom: 8, fontSize: 11, color: 'var(--ink-faint)'}}>
                  Queued {fmtTs(row.created_at)} · Last try {fmtTs(row.last_attempt_at)} · {row.retry_count} attempts
                </div>
                <div style={{display: 'flex', gap: 8}}>
                  <button
                    onClick={() => onRetry(row.csid)}
                    data-stuck-action="retry"
                    style={{
                      padding: '6px 14px',
                      borderRadius: 10,
                      border: 'none',
                      background: '#085041',
                      color: 'white',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Retry
                  </button>
                  <button
                    onClick={() => onDiscard(row.csid)}
                    data-stuck-action="discard"
                    style={{
                      padding: '6px 14px',
                      borderRadius: 10,
                      border: '1px solid var(--border-strong)',
                      background: 'white',
                      color: '#b91c1c',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 16}}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
