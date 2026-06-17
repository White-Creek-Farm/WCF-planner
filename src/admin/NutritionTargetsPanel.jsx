// Phase 2 Round 4 extraction (verbatim).
import React from 'react';
import DeleteModal from '../shared/DeleteModal.jsx';

const NutritionTargetsPanel = ({sb}) => {
  const [rows, setRows] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [savingHerd, setSavingHerd] = React.useState(null);
  const saveTimers = React.useRef({});
  const HERDS = ['mommas', 'backgrounders', 'finishers', 'bulls'];
  const HERD_LABELS = {mommas: 'Mommas', backgrounders: 'Backgrounders', finishers: 'Finishers', bulls: 'Bulls'};

  async function loadTargets() {
    const {data, error} = await sb.from('cattle_nutrition_targets').select('*');
    if (!error && data) {
      const m = {};
      data.forEach((r) => {
        m[r.herd] = r;
      });
      setRows(m);
    }
    setLoading(false);
  }
  React.useEffect(() => {
    loadTargets();
  }, []);

  function upd(herd, field, value) {
    const row = {...(rows[herd] || {herd}), [field]: value};
    setRows({...rows, [herd]: row});
    clearTimeout(saveTimers.current[herd]);
    saveTimers.current[herd] = setTimeout(() => saveRow(row), 800);
  }
  async function saveRow(row) {
    setSavingHerd(row.herd);
    const rec = {
      herd: row.herd,
      target_dm_pct_body:
        row.target_dm_pct_body !== '' && row.target_dm_pct_body != null ? parseFloat(row.target_dm_pct_body) : 0,
      target_cp_pct_dm:
        row.target_cp_pct_dm !== '' && row.target_cp_pct_dm != null ? parseFloat(row.target_cp_pct_dm) : 0,
      target_nfc_pct_dm:
        row.target_nfc_pct_dm !== '' && row.target_nfc_pct_dm != null ? parseFloat(row.target_nfc_pct_dm) : 0,
      fallback_cow_weight_lbs:
        row.fallback_cow_weight_lbs !== '' && row.fallback_cow_weight_lbs != null
          ? parseFloat(row.fallback_cow_weight_lbs)
          : 0,
      notes: row.notes || null,
    };
    await sb.from('cattle_nutrition_targets').upsert(rec, {onConflict: 'herd'});
    setSavingHerd(null);
  }

  const inpS = {
    fontSize: 13,
    padding: '5px 8px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    width: 80,
    textAlign: 'right',
    boxSizing: 'border-box',
  };
  const wideInp = {...inpS, width: 100, textAlign: 'left'};
  const wideInpNotes = {...inpS, width: '100%', textAlign: 'left'};

  return (
    <div style={{marginTop: 16}}>
      <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '20px'}}>
        <div style={{marginBottom: 4}}>
          <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 2}}>Nutrition Targets</div>
          <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
            Per-herd daily intake targets used by the dashboard rolling-window comparison and the recommendation engine.
          </div>
        </div>
        <div style={{height: 1, background: 'var(--border)', margin: '14px 0'}} />

        {loading && (
          <div style={{textAlign: 'center', padding: '1rem', color: 'var(--ink-faint)', fontSize: 13}}>
            Loading targets{'\u2026'}
          </div>
        )}
        {!loading && (
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 700}}>
              <thead>
                <tr style={{background: 'var(--surface-2)', borderBottom: '1px solid var(--border)'}}>
                  <th
                    style={{
                      padding: '8px 10px',
                      textAlign: 'left',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Herd
                  </th>
                  <th
                    style={{
                      padding: '8px 10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Target DM % body
                  </th>
                  <th
                    style={{
                      padding: '8px 10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Target CP % DM
                  </th>
                  <th
                    style={{
                      padding: '8px 10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Target NFC % DM
                  </th>
                  <th
                    style={{
                      padding: '8px 10px',
                      textAlign: 'left',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Notes
                  </th>
                  <th style={{padding: '8px 10px', width: 60}}></th>
                </tr>
              </thead>
              <tbody>
                {HERDS.map((h, i) => {
                  const r = rows[h] || {herd: h};
                  return (
                    <tr
                      key={h}
                      style={{borderBottom: '1px solid var(--divider)', background: i % 2 === 0 ? 'white' : '#fafafa'}}
                    >
                      <td style={{padding: '8px 10px', fontWeight: 700, color: 'var(--ink)'}}>{HERD_LABELS[h]}</td>
                      <td style={{padding: '8px 10px', textAlign: 'right'}}>
                        <input
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                          value={r.target_dm_pct_body != null ? r.target_dm_pct_body : ''}
                          onChange={(e) => upd(h, 'target_dm_pct_body', e.target.value)}
                          style={inpS}
                        />
                      </td>
                      <td style={{padding: '8px 10px', textAlign: 'right'}}>
                        <input
                          type="number"
                          min="0"
                          max="50"
                          step="0.1"
                          value={r.target_cp_pct_dm != null ? r.target_cp_pct_dm : ''}
                          onChange={(e) => upd(h, 'target_cp_pct_dm', e.target.value)}
                          style={inpS}
                        />
                      </td>
                      <td style={{padding: '8px 10px', textAlign: 'right'}}>
                        <input
                          type="number"
                          min="0"
                          max="80"
                          step="0.1"
                          value={r.target_nfc_pct_dm != null ? r.target_nfc_pct_dm : ''}
                          onChange={(e) => upd(h, 'target_nfc_pct_dm', e.target.value)}
                          style={inpS}
                        />
                      </td>
                      <td style={{padding: '8px 10px'}}>
                        <input
                          type="text"
                          value={r.notes || ''}
                          onChange={(e) => upd(h, 'notes', e.target.value)}
                          placeholder="Optional"
                          style={wideInpNotes}
                        />
                      </td>
                      <td
                        style={{
                          padding: '8px 10px',
                          textAlign: 'center',
                          fontSize: 10,
                          color: savingHerd === h ? '#065f46' : 'var(--ink-faint)',
                          fontWeight: 600,
                        }}
                      >
                        {savingHerd === h ? 'Saving\u2026' : '\u2713'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default NutritionTargetsPanel;
