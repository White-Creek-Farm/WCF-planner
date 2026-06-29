// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
import React from 'react';
import {
  recordFieldRowClass,
  recordFieldLabel,
  recordControl,
  recordTextarea,
  recordCheckbox,
} from '../shared/recordPageControls.jsx';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';

const CowDetail = ({
  cow,
  weighIns,
  calving,
  comments,
  calves,
  dam,
  cattleList,
  fmt,
  HERDS,
  HERD_LABELS,
  onEdit,
  onDelete,
  onComment,
  onEditComment,
  onDeleteComment,
  onAddCalving,
  onDeleteCalving,
  onNavigateToCow,
  onNavigateBack,
  canNavigateBack,
  backToTag,
  onPatch,
  onClose,
  originOpts,
  breedOpts,
  ageFieldLabel = 'Age',
  ageLabel,
  hideComments,
}) => {
  // Auto-save inline editor — uncontrolled inputs that fire onPatch on blur
  // when the value changed. Numbers parse to number; empty strings become null.
  const patchOnBlur = (field, parser) => (ev) => {
    if (!onPatch) return;
    const raw = ev.target.value;
    const cur = cow[field];
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
  // Editable old_tags helpers
  function patchOldTagAt(idx, field, value) {
    if (!onPatch) return;
    const next = (Array.isArray(cow.old_tags) ? cow.old_tags : []).slice();
    next[idx] = {...next[idx], [field]: value};
    onPatch({old_tags: next});
  }
  function addOldTag() {
    if (!onPatch) return;
    const next = [...(Array.isArray(cow.old_tags) ? cow.old_tags : []), {tag: '', changed_at: '', source: 'manual'}];
    onPatch({old_tags: next});
  }
  function removeOldTag(idx) {
    if (!onPatch) return;
    const next = (Array.isArray(cow.old_tags) ? cow.old_tags : []).filter((_, i) => i !== idx);
    onPatch({old_tags: next});
  }
  const editInp = {
    fontSize: 12,
    padding: '5px 8px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    width: '100%',
    background: 'white',
  };
  const [commentText, setCommentText] = React.useState('');
  const [showCalvingForm, setShowCalvingForm] = React.useState(false);
  const [editingCommentId, setEditingCommentId] = React.useState(null);
  const [editingCommentText, setEditingCommentText] = React.useState('');
  const [calvingForm, setCalvingForm] = React.useState({
    calving_date: new Date().toISOString().slice(0, 10),
    calf_tag: '',
    sire_tag: '',
    complications_flag: false,
    complications_desc: '',
    notes: '',
  });
  const [weightView, setWeightView] = React.useState('table'); // 'table' | 'chart'
  const [chartHover, setChartHover] = React.useState(null); // {idx, x, y}
  const sectionTitle = {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  };
  const isMomma = cow.herd === 'mommas';
  async function submitCalving() {
    const ok = await onAddCalving(calvingForm);
    if (ok) {
      setShowCalvingForm(false);
      setCalvingForm({
        calving_date: new Date().toISOString().slice(0, 10),
        calf_tag: '',
        sire_tag: '',
        complications_flag: false,
        complications_desc: '',
        notes: '',
      });
    }
  }

  // Tag lookup helper for cross-cow navigation (calving → calf, lineage → dam/sire)
  const findByTag = (t) => (t && Array.isArray(cattleList) ? cattleList.find((x) => x.tag === t) : null);
  const linkStyle = {
    color: 'var(--brand)',
    cursor: 'pointer',
    textDecoration: 'underline',
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
  };
  const TagLink = ({tag, prefix, label}) => {
    const t = findByTag(tag);
    if (!t || !onNavigateToCow) return <span>{(prefix || '') + (label || '#' + tag)}</span>;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigateToCow(t);
        }}
        style={linkStyle}
      >
        {(prefix || '') + (label || '#' + tag)}
      </button>
    );
  };
  return (
    <div
      data-cow-detail
      style={{
        background: '#ffffff',
        padding: '14px 18px',
        border: '1px solid var(--border)',
        borderRadius: 10,
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
            borderRadius: 10,
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
            {'\u2190 Back' + (backToTag ? ' to #' + backToTag : '')}
          </button>
          <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>— you navigated here from another cow</span>
        </div>
      )}
      {/* Header: editable tag + labeled herd/sex/breed selects + close X */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: '1px solid var(--divider)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 4}}>
          <span style={{fontSize: 16, fontWeight: 700, color: 'var(--text-primary)'}}>{'#'}</span>
          <input
            type="text"
            defaultValue={cow.tag || ''}
            onBlur={patchOnBlur('tag', 'text')}
            placeholder="tag"
            style={{...editInp, width: 90, fontWeight: 700, fontSize: 14, color: 'var(--text-primary)'}}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--ink-muted)',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Herd
          </div>
          <select defaultValue={cow.herd || ''} onChange={patchOnChange('herd')} style={{...editInp, width: 140}}>
            {(HERDS || []).map((h) => (
              <option key={h} value={h}>
                {HERD_LABELS[h] || h}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--ink-muted)',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Sex
          </div>
          <select defaultValue={cow.sex || ''} onChange={patchOnChange('sex')} style={{...editInp, width: 100}}>
            <option value="">{'\u2014 sex \u2014'}</option>
            <option value="cow">Cow</option>
            <option value="heifer">Heifer</option>
            <option value="bull">Bull</option>
            <option value="steer">Steer</option>
            <option value="calf">Calf</option>
          </select>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--ink-muted)',
              fontWeight: 600,
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Breed
          </div>
          <select defaultValue={cow.breed || ''} onChange={patchOnChange('breed')} style={{...editInp, width: 210}}>
            <option value="">{'\u2014 breed \u2014'}</option>
            {(breedOpts || [])
              .filter((b) => b.active)
              .map((b) => (
                <option key={b.id} value={b.label}>
                  {b.label}
                </option>
              ))}
            {cow.breed && !(breedOpts || []).some((b) => b.active && b.label === cow.breed) && (
              <option value={cow.breed}>{cow.breed + ' (historical)'}</option>
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
              border: '1px solid var(--border-strong)',
              borderRadius: 10,
              color: 'var(--ink-muted)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '2px 10px',
              fontFamily: 'inherit',
            }}
          >
            {'\u00d7'}
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
              color: 'var(--ink)',
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '4px 8px',
              alignItems: 'center',
            }}
          >
            <span style={{color: 'var(--ink-faint)'}}>Reg #:</span>
            <input
              type="text"
              defaultValue={cow.registration_num || ''}
              onBlur={patchOnBlur('registration_num', 'text')}
              style={editInp}
            />
            <span style={{color: 'var(--ink-faint)'}}>% Wagyu:</span>
            <input
              type="number"
              min="0"
              max="100"
              defaultValue={cow.pct_wagyu == null ? '' : cow.pct_wagyu}
              onBlur={patchOnBlur('pct_wagyu', 'number')}
              style={editInp}
            />
            <span style={{color: 'var(--ink-faint)'}}>Origin:</span>
            <select defaultValue={cow.origin || ''} onChange={patchOnChange('origin')} style={editInp}>
              <option value="">{'\u2014 select \u2014'}</option>
              {(originOpts || [])
                .filter((o) => o.active)
                .map((o) => (
                  <option key={o.id} value={o.label}>
                    {o.label}
                  </option>
                ))}
              {cow.origin && !(originOpts || []).some((o) => o.active && o.label === cow.origin) && (
                <option value={cow.origin}>{cow.origin}</option>
              )}
            </select>
            <span style={{color: 'var(--ink-faint)'}}>Birth:</span>
            <input
              type="date"
              defaultValue={cow.birth_date || ''}
              onBlur={patchOnBlur('birth_date', 'text')}
              style={editInp}
            />
            <span style={{color: 'var(--ink-faint)'}}>{ageFieldLabel}:</span>
            <span
              style={{
                fontSize: 12,
                padding: '5px 8px',
                color: 'var(--ink-muted)',
                fontFamily: 'inherit',
              }}
            >
              {ageLabel || '—'}
            </span>
            <span style={{color: 'var(--ink-faint)'}}>Purchased:</span>
            <input
              type="date"
              defaultValue={cow.purchase_date || ''}
              onBlur={patchOnBlur('purchase_date', 'text')}
              style={editInp}
            />
            <span style={{color: 'var(--ink-faint)'}}>Purchase $:</span>
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={cow.purchase_amount == null ? '' : cow.purchase_amount}
              onBlur={patchOnBlur('purchase_amount', 'number')}
              style={editInp}
            />
            {(cow.sex === 'cow' || cow.sex === 'heifer') && (
              <>
                <span style={{color: 'var(--ink-faint)'}}>Breeding:</span>
                <select
                  defaultValue={cow.breeding_status || ''}
                  onChange={patchOnChange('breeding_status')}
                  style={editInp}
                >
                  <option value="">{'\u2014 not set \u2014'}</option>
                  <option value="OPEN">Open</option>
                  <option value="PREGNANT">Pregnant</option>
                  <option value="N/A">N/A</option>
                </select>
              </>
            )}
          </div>
        </div>
        {/* Lineage */}
        <div data-lineage-section="1">
          <div style={sectionTitle}>Lineage</div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--ink)',
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '4px 8px',
              alignItems: 'center',
            }}
          >
            <span style={{color: 'var(--ink-faint)'}}>Dam tag #:</span>
            <input
              type="text"
              defaultValue={cow.dam_tag || ''}
              onBlur={patchOnBlur('dam_tag', 'text')}
              style={editInp}
            />
            {cow.dam_tag && findByTag(cow.dam_tag) && (
              <>
                <span style={{color: 'var(--ink-faint)'}}>{}</span>
                <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                  <TagLink tag={cow.dam_tag} prefix="View " /> {'(' + (findByTag(cow.dam_tag).breed || '?') + ')'}
                </span>
              </>
            )}
            <span style={{color: 'var(--ink-faint)'}}>Sire tag #:</span>
            <input
              type="text"
              defaultValue={cow.sire_tag || ''}
              onBlur={patchOnBlur('sire_tag', 'text')}
              style={editInp}
            />
            {cow.sire_tag && findByTag(cow.sire_tag) && (
              <>
                <span style={{color: 'var(--ink-faint)'}}>{}</span>
                <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                  <TagLink tag={cow.sire_tag} prefix="View " /> {'(' + (findByTag(cow.sire_tag).breed || '?') + ')'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Prior Tags editor */}
      <div style={{marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--divider)'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
          <div style={sectionTitle}>Prior Tags</div>
          <button
            type="button"
            onClick={addOldTag}
            style={{
              fontSize: 11,
              color: 'var(--brand)',
              background: 'none',
              border: '1px dashed #bfdbfe',
              borderRadius: 10,
              padding: '3px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + Add Prior Tag
          </button>
        </div>
        {(cow.old_tags || []).length === 0 && (
          <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>No prior tags recorded.</div>
        )}
        {(cow.old_tags || []).map((t, ti) => (
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
                borderRadius: 10,
                color: '#b91c1c',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '4px 6px',
                fontFamily: 'inherit',
              }}
            >
              {'\u00d7'}
            </button>
          </div>
        ))}
      </div>
      {/* Breeding blacklist (hidden for steers \u2014 they can't breed) */}
      {cow.sex !== 'steer' && (
        <label
          data-breeding-blacklist-row="1"
          style={{
            marginTop: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: 8,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: '6px 12px',
            background: cow.breeding_blacklist ? 'var(--danger-soft)' : 'white',
            color: 'var(--danger)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          <input
            type="checkbox"
            checked={!!cow.breeding_blacklist}
            onChange={patchOnChange('breeding_blacklist')}
            style={{
              margin: 0,
              padding: 0,
              width: 14,
              height: 14,
              minWidth: 14,
              flex: '0 0 14px',
              boxSizing: 'border-box',
              accentColor: 'var(--danger)',
              cursor: 'pointer',
            }}
          />
          <span style={{minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block'}}>
            Breeding blacklist
          </span>
        </label>
      )}

      {/* Weigh-in history — table / chart toggle with per-row ADG + lifetime footer */}
      {weighIns &&
        weighIns.length > 0 &&
        (() => {
          // Build chronological (oldest→newest) records so per-row deltas compare
          // each weigh-in to the previous one. We flip to newest-first for display.
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
            const isReceiving =
              i === 0 &&
              ((w.session_id || '').startsWith('wsess-rcv-') || (w.note || '').toLowerCase().includes('receiving'));
            return {...w, date: d, wt, dDays, dWt, lbDay, isReceiving};
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
          const fmtSigned = (v, suffix) => (v == null ? '\u2014' : (v > 0 ? '+' : '') + v + (suffix || ''));

          // Sparkline: plot asc series on a fixed viewBox, normalize to weight range
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
                <div
                  style={{
                    display: 'flex',
                    borderRadius: 10,
                    overflow: 'hidden',
                    border: '1px solid var(--border-strong)',
                  }}
                >
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
                        borderRight: oi < 1 ? '1px solid var(--border-strong)' : 'none',
                        fontFamily: 'inherit',
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                        background: 'white',
                        color: weightView === o.k ? '#1e40af' : 'var(--ink-muted)',
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
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    maxWidth: 640,
                  }}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 80px 80px 80px 90px',
                      gap: 0,
                      background: 'var(--surface-2)',
                      padding: '6px 12px',
                      fontSize: 10,
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <div>Date</div>
                    <div style={{textAlign: 'right'}}>Weight</div>
                    <div style={{textAlign: 'right'}}>Days Since</div>
                    <div style={{textAlign: 'right'}}>Change</div>
                    <div style={{textAlign: 'right'}}>Lb / Day</div>
                  </div>
                  {desc.map((r, i) => {
                    const isBaseline = r.isReceiving || r.dDays == null;
                    return (
                      <div
                        key={r.id}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '120px 80px 80px 80px 90px',
                          gap: 0,
                          padding: '6px 12px',
                          fontSize: 12,
                          borderBottom: i < desc.length - 1 ? '1px solid var(--divider)' : 'none',
                          fontVariantNumeric: 'tabular-nums',
                          background: isBaseline ? '#fafafa' : 'white',
                        }}
                      >
                        <div style={{color: 'var(--ink)'}}>
                          {fmt(r.date)}
                          {r.isReceiving && (
                            <div
                              style={{
                                fontSize: 10,
                                color: '#92400e',
                                marginTop: 2,
                                padding: '1px 5px',
                                borderRadius: 999,
                                background: '#fef3c7',
                                fontWeight: 600,
                                display: 'inline-block',
                              }}
                            >
                              RECEIVING
                            </div>
                          )}
                        </div>
                        <div style={{textAlign: 'right', fontWeight: 700, color: 'var(--ink)'}}>
                          {r.wt.toLocaleString()} lb
                        </div>
                        <div style={{textAlign: 'right', color: 'var(--ink-muted)'}}>
                          {r.dDays != null ? r.dDays : '\u2014'}
                        </div>
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
                          {r.lbDay != null ? fmtSigned(r.lbDay) : '\u2014'}
                        </div>
                      </div>
                    );
                  })}
                  {rows.length > 1 && (
                    <div
                      style={{
                        padding: '8px 12px',
                        fontSize: 11,
                        background: '#f3f4f6',
                        borderTop: '2px solid var(--border-strong)',
                        color: 'var(--ink)',
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
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Lifetime
                      </div>
                      <strong>
                        {first.wt} {'\u2192'} {last.wt} lb
                      </strong>
                      <span style={{color: colorFor(lifetimeWt / Math.max(1, lifetimeDays))}}>
                        {fmtSigned(lifetimeWt, ' lb')}
                      </span>
                      <span>{'over ' + lifetimeDays.toLocaleString() + 'd'}</span>
                      <strong style={{color: colorFor(lifetimeADG)}}>
                        {lifetimeADG != null ? fmtSigned(lifetimeADG, ' lb/day') : '\u2014'}
                      </strong>
                    </div>
                  )}
                </div>
              )}

              {weightView === 'chart' && (
                <div
                  style={{
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '10px 12px',
                  }}
                >
                  <svg
                    viewBox={'0 0 ' + W + ' ' + H}
                    preserveAspectRatio="none"
                    style={{width: '100%', height: 140, display: 'block', overflow: 'visible'}}
                    onMouseLeave={() => setChartHover(null)}
                  >
                    {/* baseline */}
                    <line
                      x1={padL}
                      y1={padT + chartH}
                      x2={padL + chartW}
                      y2={padT + chartH}
                      stroke="#e5e7eb"
                      strokeWidth="1"
                    />
                    {/* area fill under line */}
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
                        fill="#eff6ff"
                        opacity="0.8"
                      />
                    )}
                    {/* line */}
                    {pts.length > 1 && (
                      <path
                        d={linePath}
                        fill="none"
                        stroke="#1e40af"
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    )}
                    {/* points */}
                    {pts.map((p) => (
                      <g key={p.row.id}>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={chartHover && chartHover.idx === p.i ? 5 : 3}
                          fill={p.row.isReceiving ? '#a16207' : '#1e40af'}
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
                    {/* min/max labels on right */}
                    <text x={padL + chartW + 4} y={padT + 4} fontSize="10" fill="#6b7280" fontFamily="inherit">
                      {maxW + ' lb'}
                    </text>
                    <text x={padL + chartW + 4} y={padT + chartH + 4} fontSize="10" fill="#6b7280" fontFamily="inherit">
                      {minW + ' lb'}
                    </text>
                    {/* first / last date labels */}
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
                    {/* hover tooltip */}
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
                        borderTop: '1px solid var(--divider)',
                        fontSize: 11,
                        color: 'var(--ink)',
                        textAlign: 'center',
                      }}
                    >
                      <strong>
                        {first.wt} {'\u2192'} {last.wt} lb
                      </strong>
                      {'  \u00b7  '}
                      <span style={{color: colorFor(lifetimeWt / Math.max(1, lifetimeDays))}}>
                        {fmtSigned(lifetimeWt, ' lb')}
                      </span>
                      {'  over ' + lifetimeDays.toLocaleString() + ' days  \u00b7  '}
                      <strong style={{color: colorFor(lifetimeADG)}}>
                        {lifetimeADG != null ? fmtSigned(lifetimeADG, ' lb/day') : '\u2014'} lifetime ADG
                      </strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

      {/* Calving history + add (Mommas only) */}
      {isMomma && (
        <div style={{marginTop: 12}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
            <div style={sectionTitle}>Calving History</div>
            {!showCalvingForm && (
              <button
                type="button"
                onClick={() => setShowCalvingForm(true)}
                style={{
                  fontSize: 11,
                  color: 'var(--ink)',
                  background: 'white',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 10,
                  padding: '3px 8px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                + Add Calving
              </button>
            )}
          </div>
          {showCalvingForm && (
            <div
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 12px',
                marginBottom: 8,
              }}
            >
              <div style={{marginBottom: 6}}>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Calving date *</span>
                  <input
                    type="date"
                    value={calvingForm.calving_date}
                    onChange={(e) => setCalvingForm({...calvingForm, calving_date: e.target.value})}
                    style={recordControl}
                  />
                </div>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Calf tag (optional)</span>
                  <input
                    value={calvingForm.calf_tag}
                    onChange={(e) => setCalvingForm({...calvingForm, calf_tag: e.target.value})}
                    placeholder="e.g. 92"
                    style={recordControl}
                  />
                </div>
                <div className={recordFieldRowClass}>
                  <span style={recordFieldLabel}>Sire tag</span>
                  <input
                    value={calvingForm.sire_tag}
                    onChange={(e) => setCalvingForm({...calvingForm, sire_tag: e.target.value})}
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
                      color: 'var(--ink)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={calvingForm.complications_flag}
                      onChange={(e) => setCalvingForm({...calvingForm, complications_flag: e.target.checked})}
                      style={recordCheckbox}
                    />
                    Complications flag
                  </label>
                  {calvingForm.complications_flag && (
                    <textarea
                      value={calvingForm.complications_desc}
                      onChange={(e) => setCalvingForm({...calvingForm, complications_desc: e.target.value})}
                      placeholder="Required: describe complications"
                      rows={2}
                      style={{...recordTextarea, marginTop: 4}}
                    />
                  )}
                </div>
                <div className={recordFieldRowClass} style={{borderBottom: 'none'}}>
                  <span style={recordFieldLabel}>Notes</span>
                  <textarea
                    value={calvingForm.notes}
                    onChange={(e) => setCalvingForm({...calvingForm, notes: e.target.value})}
                    rows={2}
                    style={recordTextarea}
                  />
                </div>
              </div>
              <div style={{display: 'flex', gap: 6}}>
                <button
                  type="button"
                  onClick={submitCalving}
                  style={{
                    padding: '10px 16px',
                    borderRadius: 10,
                    border: 'none',
                    background: getProgramColor('cattle'),
                    color: getReadableText(getProgramColor('cattle')),
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Save Calving
                </button>
                <button
                  type="button"
                  onClick={() => setShowCalvingForm(false)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink-muted)',
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
            var recordedTags = new Set(
              (calving || [])
                .map(function (r) {
                  return r.calf_tag;
                })
                .filter(Boolean),
            );
            var syntheticFromCalves = (calves || [])
              .filter(function (cf) {
                return cf.tag && !recordedTags.has(cf.tag);
              })
              .map(function (cf) {
                return {
                  id: 'synthetic-' + cf.id,
                  synthetic: true,
                  calving_date: cf.birth_date || null,
                  calf_tag: cf.tag,
                  total_born: 1,
                  deaths: 0,
                };
              });
            var combined = [...(calving || []), ...syntheticFromCalves].sort(function (a, b) {
              return (b.calving_date || '').localeCompare(a.calving_date || '');
            });
            if (combined.length === 0) {
              if (showCalvingForm) return null;
              return (
                <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
                  No calving records yet.
                </div>
              );
            }
            return combined.map(function (r) {
              var calfCow = r.calf_tag ? findByTag(r.calf_tag) : null;
              return (
                <div
                  key={r.id}
                  style={{
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '6px 10px',
                    marginBottom: 4,
                    fontSize: 11,
                    display: 'flex',
                    gap: 10,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <strong style={{color: 'var(--ink)'}}>{r.calving_date ? fmt(r.calving_date) : 'date unknown'}</strong>
                  {r.calf_tag &&
                    (calfCow && onNavigateToCow ? (
                      <button
                        type="button"
                        onClick={function () {
                          onNavigateToCow(calfCow);
                        }}
                        style={{
                          color: 'var(--brand)',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          font: 'inherit',
                          fontWeight: 600,
                        }}
                      >
                        {'calf #' + r.calf_tag}
                      </button>
                    ) : (
                      <span style={{color: 'var(--text-primary)'}}>{'calf #' + r.calf_tag}</span>
                    ))}
                  {calfCow && (
                    <span style={{fontSize: 10, color: 'var(--ink-muted)'}}>
                      {'\u00b7 ' +
                        (HERD_LABELS[calfCow.herd] || calfCow.herd) +
                        (calfCow.breed ? ' \u00b7 ' + calfCow.breed : '')}
                    </span>
                  )}
                  {r.complications_flag && (
                    <span style={{color: '#b91c1c', fontWeight: 600}}>{'\u26a0 complications'}</span>
                  )}
                  {r.notes && <span style={{color: 'var(--ink-muted)', fontStyle: 'italic'}}>{r.notes}</span>}
                  {r.synthetic && (
                    <span style={{fontSize: 10, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
                      {'(from calf record)'}
                    </span>
                  )}
                  {!r.synthetic && onDeleteCalving && (
                    <button
                      type="button"
                      onClick={function () {
                        onDeleteCalving(r.id);
                      }}
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
              );
            });
          })()}
        </div>
      )}
      {!isMomma && calving && calving.length > 0 && (
        <div style={{marginTop: 12}}>
          <div style={sectionTitle}>Calving History (historical)</div>
          {calving.map((r) => (
            <div
              key={r.id}
              style={{
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '6px 10px',
                marginBottom: 4,
                fontSize: 11,
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <strong style={{color: 'var(--ink)'}}>{fmt(r.calving_date)}</strong>
              {r.calf_tag && <span style={{color: 'var(--text-primary)'}}>calf #{r.calf_tag}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Legacy Issues section (hidden on record pages where CommentsSection replaces this) */}
      {!hideComments && (
        <div style={{marginTop: 12}}>
          <div style={sectionTitle}>Issues</div>
          <div style={{display: 'flex', gap: 6, marginBottom: 6}}>
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add an issue..."
              style={{
                flex: 1,
                fontSize: 12,
                padding: '6px 10px',
                border: '1px solid var(--border-strong)',
                borderRadius: 10,
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
                borderRadius: 10,
                border: 'none',
                background: commentText.trim() ? getProgramColor('cattle') : '#d1d5db',
                color: commentText.trim() ? getReadableText(getProgramColor('cattle')) : 'white',
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
                      border: '1px solid var(--border)',
                      borderRadius: 10,
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
                          borderRadius: 999,
                          background: 'var(--surface-2)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {c.source}
                      </span>
                      <span style={{color: 'var(--ink-faint)'}}>{fmt((c.created_at || '').slice(0, 10))}</span>
                      {c.team_member && (
                        <span style={{color: 'var(--ink-faint)', fontWeight: 600}}>{'\u00b7 ' + c.team_member}</span>
                      )}
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
                            color: 'var(--brand)',
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
                            border: '1px solid var(--border-strong)',
                            borderRadius: 10,
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
                              borderRadius: 10,
                              border: 'none',
                              background: editingCommentText.trim() ? getProgramColor('cattle') : '#d1d5db',
                              color: editingCommentText.trim() ? getReadableText(getProgramColor('cattle')) : 'white',
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
                              borderRadius: 10,
                              border: '1px solid var(--border-strong)',
                              background: 'white',
                              color: 'var(--ink-muted)',
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
                      <div style={{color: 'var(--ink)'}}>{c.comment}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>No comments yet.</div>
          )}
          {cow.breeding_blacklist && (
            <div
              style={{
                marginTop: 8,
                background: 'var(--danger-soft)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '6px 10px',
                fontSize: 11,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <Badge variant="danger">BREEDING BLACKLIST</Badge>
              <span style={{color: 'var(--danger)', fontWeight: 600}}>{'Flagged \u2014 do not breed.'}</span>
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
          borderTop: '1px solid var(--border)',
          paddingTop: 10,
        }}
      >
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              padding: '6px 12px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'white',
              color: 'var(--danger)',
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

export default CowDetail;
