// FuelBillsView — admin Bills tab. Upload a fuel-supplier invoice (Home Oil
// PDF), parse it, edit fields if needed, save.
//
// fuel_bills + fuel_bill_lines tables live behind authenticated RLS.
// PDF storage: admin-only `fuel-bills` bucket (created by migration 026,
// public=false).

import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';
import {deleteFuelBill} from '../lib/fuelBillDeleteApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';

const FUEL_TYPES = [
  {value: 'diesel', label: 'Diesel'},
  {value: 'gasoline', label: 'Gasoline'},
  {value: 'def', label: 'DEF'},
];

function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${m}/${d}/${y.slice(2)}`;
}
function money(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export default function FuelBillsView() {
  const [bills, setBills] = React.useState([]);
  const [linesByBill, setLinesByBill] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [missingSchema, setMissingSchema] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(null);

  async function load() {
    setLoading(true);
    const {data, error} = await sb.from('fuel_bills').select('*').order('delivery_date', {ascending: false}).limit(500);
    if (error && /does not exist|relation/i.test(error.message || '')) {
      setMissingSchema(true);
      setLoading(false);
      return;
    }
    setBills(data || []);
    if (data && data.length) {
      const ids = data.map((b) => b.id);
      const {data: lns} = await sb.from('fuel_bill_lines').select('*').in('bill_id', ids);
      const map = {};
      for (const ln of lns || []) {
        if (!map[ln.bill_id]) map[ln.bill_id] = [];
        map[ln.bill_id].push(ln);
      }
      setLinesByBill(map);
    }
    setLoading(false);
  }
  React.useEffect(() => {
    load();
  }, []);

  if (missingSchema) {
    return (
      <div style={{padding: 20, fontSize: 13, color: '#b91c1c'}}>
        fuel_bills table missing. Apply supabase-migrations/026_fuel_bills.sql in the SQL Editor first.
      </div>
    );
  }
  if (loading) return <div style={{padding: 20, fontSize: 13, color: 'var(--ink-muted)'}}>Loading bills…</div>;

  const card = {
    background: 'white',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 18px',
    marginBottom: 14,
  };
  const th = {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    padding: '6px 10px',
    textAlign: 'left',
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--border)',
  };
  const td = {fontSize: 12, padding: '8px 10px', borderBottom: '1px solid var(--divider)', color: 'var(--ink)'};

  return (
    <div>
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
        <div
          style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', textTransform: 'uppercase', letterSpacing: 0.4}}
        >
          Fuel Bills <span style={{color: 'var(--ink-faint)', fontWeight: 500}}>({bills.length} on file)</span>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: '#085041',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Upload bill
        </button>
      </div>

      {uploadOpen && (
        <BillUploadModal
          onClose={() => setUploadOpen(false)}
          onSaved={() => {
            setUploadOpen(false);
            load();
          }}
        />
      )}

      <div style={{...card, padding: 0, overflow: 'hidden'}}>
        {bills.length === 0 ? (
          <div style={{padding: 24, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
            No bills uploaded yet. Click "+ Upload bill" to parse one.
          </div>
        ) : (
          <table style={{width: '100%', borderCollapse: 'collapse'}}>
            <thead>
              <tr>
                <th style={th}>Delivery</th>
                <th style={th}>Invoice</th>
                <th style={th}>Supplier</th>
                <th style={{...th, textAlign: 'right'}}>Gallons</th>
                <th style={{...th, textAlign: 'right'}}>Subtotal</th>
                <th style={{...th, textAlign: 'right'}}>Tax</th>
                <th style={{...th, textAlign: 'right'}}>Total</th>
                <th style={th}>PDF</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const lines = linesByBill[b.id] || [];
                const totalGal = lines.reduce((s, l) => s + (Number(l.net_units) || 0), 0);
                const open = expanded === b.id;
                return (
                  <React.Fragment key={b.id}>
                    <tr
                      style={{cursor: 'pointer'}}
                      {...openableProps(() => setExpanded(open ? null : b.id))}
                      className="hoverable-row"
                    >
                      <td style={td}>{fmtDate(b.delivery_date)}</td>
                      <td style={{...td, fontWeight: 600}}>{b.invoice_number || '—'}</td>
                      <td style={{...td, color: 'var(--ink-muted)'}}>{b.supplier || '—'}</td>
                      <td style={{...td, textAlign: 'right', color: '#1e40af', fontWeight: 600}}>
                        {Math.round(totalGal).toLocaleString()}
                      </td>
                      <td style={{...td, textAlign: 'right', color: 'var(--ink-muted)'}}>{money(b.subtotal)}</td>
                      <td style={{...td, textAlign: 'right', color: '#9a3412'}}>{money(b.tax_total)}</td>
                      <td style={{...td, textAlign: 'right', color: '#065f46', fontWeight: 700}}>{money(b.total)}</td>
                      <td style={td}>{b.pdf_path ? <PdfLink path={b.pdf_path} /> : '—'}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td
                          colSpan={8}
                          style={{padding: 0, background: '#fafafa', borderBottom: '1px solid var(--border)'}}
                        >
                          <BillDetail bill={b} lines={lines} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PdfLink({path}) {
  const [url, setUrl] = React.useState(null);
  const [openNotice, setOpenNotice] = React.useState(null);
  async function open(e) {
    e.stopPropagation();
    setOpenNotice(null);
    if (!url) {
      const {data, error} = await sb.storage.from('fuel-bills').createSignedUrl(path, 600);
      if (error) {
        setOpenNotice({kind: 'error', message: 'Cannot open PDF: ' + error.message});
        return;
      }
      setUrl(data.signedUrl);
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
  return (
    <div style={{display: 'inline-flex', flexDirection: 'column', gap: 4}}>
      <button
        onClick={open}
        style={{
          fontSize: 11,
          color: 'var(--brand)',
          background: 'none',
          border: 'none',
          textDecoration: 'underline',
          cursor: 'pointer',
          fontFamily: 'inherit',
          padding: 0,
        }}
      >
        📄 View
      </button>
      {openNotice && <InlineNotice notice={openNotice} onDismiss={() => setOpenNotice(null)} />}
    </div>
  );
}

function BillDetail({bill, lines, onChanged}) {
  const [busy, setBusy] = React.useState(false);
  const [deleteNotice, setDeleteNotice] = React.useState(null);
  async function del() {
    window._wcfConfirmDelete(
      'Delete this bill (and its ' +
        lines.length +
        ' line item' +
        (lines.length === 1 ? '' : 's') +
        ')? PDF will also be removed from storage.',
      async () => {
        setDeleteNotice(null);
        setBusy(true);
        // Transactional SECDEF delete (mig 107): deletes the fuel_bills root +
        // cascades fuel_bill_lines + writes one record.deleted Activity event.
        const r = await deleteFuelBill(sb, bill.id);
        if (!r || !r.ok) {
          setBusy(false);
          const why =
            r && r.reason === 'no_bill'
              ? 'Bill no longer exists (already deleted).'
              : (r && (r.error || r.reason)) || 'unknown error';
          setDeleteNotice({kind: 'error', message: 'Delete failed: ' + why});
          return;
        }
        // Best-effort storage PDF removal, ordered AFTER the RPC succeeds so a
        // failed delete never orphan-removes the PDF. A storage failure here
        // does not fail the delete (the bill row + lines are already gone) and
        // must not strand the Delete button busy or skip onChanged() — wrap so
        // a rejecting remove() can't throw out of the fire-and-forget onConfirm.
        if (bill.pdf_path) {
          try {
            await sb.storage.from('fuel-bills').remove([bill.pdf_path]);
          } catch (_e) {
            /* best-effort cleanup; the bill + lines are already deleted */
          }
        }
        setBusy(false);
        onChanged();
      },
    );
  }
  const td = {fontSize: 11, padding: '5px 10px', color: 'var(--ink)'};
  const th = {
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    padding: '5px 10px',
    textAlign: 'left',
  };
  return (
    <div style={{padding: '14px 18px'}}>
      <InlineNotice notice={deleteNotice} onDismiss={() => setDeleteNotice(null)} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 10,
          fontSize: 11,
          marginBottom: 10,
        }}
      >
        <div>
          <span style={{color: 'var(--ink-faint)'}}>Invoice date</span>
          <div style={{fontWeight: 600}}>{fmtDate(bill.invoice_date)}</div>
        </div>
        <div>
          <span style={{color: 'var(--ink-faint)'}}>Delivery</span>
          <div style={{fontWeight: 600}}>{fmtDate(bill.delivery_date)}</div>
        </div>
        <div>
          <span style={{color: 'var(--ink-faint)'}}>BOL #</span>
          <div style={{fontWeight: 600}}>{bill.bol_number || '—'}</div>
        </div>
        <div>
          <span style={{color: 'var(--ink-faint)'}}>Subtotal</span>
          <div style={{fontWeight: 600}}>{money(bill.subtotal)}</div>
        </div>
        <div>
          <span style={{color: 'var(--ink-faint)'}}>Tax</span>
          <div style={{fontWeight: 600}}>{money(bill.tax_total)}</div>
        </div>
        <div>
          <span style={{color: 'var(--ink-faint)'}}>Total</span>
          <div style={{fontWeight: 600, color: '#065f46'}}>{money(bill.total)}</div>
        </div>
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <thead>
          <tr>
            <th style={th}>Description</th>
            <th style={th}>Type</th>
            <th style={{...th, textAlign: 'right'}}>Gross</th>
            <th style={{...th, textAlign: 'right'}}>Net (gal)</th>
            <th style={{...th, textAlign: 'right'}}>Unit price</th>
            <th style={{...th, textAlign: 'right'}}>Subtotal</th>
            <th style={{...th, textAlign: 'right'}}>Tax</th>
            <th style={{...th, textAlign: 'right'}}>Total</th>
            <th style={{...th, textAlign: 'right'}}>Effective $/gal</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td style={td}>{l.description || '—'}</td>
              <td style={td}>{l.fuel_type || '?'}</td>
              <td style={{...td, textAlign: 'right'}}>
                {l.gross_units != null ? Number(l.gross_units).toLocaleString() : '—'}
              </td>
              <td style={{...td, textAlign: 'right', fontWeight: 600}}>
                {l.net_units != null ? Number(l.net_units).toLocaleString() : '—'}
              </td>
              <td style={{...td, textAlign: 'right'}}>
                {l.unit_price != null ? '$' + Number(l.unit_price).toFixed(4) : '—'}
              </td>
              <td style={{...td, textAlign: 'right'}}>{money(l.line_subtotal)}</td>
              <td style={{...td, textAlign: 'right', color: '#9a3412'}}>{money(l.allocated_tax)}</td>
              <td style={{...td, textAlign: 'right', fontWeight: 600}}>{money(l.line_total)}</td>
              <td style={{...td, textAlign: 'right', color: '#065f46', fontWeight: 700}}>
                {l.effective_per_gal != null ? '$' + Number(l.effective_per_gal).toFixed(4) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{marginTop: 10, display: 'flex'}}>
        <button
          onClick={del}
          disabled={busy}
          style={{
            marginLeft: 'auto',
            padding: '5px 12px',
            borderRadius: 5,
            border: '1px solid #fecaca',
            background: 'white',
            color: '#b91c1c',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Delete bill
        </button>
      </div>
    </div>
  );
}

// Modal: pick a PDF, click Parse, review/edit, save.
function BillUploadModal({onClose, onSaved}) {
  const [file, setFile] = React.useState(null);
  const [parsing, setParsing] = React.useState(false);
  const [parsed, setParsed] = React.useState(null); // {header, lines, warnings, rawText}
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  async function pickAndParse(f) {
    setFile(f);
    setErr('');
    setParsed(null);
    if (!f) return;
    setParsing(true);
    try {
      const {parseFuelBillPdf} = await import('../lib/fuelBillParser.js');
      const out = await parseFuelBillPdf(f);
      setParsed(out);
    } catch (e) {
      setErr('Parse failed: ' + (e.message || e));
    } finally {
      setParsing(false);
    }
  }

  function setHeader(k, v) {
    setParsed((p) => ({...p, header: {...p.header, [k]: v}}));
  }
  function setLine(i, k, v) {
    setParsed((p) => ({...p, lines: p.lines.map((l, j) => (j === i ? {...l, [k]: v} : l))}));
  }

  async function save() {
    setErr('');
    if (!parsed || !parsed.lines.length) {
      setErr('Nothing to save — parse a PDF first.');
      return;
    }
    if (!parsed.header.total) {
      setErr('Invoice total is required.');
      return;
    }
    if (!parsed.header.delivery_date) {
      setErr('Delivery date is required for monthly reconciliation.');
      return;
    }
    // Reconciliation cost adds line_total even when fuel_type is null, but
    // the gallons land in no fuel-type column. Force a fuel_type per line so
    // month totals stay coherent.
    const unclassified = parsed.lines.filter((l) => !l.fuel_type);
    if (unclassified.length > 0) {
      setErr(
        `${unclassified.length} line${unclassified.length === 1 ? '' : 's'} missing fuel type — pick one for each before save.`,
      );
      return;
    }
    setBusy(true);

    const id = 'fb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let pdf_path = null;
    let pdfUploaded = false;
    let billInserted = false;

    // Roll back partial state on any post-PDF failure so the next retry
    // starts clean (no orphan bill row + no orphan PDF in storage).
    async function rollback(reason) {
      if (billInserted) {
        // ON DELETE CASCADE on fuel_bill_lines.bill_id clears any partial lines.
        await sb.from('fuel_bills').delete().eq('id', id);
      }
      if (pdfUploaded && pdf_path) {
        await sb.storage.from('fuel-bills').remove([pdf_path]);
      }
      setErr(reason);
      setBusy(false);
    }

    if (file) {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      pdf_path = id + '/' + safeName;
      const {error: upErr} = await sb.storage.from('fuel-bills').upload(pdf_path, file, {upsert: false});
      if (upErr) {
        setErr('PDF upload failed: ' + upErr.message);
        setBusy(false);
        return;
      }
      pdfUploaded = true;
    }

    const {error: bErr} = await sb.from('fuel_bills').insert({
      id,
      supplier: parsed.header.supplier || null,
      invoice_number: parsed.header.invoice_number || null,
      invoice_date: parsed.header.invoice_date || null,
      delivery_date: parsed.header.delivery_date,
      bol_number: parsed.header.bol_number || null,
      subtotal: parsed.header.subtotal != null ? Number(parsed.header.subtotal) : null,
      tax_total: parsed.header.tax_total != null ? Number(parsed.header.tax_total) : null,
      total: Number(parsed.header.total),
      pdf_path,
      parsed_data: {warnings: parsed.warnings, rawTextLength: parsed.rawText ? parsed.rawText.length : 0},
      notes: null,
    });
    if (bErr) {
      await rollback('Bill insert failed: ' + bErr.message);
      return;
    }
    billInserted = true;

    const lineRows = parsed.lines.map((l, i) => ({
      id: 'fbl-' + id + '-' + i,
      bill_id: id,
      description: l.description || null,
      fuel_type: l.fuel_type || null,
      gross_units: l.gross_units != null ? Number(l.gross_units) : null,
      net_units: l.net_units != null ? Number(l.net_units) : null,
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      line_subtotal: l.line_subtotal != null ? Number(l.line_subtotal) : null,
      allocated_tax: l.allocated_tax != null ? Number(l.allocated_tax) : null,
      line_total: l.line_total != null ? Number(l.line_total) : null,
      effective_per_gal: l.effective_per_gal != null ? Number(l.effective_per_gal) : null,
    }));
    if (lineRows.length) {
      const {error: lErr} = await sb.from('fuel_bill_lines').insert(lineRows);
      if (lErr) {
        await rollback('Line items failed: ' + lErr.message);
        return;
      }
    }

    setBusy(false);
    onSaved();
  }

  const inp = {
    fontSize: 13,
    padding: '6px 9px',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {
    fontSize: 10,
    color: 'var(--ink-muted)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 3,
    display: 'block',
  };
  const td = {fontSize: 11, padding: '5px 8px'};

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,.6)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '24px 16px',
        overflowY: 'auto',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 14,
          width: '100%',
          maxWidth: 980,
          boxShadow: '0 20px 40px rgba(0,0,0,.3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{flex: 1}}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--ink-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              Upload
            </div>
            <div style={{fontSize: 16, fontWeight: 700, color: 'var(--ink)'}}>Fuel Bill (PDF)</div>
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 14,
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            ✕ Close
          </button>
        </div>

        <div style={{padding: '16px 20px'}}>
          <div
            style={{
              padding: 14,
              border: '1px dashed var(--border-strong)',
              borderRadius: 8,
              background: '#fafafa',
              marginBottom: 14,
            }}
          >
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => pickAndParse(e.target.files && e.target.files[0])}
            />
            {file && (
              <span style={{marginLeft: 10, fontSize: 12, color: 'var(--ink-muted)'}}>
                {file.name} · {Math.round(file.size / 1024)} KB
              </span>
            )}
            {parsing && <span style={{marginLeft: 10, fontSize: 12, color: '#1d4ed8'}}>Parsing…</span>}
          </div>

          {parsed && parsed.warnings.length > 0 && (
            <div
              style={{
                padding: '10px 14px',
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 8,
                marginBottom: 14,
                fontSize: 12,
                color: '#92400e',
              }}
            >
              <div style={{fontWeight: 700, marginBottom: 4}}>⚠ Parser warnings</div>
              <ul style={{margin: 0, paddingLeft: 20}}>
                {parsed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {parsed && (
            <>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--ink-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Header
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                  marginBottom: 14,
                }}
              >
                <div>
                  <label style={lbl}>Supplier</label>
                  <input
                    style={inp}
                    value={parsed.header.supplier || ''}
                    onChange={(e) => setHeader('supplier', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Invoice #</label>
                  <input
                    style={inp}
                    value={parsed.header.invoice_number || ''}
                    onChange={(e) => setHeader('invoice_number', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Invoice date</label>
                  <input
                    type="date"
                    style={inp}
                    value={parsed.header.invoice_date || ''}
                    onChange={(e) => setHeader('invoice_date', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Delivery date *</label>
                  <input
                    type="date"
                    style={inp}
                    value={parsed.header.delivery_date || ''}
                    onChange={(e) => setHeader('delivery_date', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>BOL #</label>
                  <input
                    style={inp}
                    value={parsed.header.bol_number || ''}
                    onChange={(e) => setHeader('bol_number', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Subtotal</label>
                  <input
                    type="number"
                    step="0.01"
                    style={inp}
                    value={parsed.header.subtotal || ''}
                    onChange={(e) => setHeader('subtotal', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Tax</label>
                  <input
                    type="number"
                    step="0.01"
                    style={inp}
                    value={parsed.header.tax_total || ''}
                    onChange={(e) => setHeader('tax_total', e.target.value)}
                  />
                </div>
                <div>
                  <label style={lbl}>Total *</label>
                  <input
                    type="number"
                    step="0.01"
                    style={inp}
                    value={parsed.header.total || ''}
                    onChange={(e) => setHeader('total', e.target.value)}
                  />
                </div>
              </div>

              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--ink-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 8,
                }}
              >
                Line items <span style={{color: 'var(--ink-faint)', fontWeight: 400}}>({parsed.lines.length})</span>
              </div>
              <div style={{overflowX: 'auto', marginBottom: 14}}>
                <table style={{width: '100%', borderCollapse: 'collapse', minWidth: 780}}>
                  <thead style={{background: 'var(--surface-2)'}}>
                    <tr>
                      <th style={{...td, textAlign: 'left'}}>Description</th>
                      <th style={{...td, textAlign: 'left'}}>Type</th>
                      <th style={{...td, textAlign: 'right'}}>Gross</th>
                      <th style={{...td, textAlign: 'right'}}>Net (gal)</th>
                      <th style={{...td, textAlign: 'right'}}>$/gal</th>
                      <th style={{...td, textAlign: 'right'}}>Subtotal</th>
                      <th style={{...td, textAlign: 'right'}}>Tax</th>
                      <th style={{...td, textAlign: 'right'}}>Total</th>
                      <th style={{...td, textAlign: 'right'}}>Eff $/gal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.lines.map((l, i) => (
                      <tr key={i} style={{borderTop: '1px solid var(--divider)'}}>
                        <td style={td}>
                          <input
                            style={{...inp, fontSize: 11}}
                            value={l.description || ''}
                            onChange={(e) => setLine(i, 'description', e.target.value)}
                          />
                        </td>
                        <td style={td}>
                          <select
                            style={{...inp, fontSize: 11}}
                            value={l.fuel_type || ''}
                            onChange={(e) => setLine(i, 'fuel_type', e.target.value)}
                          >
                            <option value="">(pick)</option>
                            {FUEL_TYPES.map((f) => (
                              <option key={f.value} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{...td, textAlign: 'right'}}>
                          {l.gross_units != null ? Number(l.gross_units).toLocaleString() : '—'}
                        </td>
                        <td style={{...td, textAlign: 'right', fontWeight: 600}}>
                          {l.net_units != null ? Number(l.net_units).toLocaleString() : '—'}
                        </td>
                        <td style={{...td, textAlign: 'right'}}>
                          {l.unit_price != null ? '$' + Number(l.unit_price).toFixed(4) : '—'}
                        </td>
                        <td style={{...td, textAlign: 'right'}}>{money(l.line_subtotal)}</td>
                        <td style={{...td, textAlign: 'right', color: '#9a3412'}}>{money(l.allocated_tax)}</td>
                        <td style={{...td, textAlign: 'right'}}>{money(l.line_total)}</td>
                        <td style={{...td, textAlign: 'right', color: '#065f46', fontWeight: 700}}>
                          {l.effective_per_gal != null ? '$' + Number(l.effective_per_gal).toFixed(4) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {err && (
                <div
                  style={{
                    padding: '8px 12px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#b91c1c',
                    borderRadius: 5,
                    fontSize: 12,
                    marginBottom: 10,
                  }}
                >
                  {err}
                </div>
              )}

              <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
                <button
                  onClick={onClose}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 6,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={save}
                  disabled={busy}
                  style={{
                    padding: '8px 18px',
                    borderRadius: 6,
                    border: 'none',
                    background: busy ? '#9ca3af' : '#085041',
                    color: 'white',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {busy ? 'Saving…' : 'Save bill'}
                </button>
              </div>
            </>
          )}

          {!parsed && !parsing && (
            <div style={{padding: 30, textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
              Pick a Home Oil PDF to parse. Other suppliers may need manual edits after parsing.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
