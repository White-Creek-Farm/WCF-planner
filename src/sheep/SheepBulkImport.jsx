// Auto-extracted by Phase 2 Round 2 (verbatim). See MIGRATION_PLAN §6.
/* global XLSX */
import React from 'react';
import {VALID_BREED_STATUS, parseImportDate, parseImportNumber, normTagStr} from '../lib/bulkImport.js';

const SHEEP_IMPORT_COLUMNS = [
  'tag',
  'sex',
  'flock',
  'breed',
  'origin',
  'purchase_date',
  'purchase_amount',
  'birth_date',
  'dam_tag',
  'dam_reg_num',
  'sire_tag',
  'sire_reg_num',
  'registration_num',
  'breeding_status',
  'last_lambing_date',
  'total_born',
  'receiving_weight',
  'comment',
];
const SHEEP_IMPORT_INSTRUCTIONS = [
  ['Column', 'Required', 'Notes'],
  ['tag', 'yes', 'WCF tag #. Must be unique among active flocks.'],
  ['sex', 'yes', 'ewe | ram | wether'],
  ['flock', 'yes', 'rams | ewes | feeders (or processed/deceased/sold)'],
  ['breed', 'no', 'Free text. Auto-creates new breed if not in the dropdown.'],
  ['origin', 'no', 'Selling farm. Auto-creates new origin if not in the dropdown.'],
  ['purchase_date', 'no', 'YYYY-MM-DD or M/D/YY.'],
  ['purchase_amount', 'no', 'Number. No $ or commas.'],
  ['birth_date', 'no', 'YYYY-MM-DD or M/D/YY.'],
  ['dam_tag', 'no', 'Mother\u2019s tag # (text).'],
  ['dam_reg_num', 'no', 'Mother\u2019s registration #.'],
  ['sire_tag', 'no', 'Father\u2019s tag # (text).'],
  ['sire_reg_num', 'no', 'Father\u2019s registration #.'],
  ['registration_num', 'no', 'This sheep\u2019s own registration #.'],
  ['breeding_status', 'no', 'Open | Pregnant | N/A. Ewes only.'],
  ['last_lambing_date', 'no', 'If set, creates a lambing record on this date.'],
  ['total_born', 'no', 'Lambs born in the last_lambing_date event (default 0).'],
  ['receiving_weight', 'no', 'If set, creates a wsess-rcv-* session at purchase_date with this weight.'],
  ['comment', 'no', 'If set, creates a comment on the sheep\u2019s timeline (source=import).'],
];
const VALID_SHEEP_SEX = ['ewe', 'ram', 'wether'];
const VALID_SHEEP_FLOCK = ['rams', 'ewes', 'feeders', 'processed', 'deceased', 'sold'];

function validateSheepImportRow(raw, rowIdx, existingTags) {
  var errors = [],
    warnings = [];
  var get = function (k) {
    return raw[k];
  };
  var tag = normTagStr(get('tag'));
  if (!tag) errors.push('tag is required');
  else if (existingTags.has(tag)) errors.push('tag #' + tag + ' already exists in an active flock');
  var sex = (get('sex') || '').toString().toLowerCase().trim();
  if (!sex) errors.push('sex is required');
  else if (VALID_SHEEP_SEX.indexOf(sex) < 0) errors.push('sex must be one of: ' + VALID_SHEEP_SEX.join(', '));
  var flock = (get('flock') || '').toString().toLowerCase().trim();
  if (!flock) errors.push('flock is required');
  else if (VALID_SHEEP_FLOCK.indexOf(flock) < 0) errors.push('flock must be one of: ' + VALID_SHEEP_FLOCK.join(', '));
  var pdate = parseImportDate(get('purchase_date'));
  if (pdate.error) errors.push('purchase_date: ' + pdate.error);
  var bdate = parseImportDate(get('birth_date'));
  if (bdate.error) errors.push('birth_date: ' + bdate.error);
  var ldate = parseImportDate(get('last_lambing_date'));
  if (ldate.error) errors.push('last_lambing_date: ' + ldate.error);
  var pamt = parseImportNumber(get('purchase_amount'));
  if (pamt.error) errors.push('purchase_amount: ' + pamt.error);
  var rwt = parseImportNumber(get('receiving_weight'));
  if (rwt.error) errors.push('receiving_weight: ' + rwt.error);
  if (rwt.value != null && !pdate.value)
    warnings.push('receiving_weight set but no purchase_date \u2014 weigh-in will be dated today');
  var tborn = parseImportNumber(get('total_born'));
  if (tborn.error) errors.push('total_born: ' + tborn.error);
  var bstatus = (get('breeding_status') || '').toString().trim();
  if (bstatus && VALID_BREED_STATUS.indexOf(bstatus) < 0) {
    var match = VALID_BREED_STATUS.find((x) => x.toLowerCase() === bstatus.toLowerCase());
    if (match) bstatus = match;
    else errors.push('breeding_status must be one of: ' + VALID_BREED_STATUS.join(', ') + ' (or blank)');
  }
  if (bstatus && sex && sex !== 'ewe')
    warnings.push('breeding_status set but sex is ' + sex + ' \u2014 will be dropped');
  return {
    rowIdx: rowIdx,
    raw: raw,
    parsed: {
      tag: tag,
      sex: sex,
      flock: flock,
      breed: get('breed') ? String(get('breed')).trim() : null,
      origin: get('origin') ? String(get('origin')).trim() : null,
      purchase_date: pdate.value || null,
      purchase_amount: pamt.value != null ? pamt.value : null,
      birth_date: bdate.value || null,
      dam_tag: get('dam_tag') ? String(get('dam_tag')).trim() : null,
      dam_reg_num: get('dam_reg_num') ? String(get('dam_reg_num')).trim() : null,
      sire_tag: get('sire_tag') ? String(get('sire_tag')).trim() : null,
      sire_reg_num: get('sire_reg_num') ? String(get('sire_reg_num')).trim() : null,
      registration_num: get('registration_num') ? String(get('registration_num')).trim() : null,
      breeding_status: bstatus || null,
      last_lambing_date: ldate.value || null,
      total_born: tborn.value != null ? Math.round(tborn.value) : null,
      receiving_weight: rwt.value != null ? rwt.value : null,
      comment: get('comment') ? String(get('comment')).trim() : null,
    },
    errors: errors,
    warnings: warnings,
  };
}

