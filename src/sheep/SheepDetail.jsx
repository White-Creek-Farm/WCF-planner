// Sheep detail pane — inline-editable expanded tile, mirrors CowDetail.jsx
// byte-for-byte functionality; only field names (sheep / flock / lambing /
// dam_reg_num / sire_reg_num / ewe-ram-wether) differ. Ronnie's request
// 2026-04-23: sheep flocks tab should match cattle herds tab exactly,
// with only the fields and data distinct.
import React from 'react';
import {
  recordFieldRowClass,
  recordFieldLabel,
  recordControl,
  recordTextarea,
  recordCheckbox,
} from '../shared/recordPageControls.jsx';

const SheepDetail = ({
  sheep,
  weighIns,
  lambing,
  comments,
  lambs,
  dam,
  sheepList,
  fmt,
  FLOCKS,
  FLOCK_LABELS,
  FLOCK_COLORS,
  onEdit,
  onTransfer,
  onDelete,
  onComment,
  onEditComment,
  onDeleteComment,
  onAddLambing,
  onDeleteLambing,
  onNavigateToSheep,
  onNavigateBack,
  canNavigateBack,
  backToTag,
  onPatch,
  onClose,
  originOpts,
  breedOpts,
  ageLabel,
  hideComments,
}) => {
  const patchOnBlur = (field, parser) => (ev) => {
    if (!onPatch) return;
    const raw = ev.target.value;
    const cur = sheep[field];
    let next;
    if (parser === 'number') {
      next = raw === '' ? null : parseFloat(raw);
      if (Number.isNaN(next)) next = null;
    } else {
      next = (raw || '').trim() || null;
    }
    const curNorm = cur === '' ? null : cur;
    if (String(next) === String(curNorm)) return;
    onPatch({[field]: next});
  };
  const patchOnChange = (field) => (ev) => {
    if (!onPatch) return;
    const v = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value || null;
    onPatch({[field]: v});
  };
  function patchOldTagAt(idx, field, value) {
    if (!onPatch) return;
    const next = (Array.isArray(sheep.old_tags) ? sheep.old_tags : []).slice();
    next[idx] = {...next[idx], [field]: value};
    onPatch({old_tags: next});
  }
  function addOldTag() {
    if (!onPatch) return;
    const next = [
      ...(Array.isArray(sheep.old_tags) ? sheep.old_tags : []),
      {tag: '', changed_at: '', source: 'manual'},
    ];
    onPatch({old_tags: next});
  }
  function removeOldTag(idx) {
    if (!onPatch) return;
    const next = (Array.isArray(sheep.old_tags) ? sheep.old_tags : []).filter((_, i) => i !== idx);
    onPatch({old_tags: next});
  }
  const editInp = {
    fontSize: 12,
    padding: '5px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 5,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    width: '100%',
    background: 'white',
  };
  const [commentText, setCommentText] = React.useState('');
  const [showTransfer, setShowTransfer] = React.useState(false);
  const [showLambForm, setShowLambForm] = React.useState(false);
  const [editingCommentId, setEditingCommentId] = React.useState(null);
  const [editingCommentText, setEditingCommentText] = React.useState('');
  const [lambForm, setLambForm] = React.useState({
    lambing_date: new Date().toISOString().slice(0, 10),
    total_born: '',
    deaths: '',
    complications_flag: false,
    complications_desc: '',
    notes: '',
  });
  const [weightView, setWeightView] = React.useState('table');
  const [chartHover, setChartHover] = React.useState(null);
  const sectionTitle = {
    fontSize: 11,
    fontWeight: 700,
    color: '#4b5563',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  };
  // Ewes only — lambing history is sex-scoped so a retired ewe (now in
  // 'processed'/'sold'/'deceased' flock) still shows her lambing records.
  // Wethers / rams / lambs never see this section.
  const isEwe = sheep.sex === 'ewe';
  async function submitLambing() {
    const ok = await onAddLambing(lambForm);
    if (ok) {
      setShowLambForm(false);
      setLambForm({
        lambing_date: new Date().toISOString().slice(0, 10),
        total_born: '',
        deaths: '',
        complications_flag: false,
        complications_desc: '',
        notes: '',
      });
    }
  }

  const findByTag = (t) => (t && Array.isArray(sheepList) ? sheepList.find((x) => x.tag === t) : null);
  const accentColor = (FLOCK_COLORS && FLOCK_COLORS[sheep.flock] && FLOCK_COLORS[sheep.flock].tx) || '#0f766e';
  const linkStyle = {
    color: '#1d4ed8',
    cursor: 'pointer',
    textDecoration: 'underline',
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
  };
  const TagLink = ({tag, prefix, label}) => {
    const t = findByTag(tag);
    if (!t || !onNavigateToSheep) return <span>{(prefix || '') + (label || '#' + tag)}</span>;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateToSheep(t);
        }}
        style={linkStyle}
      >
        {(prefix || '') + (label || '#' + tag)}
      </button>
    );
  };

  return (
    <div
      style={{
        background: '#ffffff',
        padding: '14px 18px',
        border: '2px solid ' + accentColor,
        borderRadius: 6,
        boxShadow: '0 2px 6px rgba(0,0,0,.06)',
        margin: '8px 12px 14px',
      }}
    >
      {canNavigateBack && onNavigateBack && (
        <div
          style={{
            marginBottom: 10,
            padding: '6px 10px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigateBack();
            }}
            style={{...linkStyle, fontWeight: 600}}
          >
            {'← Back' + (backToTag ? ' to #' + backToTag : '')}
          </button>
          <span style={{fontSize: 11, color: '#6b7280'}}>{'— you navigated here from another sheep'}</span>
        </div>
      )}
      {/* Header: editable tag + labeled flock/sex/breed selects + close X */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: '1px solid #f3f4f6',
          flexWrap: 'wrap',
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 4}}>
          <span style={{fontSize: 16, fontWeight: 700, color: accentColor}}>{'#'}</span>
          <input
            type="text"
            defaultValue={sheep.tag || ''}
            onBlur={patchOnBlur('tag', 'text')}
            placeholder="tag"
            style={{...editInp, width: 90, fontWeight: 700, fontSize: 14, color: accentColor}}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: '#6b7280',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Flock
          </div>
          <select defaultValue={sheep.flock || ''} onChange={patchOnChange('flock')} style={{...editInp, width: 140}}>
            {(FLOCKS || []).map((f) => (
              <option key={f} value={f}>
                {FLOCK_LABELS[f] || f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: '#6b7280',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Sex
          </div>
          <select defaultValue={sheep.sex || ''} onChange={patchOnChange('sex')} style={{...editInp, width: 110}}>
            <option value="">{'— sex —'}</option>
            <option value="ewe">Ewe</option>
            <option value="ram">Ram</option>
            <option value="wether">Wether</option>
            <option value="lamb">Lamb</option>
          </select>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: '#6b7280',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Breed
          </div>
          <select defaultValue={sheep.breed || ''} onChange={patchOnChange('breed')} style={{...editInp, width: 210}}>
            <option value="">{'— breed —'}</option>
            {(breedOpts || []).map((b) => (
              <option key={b.id} value={b.label}>
                {b.label}
              </option>
            ))}
            {sheep.breed && !(breedOpts || []).some((b) => b.label === sheep.breed) && (
              <option value={sheep.breed}>{sheep.breed + ' (historical)'}</option>
            )}
          </select>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '2px 10px',
              fontFamily: 'inherit',
            }}
          >
            {'×'}
          </button>
        )}
      </div>

      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16}}>
        {/* Identity (editable) */}
        <div>
          <div style={sectionTitle}>Identity</div>
          <div
            style={{
              fontSize: 12,
              color: '#374151',
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '4px 8px',
              alignItems: 'center',
            }}
          >
            <span style={{color: '#9ca3af'}}>Origin:</span>
            <select defaultValue={sheep.origin || ''} onChange={patchOnChange('origin')} style={editInp}>
              <option value="">{'— select —'}</option>
              {(originOpts || []).map((o) => (
                <option key={o.id} value={o.label}>
                  {o.label}
                </option>
              ))}
              {sheep.origin && !(originOpts || []).some((o) => o.label === sheep.origin) && (
                <option value={sheep.origin}>{sheep.origin}</option>
              )}
            </select>
            <span style={{color: '#9ca3af'}}>Birth:</span>
            <input
              type="date"
              defaultValue={sheep.birth_date || ''}
              onBlur={patchOnBlur('birth_date', 'text')}
              style={editInp}
            />
            <span style={{color: '#9ca3af'}}>Age:</span>
            <span
              style={{
                fontSize: 12,
                padding: '5px 8px',
                color: '#6b7280',
                fontFamily: 'inherit',
              }}
            >
              {ageLabel || '—'}
            </span>
            <span style={{color: '#9ca3af'}}>Purchased:</span>
            <input
              type="date"
              defaultValue={sheep.purchase_date || ''}
              onBlur={patchOnBlur('purchase_date', 'text')}
              style={editInp}
            />
            <span style={{color: '#9ca3af'}}>Purchase $:</span>
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={sheep.purchase_amount == null ? '' : sheep.purchase_amount}
              onBlur={patchOnBlur('purchase_amount', 'number')}
              style={editInp}
            />
            {sheep.sex === 'ewe' && (
              <>
                <span style={{color: '#9ca3af'}}>Breeding:</span>
                <select
                  defaultValue={sheep.breeding_status || ''}
                  onChange={patchOnChange('breeding_status')}
                  style={editInp}
                >
                  <option value="">{'— not set —'}</option>
                  <option value="Open">Open</option>
                  <option value="Pregnant">Pregnant</option>
                  <option value="N/A">N/A</option>
                </select>
              </>
            )}
          </div>
        </div>
        {/* Lineage (editable) */}
        <div>
          <div style={sectionTitle}>Lineage</div>
          <div
            style={{
              fontSize: 12,
              color: '#374151',
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '4px 8px',
              alignItems: 'center',
            }}
          >
            <span style={{color: '#9ca3af'}}>Dam tag #:</span>
            <input
              type="text"
              defaultValue={sheep.dam_tag || ''}
              onBlur={patchOnBlur('dam_tag', 'text')}
              style={editInp}
            />
            {sheep.dam_tag && findByTag(sheep.dam_tag) && (
              <>
                <span style={{color: '#9ca3af'}}>{}</span>
                <span style={{fontSize: 11, color: '#6b7280'}}>
                  <TagLink tag={sheep.dam_tag} prefix="View " /> {'(' + (findByTag(sheep.dam_tag).breed || '?') + ')'}
                </span>
              </>
            )}
            <span style={{color: '#9ca3af'}}>Sire tag #:</span>
            <input
              type="text"
              defaultValue={sheep.sire_tag || ''}
              onBlur={patchOnBlur('sire_tag', 'text')}
              style={editInp}
            />
            {sheep.sire_tag && findByTag(sheep.sire_tag) && (
              <>
                <span style={{color: '#9ca3af'}}>{}</span>
                <span style={{fontSize: 11, color: '#6b7280'}}>
                  <TagLink tag={sheep.sire_tag} prefix="View " /> {'(' + (findByTag(sheep.sire_tag).breed || '?') + ')'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Prior Tags editor */}
      <div style={{marginTop: 12, paddingTop: 10, borderTop: '1px solid #f3f4f6'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
          <div style={sectionTitle}>Prior Tags</div>
          <button
            type="button"
            onClick={addOldTag}
            style={{
              fontSize: 11,
              color: '#1d4ed8',
              background: 'none',
              border: '1px dashed #bfdbfe',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + Add Prior Tag
          </button>
        </div>
        {(sheep.old_tags || []).length === 0 && (
          <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>No prior tags recorded.</div>
        )}
        {(sheep.old_tags || []).map((t, ti) => (
          <div
            key={ti}
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 140px 1fr 30px',
              gap: 8,
              marginBottom: 6,
              alignItems: 'center',
            }}
          >
            <input
              type="text"
              placeholder="Tag #"
              defaultValue={t.tag || ''}
              onBlur={(ev) => patchOldTagAt(ti, 'tag', ev.target.value)}
              style={editInp}
            />
            <input
              type="date"
              defaultValue={(t.changed_at || '').slice(0, 10)}
              onBlur={(ev) => patchOldTagAt(ti, 'changed_at', ev.target.value)}
              style={editInp}
            />
            <select
              defaultValue={t.source || 'manual'}
              onChange={(ev) => patchOldTagAt(ti, 'source', ev.target.value)}
              style={editInp}
            >
              <option value="import">Purchase tag (selling farm)</option>
              <option value="weigh_in">Swapped tag (weigh-in)</option>
              <option value="manual">Other / manual entry</option>
            </select>
            <button
              type="button"
              title="Remove"
              onClick={() => removeOldTag(ti)}
              style={{
                background: 'none',
                border: '1px solid #F09595',
                borderRadius: 5,
                color: '#b91c1c',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '4px 6px',
                fontFamily: 'inherit',
              }}
            >
              {'×'}
            </button>
          </div>
        ))}
      </div>

      {/* Breeding blacklist (hidden for wethers — they can't breed) */}
      {sheep.sex !== 'wether' && (
        <div style={{marginTop: 10, paddingTop: 8, borderTop: '1px solid #f3f4f6'}}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 13,
              color: '#7f1d1d',
              fontWeight: 600,
            }}
          >
            <input
              type="checkbox"
              checked={!!sheep.breeding_blacklist}
              onChange={patchOnChange('breeding_blacklist')}
              style={{margin: 0, flexShrink: 0}}
            />
            <span>Breeding blacklist</span>
          </label>
          <div style={{fontSize: 11, color: '#9ca3af', marginLeft: 26, marginTop: 4}}>
            Use the comments timeline to record why.
          </div>
        </div>
      )}

      {/* Weight history — table/chart toggle + per-row ADG + lifetime footer */}
      {weighIns &&
        weighIns.length > 0 &&
        (() => {
          const asc = [...weighIns].sort((a, b) => (a.entered_at || '').localeCompare(b.entered_at || ''));
          const rows = asc.map((w, i) => {
            const d = (w.entered_at || '').slice(0, 10);
            const wt = parseFloat(w.weight) || 0;
            const prev = i > 0 ? asc[i - 1] : null;
            const prevD = prev ? (prev.entered_at || '').slice(0, 10) : null;
            const prevW = prev ? parseFloat(prev.weight) || 0 : 0;
            const dDays = prev
              ? Math.round((new Date(d + 'T12:00:00') - new Date(prevD + 'T12:00:00')) / 86400000)
              : null;
            const dWt = prev ? Math.round((wt - prevW) * 10) / 10 : null;
            const lbDay = prev && dDays > 0 ? Math.round((dWt / dDays) * 100) / 100 : null;
            return {...w, date: d, wt, dDays, dWt, lbDay};
          });
          const desc = [...rows].reverse();
          const first = rows[0],
            last = rows[rows.length - 1];
          const lifetimeDays =
            first && last && first.date && last.date
              ? Math.round((new Date(last.date + 'T12:00:00') - new Date(first.date + 'T12:00:00')) / 86400000)
              : 0;
          const lifetimeWt = last && first ? Math.round((last.wt - first.wt) * 10) / 10 : 0;
          const lifetimeADG = lifetimeDays > 0 ? Math.round((lifetimeWt / lifetimeDays) * 100) / 100 : null;
          const colorFor = (v) => (v == null ? '#9ca3af' : v < 0 ? '#b91c1c' : v >= 0.3 ? '#065f46' : '#a16207');
          const fmtSigned = (v, suffix) => (v == null ? '—' : (v > 0 ? '+' : '') + v + (suffix || ''));

          const W = 620,
            H = 120,
            padT = 14,
            padB = 22,
            padL = 8,
            padR = 40;
          const chartW = W - padL - padR,
            chartH = H - padT - padB;
          const weights = rows.map((r) => r.wt);
          const minW = Math.min(...weights),
            maxW = Math.max(...weights);
          const spanW = Math.max(1, maxW - minW);
          const dates = rows.map((r) => new Date(r.date + 'T12:00:00').getTime());
          const minT = Math.min(...dates),
            maxT = Math.max(...dates);
          const spanT = Math.max(1, maxT - minT);
          const pts = rows.map((r, i) => {
            const x =
              padL +
              (rows.length === 1 ? chartW / 2 : ((new Date(r.date + 'T12:00:00').getTime() - minT) / spanT) * chartW);
            const y = padT + (1 - (r.wt - minW) / spanW) * chartH;
            return {x, y, row: r, i};
          });
          const linePath = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');

          return (
            <div style={{marginTop: 12}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                <div style={{...sectionTitle, marginBottom: 0}}>Weight History ({rows.length})</div>
                <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
                  {[
                    {k: 'table', l: 'Table'},
                    {k: 'chart', l: 'Chart'},
                  ].map((o, oi) => (
                    <button
                      key={o.k}
                      onClick={() => setWeightView(o.k)}
                      style={{
                        padding: '3px 10px',
                        border: 'none',
                        borderRight: oi < 1 ? '1px solid #d1d5db' : 'none',
                        fontFamily: 'inherit',
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                        background: weightView === o.k ? '#0f766e' : 'white',
                        color: weightView === o.k ? 'white' : '#6b7280',
                      }}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
              </div>

              {weightView === 'table' && (
                <div
                  style={{
                    background: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    overflow: 'hidden',
                    maxWidth: 640,
                  }}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 80px 80px 80px 90px',
                      gap: 0,
                      background: '#f9fafb',
                      padding: '6px 12px',
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#6b7280',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      borderBottom: '1px solid #e5e7eb',
                    }}
                  >
                    <div>Date</div>
                    <div style={{textAlign: 'right'}}>Weight</div>
                    <div style={{textAlign: 'right'}}>Days Since</div>
                    <div style={{textAlign: 'right'}}>Change</div>
                    <div style={{textAlign: 'right'}}>Lb / Day</div>
                  </div>
                  {desc.map((r, i) => (
                    <div
                      key={r.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 80px 80px 80px 90px',
                        gap: 0,
                        padding: '6px 12px',
                        fontSize: 12,
                        borderBottom: i < desc.length - 1 ? '1px solid #f3f4f6' : 'none',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <div style={{color: '#111827'}}>{fmt(r.date)}</div>
                      <div style={{textAlign: 'right', fontWeight: 700, color: '#111827'}}>
                        {r.wt.toLocaleString()} lb
                      </div>
                      <div style={{textAlign: 'right', color: '#6b7280'}}>{r.dDays != null ? r.dDays : '—'}</div>
                      <div
                        style={{
                          textAlign: 'right',
                          color: colorFor(r.dWt != null && r.dDays > 0 ? r.dWt / r.dDays : null),
                          fontWeight: 600,
                        }}
                      >
                        {fmtSigned(r.dWt)}
                      </div>
                      <div style={{textAlign: 'right', color: colorFor(r.lbDay), fontWeight: 700}}>
                        {r.lbDay != null ? fmtSigned(r.lbDay) : '—'}
                      </div>
                    </div>
                  ))}
                  {rows.length > 1 && (
                    <div
                      style={{
                        padding: '8px 12px',
                        fontSize: 11,
                        background: '#f3f4f6',
                        borderTop: '2px solid #d1d5db',
                        color: '#374151',
                        display: 'flex',
                        gap: 10,
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          fontSize: 10,
                          color: '#6b7280',
                        }}
                      >
                        Lifetime
                      </div>
                      <strong>
                        {first.wt} {'→'} {last.wt} lb
                      </strong>
                      <span style={{color: colorFor(lifetimeWt / Math.max(1, lifetimeDays))}}>
                        {fmtSigned(lifetimeWt, ' lb')}
                      </span>
                      <span>{'over ' + lifetimeDays.toLocaleString() + 'd'}</span>
                      <strong style={{color: colorFor(lifetimeADG)}}>
                        {lifetimeADG != null ? fmtSigned(lifetimeADG, ' lb/day') : '—'}
                      </strong>
                    </div>
                  )}
                </div>
              )}

              {weightView === 'chart' && (
                <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px'}}>
                  <svg
                    viewBox={'0 0 ' + W + ' ' + H}
                    preserveAspectRatio="none"
                    style={{width: '100%', height: 140, display: 'block', overflow: 'visible'}}
                    onMouseLeave={() => setChartHover(null)}
                  >
                    <line
                      x1={padL}
                      y1={padT + chartH}
                      x2={padL + chartW}
                      y2={padT + chartH}
                      stroke="#e5e7eb"
                      strokeWidth="1"
                    />
                    {pts.length > 1 && (
                      <path
                        d={
                          linePath +
                          ' L ' +
                          pts[pts.length - 1].x +
                          ',' +
                          (padT + chartH) +
                          ' L ' +
                          pts[0].x +
                          ',' +
                          (padT + chartH) +
                          ' Z'
                        }
                        fill="#f0fdfa"
                        opacity="0.8"
                      />
                    )}
                    {pts.length > 1 && (
                      <path
                        d={linePath}
                        fill="none"
                        stroke="#0f766e"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    )}
                    {pts.map((p) => (
                      <g key={p.row.id}>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={chartHover && chartHover.idx === p.i ? 5 : 3}
                          fill="#0f766e"
                          stroke="white"
                          strokeWidth="1.5"
                        />
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="12"
                          fill="transparent"
                          style={{cursor: 'pointer'}}
                          onMouseEnter={() => setChartHover({idx: p.i, x: p.x, y: p.y})}
                        />
                      </g>
                    ))}
                    <text x={padL + chartW + 4} y={padT + 4} fontSize="10" fill="#6b7280" fontFamily="inherit">
                      {maxW + ' lb'}
                    </text>
                    <text x={padL + chartW + 4} y={padT + chartH + 4} fontSize="10" fill="#6b7280" fontFamily="inherit">
                      {minW + ' lb'}
                    </text>
                    <text x={padL} y={H - 6} fontSize="10" fill="#9ca3af" fontFamily="inherit">
                      {fmt(rows[0].date)}
                    </text>
                    <text
                      x={padL + chartW}
                      y={H - 6}
                      fontSize="10"
                      fill="#9ca3af"
                      fontFamily="inherit"
                      textAnchor="end"
                    >
                      {fmt(rows[rows.length - 1].date)}
                    </text>
                    {chartHover &&
                      (() => {
                        const p = pts[chartHover.idx];
                        if (!p) return null;
                        const tx = Math.min(Math.max(p.x, padL + 60), padL + chartW - 60);
                        const ty = Math.max(p.y - 30, padT + 10);
                        return (
                          <g pointerEvents="none">
                            <rect
                              x={tx - 55}
                              y={ty - 14}
                              width="110"
                              height="30"
                              rx="4"
                              fill="#111827"
                              opacity="0.92"
                            />
                            <text
                              x={tx}
                              y={ty - 1}
                              fontSize="11"
                              fontWeight="700"
                              fill="white"
                              fontFamily="inherit"
                              textAnchor="middle"
                            >
                              {p.row.wt + ' lb'}
                            </text>
                            <text
                              x={tx}
                              y={ty + 11}
                              fontSize="9"
                              fill="#d1d5db"
                              fontFamily="inherit"
                              textAnchor="middle"
                            >
                              {fmt(p.row.date)}
                              {p.row.lbDay != null ? '  ' + fmtSigned(p.row.lbDay, ' lb/d') : ''}
                            </text>
                          </g>
                        );
                      })()}
                  </svg>
                  {rows.length > 1 && (
                    <div
                      style={{
                        marginTop: 6,
                        paddingTop: 8,
                        borderTop: '1px solid #f3f4f6',
                        fontSize: 11,
                        color: '#374151',
                        textAlign: 'center',
                      }}
                    >
                      <strong>
                        {first.wt} {'→'} {last.wt} lb
                      </strong>
                      {'  ·  '}
                      <span style={{color: colorFor(lifetimeWt / Math.max(1, lifetimeDays))}}>
                        {fmtSigned(lifetimeWt, ' lb')}
                      </span>
                      {'  over ' + lifetimeDays.toLocaleString() + ' days  ·  '}
                      <strong style={{color: colorFor(lifetimeADG)}}>
                        {lifetimeADG != null ? fmtSigned(lifetimeADG, ' lb/day') : '—'} lifetime ADG
                      </strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

      {/* Lambing history + add (Ewes only) */}
      {isEwe && (
        <div style={{marginTop: 12}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
            <div style={sectionTitle}>Lambing History</div>
            {!showLambForm && (
              <button
                type="button"
                onClick={() => setShowLambForm(true)}
                style={{
                  fontSize: 11,
                  color: '#0f766e',
                  background: 'none',
                  border: '1px solid #5eead4',
                  borderRadius: 5,
                  padding: '3px 8px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                + Add Lambing
              </button>
            )}
          </div>
          {showLambForm && (
            <div
              style={{
                background: '#f0fdfa',
                border: '1px solid #5eead4',
                borderRadius: 6,
                padding: '10px 12px',
                marginBottom: 8,
              }}
            >
              <div style={{marginBottom: 6}}>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Lambing date *</span>
                  <input
                    type="date"
                    value={lambForm.lambing_date}
                    onChange={(e) => setLambForm({...lambForm, lambing_date: e.target.value})}
                    style={recordControl}
                  />
                </div>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Total born</span>
                  <input
                    type="number"
                    min="0"
                    value={lambForm.total_born}
                    onChange={(e) => setLambForm({...lambForm, total_born: e.target.value})}
                    placeholder="0"
                    style={recordControl}
                  />
                </div>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Deaths</span>
                  <input
                    type="number"
                    min="0"
                    value={lambForm.deaths}
                    onChange={(e) => setLambForm({...lambForm, deaths: e.target.value})}
                    placeholder="0"
                    style={recordControl}
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      color: '#7f1d1d',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={lambForm.complications_flag}
                      onChange={(e) => setLambForm({...lambForm, complications_flag: e.target.checked})}
                      style={recordCheckbox}
                    />
                    Complications flag
                  </label>
                  {lambForm.complications_flag && (
                    <textarea
                      value={lambForm.complications_desc}
                      onChange={(e) => setLambForm({...lambForm, complications_desc: e.target.value})}
                      placeholder="Required: describe complications"
                      rows={2}
                      style={{...recordTextarea, marginTop: 4}}
                    />
                  )}
                </div>
                <div className={recordFieldRowClass} style={{borderBottom: 'none'}}>
                  <span style={recordFieldLabel}>Notes</span>
                  <textarea
                    value={lambForm.notes}
                    onChange={(e) => setLambForm({...lambForm, notes: e.target.value})}
                    rows={2}
                    style={recordTextarea}
                  />
                </div>
              </div>
              <div style={{display: 'flex', gap: 6}}>
                <button
                  type="button"
                  onClick={submitLambing}
                  style={{
                    padding: '10px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#0f766e',
                    color: 'white',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Save Lambing
                </button>
                <button
                  type="button"
                  onClick={() => setShowLambForm(false)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid #d1d5db',
                    background: 'white',
                    color: '#6b7280',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {(() => {
            const combined = [...(lambing || [])].sort((a, b) =>
              (b.lambing_date || '').localeCompare(a.lambing_date || ''),
            );
            if (combined.length === 0) {
              if (showLambForm) return null;
              return <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>No lambing records yet.</div>;
            }
            return combined.map((r) => (
              <div
                key={r.id}
                style={{
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '6px 10px',
                  marginBottom: 4,
                  fontSize: 11,
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <strong style={{color: '#111827'}}>{r.lambing_date ? fmt(r.lambing_date) : 'date unknown'}</strong>
                <span>{(r.total_born || 0) + ' born, ' + (r.deaths || 0) + ' died'}</span>
                {r.complications_flag && <span style={{color: '#b91c1c', fontWeight: 600}}>{'⚠ complications'}</span>}
                {r.notes && <span style={{color: '#6b7280', fontStyle: 'italic'}}>{r.notes}</span>}
                {onDeleteLambing && (
                  <button
                    type="button"
                    onClick={() => onDeleteLambing(r.id)}
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10,
                      color: '#b91c1c',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            ));
          })()}

          {/* Lambs linked to this dam by dam_tag */}
          {lambs && lambs.length > 0 && (
            <div style={{marginTop: 8}}>
              <div
                style={{
                  fontSize: 10,
                  color: '#6b7280',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  fontWeight: 600,
                  marginBottom: 4,
                }}
              >
                Lambs in directory ({lambs.length})
              </div>
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
                {lambs.map((l) => (
                  <button
                    type="button"
                    key={l.id}
                    onClick={() => onNavigateToSheep && onNavigateToSheep(l)}
                    style={{
                      fontSize: 11,
                      padding: '3px 8px',
                      borderRadius: 5,
                      border: '1px solid #5eead4',
                      background: '#f0fdfa',
                      color: '#0f766e',
                      cursor: onNavigateToSheep ? 'pointer' : 'default',
                      fontFamily: 'inherit',
                    }}
                  >
                    {'#' + l.tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legacy comments — hidden when CommentsSection is used on the record page */}
      {!hideComments && (
        <div style={{marginTop: 12}}>
          <div style={sectionTitle}>Issues</div>
          <div style={{display: 'flex', gap: 6, marginBottom: 6}}>
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder={'Add a comment…'}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '6px 10px',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={() => {
                onComment(commentText);
                setCommentText('');
              }}
              disabled={!commentText.trim()}
              style={{
                padding: '10px 16px',
                borderRadius: 6,
                border: 'none',
                background: commentText.trim() ? '#0f766e' : '#d1d5db',
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: commentText.trim() ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
              }}
            >
              Add
            </button>
          </div>
          {comments && comments.length > 0 ? (
            <div style={{maxHeight: 260, overflowY: 'auto'}}>
              {comments.map((c) => {
                const isEditing = editingCommentId === c.id;
                return (
                  <div
                    key={c.id}
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      padding: '6px 10px',
                      marginBottom: 4,
                      fontSize: 11,
                    }}
                  >
                    <div style={{display: 'flex', gap: 8, alignItems: 'center', marginBottom: 2, flexWrap: 'wrap'}}>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background:
                            c.source === 'weigh_in'
                              ? '#eff6ff'
                              : c.source === 'lambing'
                                ? '#f0fdfa'
                                : c.source === 'daily_report'
                                  ? '#ecfdf5'
                                  : c.source === 'import'
                                    ? '#fef3c7'
                                    : '#f3f4f6',
                          color:
                            c.source === 'weigh_in'
                              ? '#1e40af'
                              : c.source === 'lambing'
                                ? '#0f766e'
                                : c.source === 'daily_report'
                                  ? '#065f46'
                                  : c.source === 'import'
                                    ? '#92400e'
                                    : '#374151',
                        }}
                      >
                        {c.source}
                      </span>
                      <span style={{color: '#9ca3af'}}>{fmt((c.created_at || '').slice(0, 10))}</span>
                      {c.team_member && <span style={{color: '#9ca3af', fontWeight: 600}}>{'· ' + c.team_member}</span>}
                      {!isEditing && onEditComment && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCommentId(c.id);
                            setEditingCommentText(c.comment || '');
                          }}
                          style={{
                            marginLeft: 'auto',
                            fontSize: 10,
                            color: '#1d4ed8',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '2px 4px',
                            fontFamily: 'inherit',
                          }}
                        >
                          Edit
                        </button>
                      )}
                      {!isEditing && onDeleteComment && (
                        <button
                          type="button"
                          onClick={() => onDeleteComment(c.id)}
                          style={{
                            fontSize: 10,
                            color: '#b91c1c',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            padding: '2px 4px',
                            fontFamily: 'inherit',
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                    {isEditing ? (
                      <div>
                        <textarea
                          value={editingCommentText}
                          onChange={(e) => setEditingCommentText(e.target.value)}
                          rows={2}
                          style={{
                            width: '100%',
                            fontSize: 11,
                            padding: '4px 8px',
                            border: '1px solid #d1d5db',
                            borderRadius: 5,
                            fontFamily: 'inherit',
                            boxSizing: 'border-box',
                            resize: 'vertical',
                          }}
                        />
                        <div style={{display: 'flex', gap: 6, marginTop: 4}}>
                          <button
                            type="button"
                            onClick={() => {
                              onEditComment(c.id, editingCommentText);
                              setEditingCommentId(null);
                              setEditingCommentText('');
                            }}
                            disabled={!editingCommentText.trim()}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 5,
                              border: 'none',
                              background: editingCommentText.trim() ? '#0f766e' : '#d1d5db',
                              color: 'white',
                              fontSize: 10,
                              fontWeight: 600,
                              cursor: editingCommentText.trim() ? 'pointer' : 'not-allowed',
                              fontFamily: 'inherit',
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingCommentId(null);
                              setEditingCommentText('');
                            }}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 5,
                              border: '1px solid #d1d5db',
                              background: 'white',
                              color: '#6b7280',
                              fontSize: 10,
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{color: '#374151'}}>{c.comment}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>No comments yet.</div>
          )}
          {sheep.breeding_blacklist && (
            <div
              style={{
                marginTop: 8,
                background: '#fecaca',
                border: '1px solid #f87171',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 11,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: '#0f766e',
                  color: 'white',
                }}
              >
                BREEDING BLACKLIST
              </span>
              <span style={{color: '#0f5248', fontWeight: 600}}>{'Flagged — do not breed.'}</span>
            </div>
          )}
        </div>
      )}

      {/* Action buttons (Edit removed — fields are inline-editable above) */}
      <div
        style={{
          marginTop: 12,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          borderTop: '1px solid #e5e7eb',
          paddingTop: 10,
        }}
      >
        {!showTransfer && (
          <button
            onClick={() => setShowTransfer(true)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#1d4ed8',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Transfer
          </button>
        )}
        {showTransfer && (
          <select
            onChange={(e) => {
              if (e.target.value) {
                onTransfer(e.target.value);
                setShowTransfer(false);
              }
            }}
            style={{
              fontSize: 12,
              padding: '5px 8px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontFamily: 'inherit',
            }}
          >
            <option value="">Select target flock...</option>
            {(FLOCKS || [])
              .filter((f) => f !== sheep.flock)
              .map((f) => (
                <option key={f} value={f}>
                  Move to {FLOCK_LABELS[f]}
                </option>
              ))}
          </select>
        )}
        {showTransfer && (
          <button
            onClick={() => setShowTransfer(false)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#6b7280',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #F09595',
              background: 'white',
              color: '#b91c1c',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginLeft: 'auto',
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
};

export default SheepDetail;
