// Outcome-flock collapsible sections shown at the bottom of SheepFlocksView
// in tile mode. Mirrors cattle/CollapsibleOutcomeSections with sheep field
// names. Processed / Deceased / Sold each get their own panel.
import React from 'react';
import {openableProps} from '../shared/openable.js';

const SheepCollapsibleOutcomeSections = ({
  sheep,
  FLOCK_COLORS,
  FLOCK_LABELS,
  OUTCOMES,
  fmt,
  setStatusFilter,
  onSheepClick,
}) => {
  const [expanded, setExpanded] = React.useState({});
  return (
    <div style={{marginTop: 8}}>
      {OUTCOMES.map((f) => {
        const rows = sheep.filter((s) => s.flock === f);
        if (rows.length === 0) return null;
        const fc = FLOCK_COLORS[f];
        const isExpanded = expanded[f];
        return (
          <div
            key={f}
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              marginBottom: 8,
              overflow: 'hidden',
            }}
          >
            <div
              {...openableProps(() => setExpanded({...expanded, [f]: !isExpanded}))}
              className="hoverable-tile"
              style={{
                padding: '10px 16px',
                background: 'white',
                borderLeft: '3px solid ' + fc.tx,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{fontSize: 11, color: fc.tx}}>{isExpanded ? '▼' : '▶'}</span>
              <span style={{fontSize: 13, fontWeight: 700, color: fc.tx}}>{FLOCK_LABELS[f]}</span>
              <span style={{fontSize: 11, color: fc.tx, opacity: 0.7}}>{rows.length}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStatusFilter(f);
                }}
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: fc.tx,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                View all
              </button>
            </div>
            {isExpanded && (
              <div>
                {rows.slice(0, 50).map((s) => (
                  <div key={s.id} id={'sheep-' + s.id} style={{borderTop: '1px solid var(--divider)'}}>
                    <div
                      {...(onSheepClick ? openableProps(() => onSheepClick(s)) : {})}
                      style={{
                        padding: '8px 16px',
                        fontSize: 12,
                        color: 'var(--ink-muted)',
                        display: 'flex',
                        gap: 10,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        cursor: onSheepClick ? 'pointer' : 'default',
                      }}
                      className={onSheepClick ? 'hoverable-tile' : ''}
                    >
                      {onSheepClick && <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>{'▶'}</span>}
                      <span style={{fontWeight: 600, color: 'var(--ink)', minWidth: 60}}>
                        {s.tag ? '#' + s.tag : '(no tag)'}
                      </span>
                      <span>{s.sex || '—'}</span>
                      <span>{s.breed || '—'}</span>
                      {s.death_date && <span>{'died ' + fmt(s.death_date)}</span>}
                      {s.sale_date && <span>{'sold ' + fmt(s.sale_date)}</span>}
                    </div>
                  </div>
                ))}
                {rows.length > 50 && (
                  <div style={{padding: '8px 16px', fontSize: 11, color: 'var(--ink-faint)'}}>
                    {rows.length - 50} more — click "View all" above to filter to this section.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default SheepCollapsibleOutcomeSections;
