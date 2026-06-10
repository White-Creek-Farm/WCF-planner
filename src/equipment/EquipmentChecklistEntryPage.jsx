// EquipmentChecklistEntryPage — standalone, read-only record page for a single
// equipment maintenance / service entry (/fleet/checklist/<id>). Mirrors
// EquipmentDetail's data path: the parent EquipmentHome loads the equipment +
// maintenance arrays once, and this page renders the one matching
// equipment_maintenance_events row read-only.
//
// Deletes stay on EquipmentDetail (via the audited delete RPCs) — this page has
// NO delete button. Comments + Activity mount via RecordCollaborationSection on
// the PARENT equipment.item entity (entityId = equipment id), reusing the same
// audit surface the detail page uses, so a comment left here shows on the piece.
//
// Fail-closed loading order per the Cold-Boot contract: loading -> loadError
// (user-gated Retry) -> not-found -> record.
import React from 'react';
import {EQUIPMENT_COLOR} from '../lib/equipment.js';
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

export default function EquipmentChecklistEntryPage({
  sb,
  fmt,
  equipment,
  event,
  authState,
  loading,
  loadError,
  onRetry,
  onBack,
}) {
  // ── Fail-closed loading order: loading -> loadError -> not-found -> record ──
  if (loading) {
    return <RecordPageLoading label="Loading service entry…" />;
  }
  if (loadError) {
    return (
      <RecordPageBody maxWidth={760} data-equipment-checklist-load-error="true">
        <RecordBackLink label="Back to Fleet" onBack={onBack} />
        <InlineNotice notice={loadError} />
        <button type="button" onClick={onRetry} style={{...recordSecondaryButton, marginTop: 10}}>
          Retry
        </button>
      </RecordPageBody>
    );
  }
  if (!equipment || !event) {
    return (
      <RecordPageNotFound
        backLabel="Back to Fleet"
        onBack={onBack}
        message="This service entry could not be found. It may have been deleted."
      />
    );
  }

  const eq = equipment;
  const photos = Array.isArray(event.photos) ? event.photos : [];

  return (
    <RecordPageBody
      maxWidth={760}
      data-equipment-checklist-record-loaded="true"
      style={{display: 'flex', flexDirection: 'column', gap: 16}}
    >
      <RecordBackLink label={'Back to ' + eq.name} onBack={onBack} />

      {/* Header tile */}
      <div
        style={{background: 'white', border: '2px solid ' + EQUIPMENT_COLOR, borderRadius: 12, padding: '14px 20px'}}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8}}>
          <RecordTitle fontSize={20} margin="0" style={{color: EQUIPMENT_COLOR}}>
            {event.title || 'Service'} — {fmt(event.event_date)}
          </RecordTitle>
          {event.event_type && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 8px',
                borderRadius: 4,
                background: '#eff6ff',
                color: '#1e40af',
                textTransform: 'uppercase',
              }}
            >
              {event.event_type}
            </span>
          )}
          <span style={{fontSize: 11, color: '#6b7280'}}>{eq.name}</span>
        </div>
        <div style={{borderTop: '1px solid #f3f4f6', paddingTop: 8}}>
          <FieldRow label="Date" value={fmt(event.event_date)} />
          {event.event_type && <FieldRow label="Service type" value={event.event_type} />}
          {event.title && <FieldRow label="Title" value={event.title} />}
          {event.cost != null && event.cost !== '' && (
            <FieldRow label="Cost" value={'$' + Number(event.cost).toLocaleString()} />
          )}
          {event.hours_at_event != null && event.hours_at_event !== '' && (
            <FieldRow label="Reading at event" value={Math.round(event.hours_at_event).toLocaleString() + ' h'} />
          )}
          <FieldRow label="Team member" value={event.team_member || '—'} />
        </div>
      </div>

      {/* Description / notes (read-only) */}
      {event.description && (
        <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 20px'}}>
          <div style={sectionTitle}>Notes</div>
          <div style={{fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap'}}>{event.description}</div>
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
                  alt={imageAltText(p.name, {fallback: 'Maintenance event photo', index: i, total: photos.length})}
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
