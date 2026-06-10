// EquipmentFuelingEntryPage — standalone, read-only record page for a single
// equipment fueling entry (/fleet/fueling/<id>). Mirrors EquipmentDetail's data
// path: the parent EquipmentHome loads the equipment + fuelings arrays once,
// and this page renders the one matching equipment_fuelings row read-only.
//
// Deletes stay on EquipmentDetail (via the audited delete RPCs) — this page has
// NO delete button. Comments + Activity mount via RecordCollaborationSection on
// the PARENT equipment.item entity (entityId = equipment id), reusing the same
// audit surface the detail page uses, so a comment left here shows on the piece.
//
// Fail-closed loading order per the Cold-Boot contract: loading -> loadError
// (user-gated Retry) -> not-found -> record.
import React from 'react';
import {EQUIPMENT_COLOR, fmtReading, stripPodioHtml} from '../lib/equipment.js';
import {imageAltText} from '../lib/imageAlt.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordCollaborationSection from '../shared/RecordCollaborationSection.jsx';
/* eslint-disable no-unused-vars -- shell primitives are used in JSX only */
import {
  RecordPageLoading,
  RecordPageNotFound,
  RecordPageBody,
  RecordBackLink,
  RecordTitle,
} from '../shared/RecordPageShell.jsx';
/* eslint-enable no-unused-vars */
import {recordSecondaryButton} from '../shared/recordPageControls.jsx';

const sectionTitle = {
  fontSize: 11,
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};

