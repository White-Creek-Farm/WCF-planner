// Shared photo-capture component for daily-report submissions.
//
// Used by every public daily webform (cattle / sheep / pig / poultry / layer)
// + the admin Add-Report modal. Lets the operator pick or capture up to
// MAX_PHOTOS_PER_REPORT (10) photos for one submission, with per-file status
// chips so they can see uploads in flight.
//
// This component owns local file state ONLY. It does NOT perform uploads —
// the parent webform calls uploadDailyPhotosSequential AFTER required-field
// validation passes. Per locked decisions:
//   1. Validate required fields BEFORE uploading (parent's job).
//   2. Abort the whole submission if any selected photo fails to upload.
//   3. Egg dailys excluded.
//   4. Add Feed deferred until parent-submission/RPC design.
//
// The parent calls back via onChange(files) every time the selection
// changes. status-chip rendering is parent-driven through the optional
// `statuses` prop — parent updates statuses as uploads run.

import React from 'react';

import {MAX_PHOTOS_PER_REPORT} from '../lib/dailyPhotos.js';

// Status values rendered as chips on each selected file.
//   'pending'    — selected but not yet attempted
//   'uploading'  — in flight
//   'uploaded'   — succeeded (parent has the metadata stashed)
//   'failed'     — last attempt errored (parent is about to abort)
//   'queued'     — Phase 1D-A: offline-capable callers; saved on device,
//                   will sync when connection returns
const CHIP_STYLES = {
  pending: {bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', label: 'Ready'},
  uploading: {bg: '#fef3c7', fg: '#92400e', border: '#fde68a', label: 'Uploading…'},
  uploaded: {bg: '#ecfdf5', fg: '#065f46', border: '#a7f3d0', label: '✓ Uploaded'},
  failed: {bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca', label: 'Failed'},
  queued: {bg: '#fef3c7', fg: '#92400e', border: '#fde68a', label: '📡 Saved on device'},
};

// Phase 1D-A — offlineCapable=true callers (PigDailysWebform) drop the
// online-only warning copy and gain the 'queued' chip option. WebformHub
// callers default to offlineCapable=false, preserving today's online-only
// online-warning copy until 1D-B migrates them.
export default function DailyPhotoCapture({files, statuses = [], onChange, disabled = false, offlineCapable = false}) {
  const inputRef = React.useRef(null);
  const onlineNow = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

  function pick(e) {
    const incoming = Array.from(e.target.files || []);
    if (!incoming.length) return;
    const room = MAX_PHOTOS_PER_REPORT - files.length;
    const accepted = incoming.slice(0, Math.max(0, room));
    if (accepted.length > 0) onChange([...files, ...accepted]);
    // Reset the input so re-picking the same filename fires onChange again.
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeAt(idx) {
    onChange(files.filter((_, i) => i !== idx));
  }

  const remaining = MAX_PHOTOS_PER_REPORT - files.length;
  const atCap = remaining <= 0;

  return (
    <div data-daily-photo-capture="1" style={{marginTop: 4}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap'}}>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || atCap}
          data-add-photos="1"
          style={{
            padding: '6px 12px',
            borderRadius: 10,
            border: '1px solid var(--border-strong)',
            background: disabled || atCap ? '#f3f4f6' : 'white',
            color: disabled || atCap ? 'var(--ink-faint)' : 'var(--ink)',
            fontSize: 12,
            fontWeight: 600,
            cursor: disabled || atCap ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          📷 Add photos
        </button>
        <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
          {files.length} of {MAX_PHOTOS_PER_REPORT} {files.length === 1 ? 'photo' : 'photos'}
          {atCap && ' (max reached)'}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={pick}
          disabled={disabled || atCap}
          data-photo-input="1"
          style={{display: 'none'}}
        />
      </div>

      {!onlineNow && files.length > 0 && !offlineCapable && (
        <div
          data-photo-online-warning="1"
          style={{
            background: '#fef3c7',
            border: '1px solid #fde68a',
            borderRadius: 10,
            padding: '6px 10px',
            fontSize: 11,
            color: '#92400e',
            marginBottom: 8,
          }}
        >
          ⚠ This device looks offline. Photo upload needs a connection — submit when you're back online.
        </div>
      )}
      {offlineCapable && files.length > 0 && (
        <div
          data-photo-offline-info="1"
          style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 10,
            padding: '6px 10px',
            fontSize: 11,
            color: '#1e40af',
            marginBottom: 8,
          }}
        >
          {onlineNow
            ? '📷 Photos will upload as part of this submission.'
            : '📡 No connection right now — photos save on this device and sync when you reconnect.'}
        </div>
      )}

      {files.length > 0 && (
        <div style={{display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4}}>
          {files.map((f, i) => {
            const status = statuses[i] || 'pending';
            const sty = CHIP_STYLES[status] || CHIP_STYLES.pending;
            return (
              <div
                key={i}
                data-photo-row={i}
                data-photo-status={status}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: sty.bg,
                  border: '1px solid ' + sty.border,
                  color: sty.fg,
                  borderRadius: 10,
                  padding: '4px 8px',
                  fontSize: 11,
                  maxWidth: 240,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'inherit',
                  }}
                  title={f.name || `photo-${i + 1}`}
                >
                  {f.name || `photo-${i + 1}`}
                </span>
                <span style={{fontWeight: 600, opacity: 0.85}}>{sty.label}</span>
                {status !== 'uploading' && status !== 'uploaded' && (
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    disabled={disabled}
                    title="Remove"
                    data-photo-remove={i}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      fontSize: 13,
                      lineHeight: 1,
                      padding: 0,
                      opacity: 0.7,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