const SheepBulkImport = ({sb, breedOpts, originOpts, existingSheep, onClose, onComplete}) => {
  const {useState} = React;
  const [stage, setStage] = useState('start');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);
  const [progress, setProgress] = useState({done: 0, total: 0});
  const [results, setResults] = useState(null);

  const ACTIVE = ['rams', 'ewes', 'feeders'];
  const existingTags = new Set();
  (existingSheep || []).forEach((s) => {
    if (s.tag && ACTIVE.indexOf(s.flock) >= 0) existingTags.add(s.tag);
  });

  async function downloadTemplate() {
    setErr('');
    try {
      if (typeof XLSX === 'undefined') await window._wcfLoadXLSX();
      const wb = XLSX.utils.book_new();
      const blank = [SHEEP_IMPORT_COLUMNS.reduce((a, k) => ((a[k] = ''), a), {})];
      const ws = XLSX.utils.json_to_sheet(blank, {header: SHEEP_IMPORT_COLUMNS});
      SHEEP_IMPORT_COLUMNS.forEach((c, i) => {
        const addr = XLSX.utils.encode_cell({r: 1, c: i});
        if (ws[addr]) delete ws[addr];
      });
      ws['!ref'] = 'A1:' + XLSX.utils.encode_col(SHEEP_IMPORT_COLUMNS.length - 1) + '1';
      XLSX.utils.book_append_sheet(wb, ws, 'Sheep');
      const wsInst = XLSX.utils.aoa_to_sheet(SHEEP_IMPORT_INSTRUCTIONS);
      XLSX.utils.book_append_sheet(wb, wsInst, 'Instructions');
      const buf = XLSX.write(wb, {bookType: 'xlsx', type: 'array'});
      const blob = new Blob([buf], {type: 'application/octet-stream'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'WCF Sheep Import Template.xlsx';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        document.body.removeChild(a);
      }, 100);
    } catch (e) {
      setErr('Could not build template: ' + e.message);
    }
  }

  async function handleFile(file) {
    setErr('');
    if (!file) return;
    setBusy(true);
    try {
      if (typeof XLSX === 'undefined') await window._wcfLoadXLSX();
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, {type: 'array', cellDates: true});
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('First sheet is empty');
      const raw = XLSX.utils.sheet_to_json(ws, {defval: null});
      if (raw.length === 0) throw new Error('No data rows found in the first sheet');
      const validated = raw.map((r, i) => validateSheepImportRow(r, i + 2, existingTags));
      const seen = {};
      validated.forEach((v) => {
        const t = v.parsed.tag;
        if (t) seen[t] = (seen[t] || 0) + 1;
      });
      validated.forEach((v) => {
        if (v.parsed.tag && seen[v.parsed.tag] > 1) v.errors.push('duplicate tag inside this file');
      });
      setRows(validated);
      setStage('preview');
    } catch (e) {
      setErr('Could not read file: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    const ready = rows.filter((r) => r.errors.length === 0);
    if (ready.length === 0) {
      setErr('No rows are ready to commit. Fix errors first.');
      return;
    }
    setBusy(true);
    setStage('committing');
    setProgress({done: 0, total: ready.length});

    const knownBreeds = new Set((breedOpts || []).map((b) => (b.label || '').toUpperCase()));
    const knownOrigins = new Set((originOpts || []).map((o) => (o.label || '').toUpperCase()));
    const newBreeds = new Set(),
      newOrigins = new Set();
    ready.forEach((r) => {
      if (r.parsed.breed && !knownBreeds.has(r.parsed.breed.toUpperCase())) newBreeds.add(r.parsed.breed);
      if (r.parsed.origin && !knownOrigins.has(r.parsed.origin.toUpperCase())) newOrigins.add(r.parsed.origin);
    });
    for (const b of newBreeds) {
      const id =
        'breed-' +
        b
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      try {
        await sb.from('sheep_breeds').insert({id, label: b, active: true});
      } catch (_e) {
        /* concurrent insert race or already-exists OK */
      }
    }
    for (const o of newOrigins) {
      const id =
        'origin-' +
        o
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      try {
        await sb.from('sheep_origins').insert({id, label: o, active: true});
      } catch (_e) {
        /* concurrent insert race or already-exists OK */
      }
    }

    const log = [];
    let okCount = 0,
      failCount = 0;
    for (let i = 0; i < ready.length; i++) {
      const r = ready[i];
      const p = r.parsed;
      const sheepId = 's-' + p.tag + '-' + Math.random().toString(36).slice(2, 6);
      const isEwe = p.sex === 'ewe';
      const sheepRec = {
        id: sheepId,
        tag: p.tag,
        sex: p.sex,
        flock: p.flock,
        breed: p.breed,
        origin: p.origin,
        purchase_date: p.purchase_date,
        purchase_amount: p.purchase_amount,
        birth_date: p.birth_date,
        dam_tag: p.dam_tag,
        dam_reg_num: p.dam_reg_num,
        sire_tag: p.sire_tag,
        sire_reg_num: p.sire_reg_num,
        registration_num: p.registration_num,
        breeding_status: isEwe ? p.breeding_status : null,
        old_tags: [],
      };
      let rowOk = true,
        rowMsg = '';
      const ins = await sb.from('sheep').insert(sheepRec);
      if (ins.error) {
        rowOk = false;
        rowMsg = 'sheep insert: ' + ins.error.message;
      }

      if (rowOk && p.last_lambing_date) {
        const lambIns = await sb.from('sheep_lambing_records').insert({
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          dam_tag: p.tag,
          lambing_date: p.last_lambing_date,
          total_born: p.total_born != null ? p.total_born : 0,
          deaths: 0,
          complications_flag: false,
        });
        if (lambIns.error) rowMsg += (rowMsg ? ' | ' : '') + 'lambing: ' + lambIns.error.message;
      }

      if (rowOk && p.comment) {
        const cmtIns = await sb.from('sheep_comments').insert({
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          sheep_id: sheepId,
          sheep_tag: p.tag,
          comment: p.comment,
          team_member: 'Import',
          source: 'import',
        });
        if (cmtIns.error) rowMsg += (rowMsg ? ' | ' : '') + 'comment: ' + cmtIns.error.message;
      }

      if (rowOk && p.receiving_weight != null) {
        const wsessId = 'wsess-rcv-' + sheepId;
        const sessIns = await sb.from('weigh_in_sessions').insert({
          id: wsessId,
          date: p.purchase_date || new Date().toISOString().slice(0, 10),
          team_member: 'Import',
          species: 'sheep',
          herd: p.flock,
          status: 'complete',
          notes: 'Receiving weight (bulk import)',
        });
        if (!sessIns.error) {
          const wiIns = await sb.from('weigh_ins').insert({
            id: 'win-rcv-' + sheepId,
            session_id: wsessId,
            tag: p.tag,
            weight: p.receiving_weight,
            note: 'Receiving weight (bulk import)',
          });
          if (wiIns.error) rowMsg += (rowMsg ? ' | ' : '') + 'weigh-in: ' + wiIns.error.message;
        } else {
          rowMsg += (rowMsg ? ' | ' : '') + 'wsess: ' + sessIns.error.message;
        }
      }

      if (rowOk) okCount++;
      else failCount++;
      log.push({tag: p.tag, ok: rowOk, msg: rowMsg});
      setProgress({done: i + 1, total: ready.length});
    }
    setResults({okCount, failCount, log, skipped: rows.length - ready.length});
    setStage('done');
    setBusy(false);
  }

  const btnPrimary = {
    padding: '9px 18px',
    borderRadius: 8,
    border: 'none',
    background: '#0f766e',
    color: 'white',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
  const btnSecondary = {
    padding: '9px 18px',
    borderRadius: 8,
    border: '1px solid var(--border-strong)',
    background: 'white',
    color: 'var(--ink)',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };

  const readyCount = rows.filter((r) => r.errors.length === 0).length;
  const errorCount = rows.filter((r) => r.errors.length > 0).length;
  const warnCount = rows.filter((r) => r.warnings.length > 0 && r.errors.length === 0).length;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '2rem 1rem',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 1100,
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <h2 style={{margin: 0, fontSize: 16, color: '#0f766e', fontWeight: 700}}>
            {'\ud83d\udce5'} Bulk Import Sheep
          </h2>
          <button
            onClick={onClose}
            style={{background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--ink-muted)'}}
            aria-label="Close"
          >
            {'\u00d7'}
          </button>
        </div>
        <div style={{padding: '20px'}}>
          {err && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#991b1b',
                padding: '10px 14px',
                borderRadius: 8,
                marginBottom: 14,
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}

          {stage === 'start' && (
            <div>
              <p style={{fontSize: 13, color: 'var(--ink-muted)', marginTop: 0}}>
                Upload an xlsx with one row per sheep. Use the WCF template (download below). The Instructions sheet
                documents every column.
              </p>
              <ol style={{fontSize: 13, color: 'var(--ink-muted)', paddingLeft: 20, lineHeight: 1.7}}>
                <li>Download the template (or use a pre-seeded one).</li>
                <li>Fill one row per sheep. Required: tag, sex, flock.</li>
                <li>Upload it back. You'll see a per-row preview before anything is written.</li>
              </ol>
              <div style={{display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap'}}>
                <button onClick={downloadTemplate} style={btnSecondary}>
                  {'\u2b07'} Download Template
                </button>
                <label style={{...btnPrimary, display: 'inline-block'}}>
                  {'\u2b06'} Upload Filled Template
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => handleFile(e.target.files[0])}
                    style={{display: 'none'}}
                  />
                </label>
              </div>
              <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 14, lineHeight: 1.5}}>
                Tip: this importer auto-creates new breeds and origins on commit, so you can type a new selling-farm
                name without setting it up first.
              </div>
            </div>
          )}

          {stage === 'preview' && (
            <div>
              <div style={{display: 'flex', gap: 14, fontSize: 13, marginBottom: 14, flexWrap: 'wrap'}}>
                <span
                  style={{
                    padding: '4px 10px',
                    background: '#dcfce7',
                    color: '#166534',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  {'\u2713'} {readyCount} ready
                </span>
                {warnCount > 0 && (
                  <span
                    style={{
                      padding: '4px 10px',
                      background: '#fef3c7',
                      color: '#92400e',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    {'\u26a0'} {warnCount} with warnings
                  </span>
                )}
                {errorCount > 0 && (
                  <span
                    style={{
                      padding: '4px 10px',
                      background: '#fef2f2',
                      color: '#991b1b',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    {'\u2717'} {errorCount} with errors (will skip)
                  </span>
                )}
              </div>
              <div style={{maxHeight: '55vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12}}>
                  <thead style={{position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 1}}>
                    <tr>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Row
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Status
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Tag
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Sex
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Flock
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Breed
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Origin
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Extras
                      </th>
                      <th
                        style={{
                          padding: '8px 10px',
                          textAlign: 'left',
                          borderBottom: '1px solid var(--border)',
                          fontWeight: 600,
                          color: 'var(--ink-muted)',
                        }}
                      >
                        Issues
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const hasErr = r.errors.length > 0;
                      const hasWarn = r.warnings.length > 0;
                      const bg = hasErr ? '#fef2f2' : hasWarn ? '#fffbeb' : 'white';
                      const extras = [];
                      if (r.parsed.last_lambing_date)
                        extras.push(
                          'lambing ' +
                            r.parsed.last_lambing_date +
                            (r.parsed.total_born ? ' (' + r.parsed.total_born + ' born)' : ''),
                        );
                      if (r.parsed.receiving_weight != null)
                        extras.push('weigh-in ' + r.parsed.receiving_weight + ' lb');
                      if (r.parsed.comment) {
                        const c = r.parsed.comment;
                        extras.push('\u201c' + (c.length > 60 ? c.slice(0, 60) + '\u2026' : c) + '\u201d');
                      }
                      return (
                        <tr key={i} style={{background: bg, borderBottom: '1px solid var(--divider)'}}>
                          <td
                            style={{padding: '6px 10px', color: 'var(--ink-faint)', fontVariantNumeric: 'tabular-nums'}}
                          >
                            {r.rowIdx}
                          </td>
                          <td style={{padding: '6px 10px'}}>
                            {hasErr ? (
                              <span style={{color: '#991b1b', fontWeight: 600}}>{'\u2717'} skip</span>
                            ) : hasWarn ? (
                              <span style={{color: '#92400e', fontWeight: 600}}>{'\u26a0'} ready</span>
                            ) : (
                              <span style={{color: '#166534', fontWeight: 600}}>{'\u2713'} ready</span>
                            )}
                          </td>
                          <td style={{padding: '6px 10px', fontWeight: 600}}>{r.parsed.tag || '\u2014'}</td>
                          <td style={{padding: '6px 10px'}}>{r.parsed.sex || '\u2014'}</td>
                          <td style={{padding: '6px 10px'}}>{r.parsed.flock || '\u2014'}</td>
                          <td style={{padding: '6px 10px'}}>{r.parsed.breed || '\u2014'}</td>
                          <td style={{padding: '6px 10px'}}>{r.parsed.origin || '\u2014'}</td>
                          <td style={{padding: '6px 10px', color: 'var(--ink-muted)'}}>
                            {extras.length ? extras.join(' \u00b7 ') : '\u2014'}
                          </td>
                          <td style={{padding: '6px 10px', color: hasErr ? '#991b1b' : '#92400e', fontSize: 11}}>
                            {[...r.errors, ...r.warnings].join('; ') || '\u2014'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 16}}>
                <button onClick={() => setStage('start')} style={btnSecondary} disabled={busy}>
                  Back
                </button>
                <button
                  onClick={commit}
                  style={{
                    ...btnPrimary,
                    opacity: readyCount === 0 ? 0.5 : 1,
                    cursor: readyCount === 0 ? 'not-allowed' : 'pointer',
                  }}
                  disabled={busy || readyCount === 0}
                >
                  Commit {readyCount} row{readyCount === 1 ? '' : 's'}
                </button>
              </div>
            </div>
          )}

          {stage === 'committing' && (
            <div style={{textAlign: 'center', padding: '2rem 0'}}>
              <div style={{fontSize: 14, color: 'var(--ink-muted)', marginBottom: 14}}>
                Importing {progress.done} of {progress.total}
                {'\u2026'}
              </div>
              <div
                style={{
                  height: 8,
                  background: 'var(--divider)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  maxWidth: 400,
                  margin: '0 auto',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    background: '#0f766e',
                    width: (progress.total ? (progress.done / progress.total) * 100 : 0) + '%',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          )}

          {stage === 'done' && results && (
            <div>
              <div style={{display: 'flex', gap: 14, fontSize: 13, marginBottom: 16, flexWrap: 'wrap'}}>
                <span
                  style={{
                    padding: '6px 12px',
                    background: '#dcfce7',
                    color: '#166534',
                    borderRadius: 6,
                    fontWeight: 600,
                  }}
                >
                  {'\u2713'} {results.okCount} imported
                </span>
                {results.failCount > 0 && (
                  <span
                    style={{
                      padding: '6px 12px',
                      background: '#fef2f2',
                      color: '#991b1b',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    {'\u2717'} {results.failCount} failed
                  </span>
                )}
                {results.skipped > 0 && (
                  <span
                    style={{
                      padding: '6px 12px',
                      background: '#f3f4f6',
                      color: '#4b5563',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    skipped {results.skipped} with errors
                  </span>
                )}
              </div>
              <div
                style={{
                  maxHeight: '40vh',
                  overflowY: 'auto',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '10px 14px',
                }}
              >
                {results.log.map((l, i) => (
                  <div key={i} style={{fontSize: 12, padding: '3px 0', color: l.ok ? 'var(--ink)' : '#991b1b'}}>
                    {l.ok ? '\u2713' : '\u2717'} #{l.tag}
                    {l.msg ? ' \u2014 ' + l.msg : ''}
                  </div>
                ))}
              </div>
              <div style={{display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 16}}>
                <button
                  onClick={() => {
                    onComplete && onComplete();
                    onClose();
                  }}
                  style={btnPrimary}
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {busy && stage !== 'committing' && (
            <div style={{textAlign: 'center', padding: 14, color: 'var(--ink-muted)', fontSize: 13}}>
              Working{'\u2026'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SheepBulkImport;