function FieldRow({label, value}) {
  return (
    <div style={{display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', fontSize: 13}}>
      <span style={{color: '#6b7280'}}>{label}</span>
      <span style={{color: '#111827', fontWeight: 600, textAlign: 'right'}}>{value}</span>
    </div>
  );
}

export default function EquipmentFuelingEntryPage({
  sb,
  fmt,
  equipment,
  fueling,
  authState,
  loading,
  loadError,
  onRetry,
  onBack,
}) {
  // ── Fail-closed loading order: loading -> loadError -> not-found -> record ──
  if (loading) {
    return <RecordPageLoading label="Loading fueling entry…" />;
  }
  if (loadError) {
    return (
      <RecordPageBody maxWidth={760} data-equipment-fueling-load-error="true">
        <RecordBackLink label="Back to Fleet" onBack={onBack} />
        <InlineNotice notice={loadError} />
        <button type="button" onClick={onRetry} style={{...recordSecondaryButton, marginTop: 10}}>
          Retry
        </button>
      </RecordPageBody>
    );
  }
  if (!equipment || !fueling) {
    return (
      <RecordPageNotFound
        backLabel="Back to Fleet"
        onBack={onBack}
        message="This fueling entry could not be found. It may have been deleted."
      />
    );
  }

  const eq = equipment;
  const unit = eq.tracking_unit === 'km' ? 'km' : 'hours';
  const readingLabel = unit === 'km' ? 'KM' : 'Hours';
  const reading = unit === 'km' ? fueling.km_reading : fueling.hours_reading;
  const noteText = stripPodioHtml(fueling.comments);

  // Every-fuel-fill-up checklist ticks recorded on this entry.
  const fillupChecks = Array.isArray(fueling.every_fillup_check) ? fueling.every_fillup_check : [];
  // Service / attachment-checklist interval completions recorded on this entry.
  const completed = Array.isArray(fueling.service_intervals_completed) ? fueling.service_intervals_completed : [];
  const photos = Array.isArray(fueling.photos) ? fueling.photos : [];

  return (
    <RecordPageBody
      maxWidth={760}
      data-equipment-fueling-record-loaded="true"
      style={{display: 'flex', flexDirection: 'column', gap: 16}}
    >
      <RecordBackLink label={'Back to ' + eq.name} onBack={onBack} />

      {/* Header tile */}
      <div
        style={{background: 'white', border: '2px solid ' + EQUIPMENT_COLOR, borderRadius: 12, padding: '14px 20px'}}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8}}>
          <RecordTitle fontSize={20} margin="0" style={{color: EQUIPMENT_COLOR}}>
            Fueling — {fmt(fueling.date)}
          </RecordTitle>
          <span style={{fontSize: 11, color: '#6b7280'}}>
            {eq.name}
            {eq.fuel_type ? ' · ' + eq.fuel_type : ''}
          </span>
        </div>
        <div style={{borderTop: '1px solid #f3f4f6', paddingTop: 8}}>
          <FieldRow label="Date" value={fmt(fueling.date)} />
          <FieldRow
            label={(eq.fuel_type || 'Fuel') + ' gallons'}
            value={fueling.gallons != null ? Math.round(fueling.gallons * 10) / 10 : '—'}
          />
          {eq.takes_def && (
            <FieldRow
              label="DEF gallons"
              value={fueling.def_gallons != null ? Math.round(fueling.def_gallons * 10) / 10 : '—'}
            />
          )}
          <FieldRow label={readingLabel + ' reading'} value={reading != null ? fmtReading(reading, unit) : '—'} />
          <FieldRow label="Team member" value={fueling.team_member || '—'} />
        </div>
      </div>

      {/* Notes */}
      {noteText && (
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={sectionTitle}>Notes</div>
          <div style={{fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap'}}>{noteText}</div>
        </div>
      )}

      {/* Every fuel fill up checklist (read-only) */}
      <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
        <div style={sectionTitle}>Every Fuel Fill Up Checklist</div>
        {fillupChecks.length === 0 && (
          <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No fillup items ticked on this entry.</div>
        )}
        {fillupChecks.length > 0 && (
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
            {fillupChecks.map((c, i) => (
              <span
                key={c.id || i}
                style={{
                  fontSize: 10,
                  padding: '3px 8px',
                  borderRadius: 4,
                  background: '#d1fae5',
                  color: '#065f46',
                  border: '1px solid #a7f3d0',
                }}
              >
                ✓ {c.label || c.id}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Service / checklist interval completions (read-only) */}
      {completed.length > 0 && (
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={sectionTitle}>Service / Checklist Completed ({completed.length})</div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            {completed.map((c, i) => {
              const total = c.total_tasks || 0;
              const done = Array.isArray(c.items_completed) ? c.items_completed.length : 0;
              const isFull = total === 0 ? true : done >= total;
              const unitChar = c.kind === 'km' ? 'k' : 'h';
              return (
                <div
                  key={i}
                  style={{
                    padding: '8px 10px',
                    background: '#fafafa',
                    border: '1px solid ' + (isFull ? '#bfdbfe' : '#fde68a'),
                    borderRadius: 6,
                    fontSize: 12,
                    color: isFull ? '#1e40af' : '#92400e',
                    fontWeight: 600,
                  }}
                >
                  {c.attachment_name ? c.attachment_name + ' — ' : ''}
                  {c.label || c.interval + unitChar}
                  <span style={{fontSize: 10, fontWeight: 500, marginLeft: 8, color: '#6b7280'}}>
                    {done}/{total} tasks {isFull ? '· full' : done > 0 ? '· partial' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Photos (read-only) */}
      {photos.length > 0 && (
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={sectionTitle}>Photos ({photos.length})</div>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
            {photos.map((p, i) => (
              <a key={i} href={p.url} target="_blank" rel="noreferrer" title={p.name || ''} style={{display: 'block'}}>
                <img
                  src={p.url}
                  alt={imageAltText(p.name, {fallback: 'Fueling photo', index: i, total: photos.length})}
                  style={{width: 90, height: 90, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb'}}
                />
              </a>
            ))}
          </div>
        </div>
      )}

      <RecordCollaborationSection
        sb={sb}
        authState={authState}
        entityType="equipment.item"
        entityId={eq.id}
        entityLabel={eq.name}
        spacing={0}
      />
    </RecordPageBody>
  );
}
