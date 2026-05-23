// Broiler batch public-mirror helper.
//
// Single source of truth for the public-anon broiler weigh-in form's batch
// list + per-batch schooner labels, mirrored from the admin app_store ppp-v4
// rows into webform_config so the public form never needs anon SELECT on
// app_store. Shared by:
//   - src/main.jsx (mirror writer at app load + inside syncWebformConfig)
//   - src/webforms/WeighInsWebform.jsx (column labels for the broiler grid)
//
// Filter contract: status === 'active'. Public broiler weigh-ins are for
// active batches only (Ronnie 2026-04-30 follow-up after a planned batch
// surfaced in the public dropdown post-rollout). Empty-schooner handling
// remains — an active batch with no schooners still surfaces in the
// dropdown and blocks Start Session via deriveBroilerColumnLabels = [].

export function splitSchooners(raw) {
  return String(raw || '')
    .split('&')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildBroilerPublicMirror(batchRows) {
  const active = (batchRows || []).filter((b) => b && b.status === 'active');
  return {
    groups: active.map((b) => b.name),
    meta: active.map((b) => ({
      name: b.name,
      schooners: splitSchooners(b.schooner),
      brooder: b.brooder || null,
      brooderOut: b.brooderOut || null,
    })),
  };
}

export function deriveBroilerColumnLabels(meta, batchId) {
  const list = Array.isArray(meta) ? meta : [];
  const rec = list.find((b) => b && b.name === batchId);
  if (!rec || !Array.isArray(rec.schooners)) return [];
  return rec.schooners.filter(Boolean);
}

const SCHOONER_LABELS = {
  1: 'Schooner 1',
  '2&3': 'Schooner 2 & 3',
  '4&5': 'Schooner 4 & 5',
  '6&6A': 'Schooner 6 & 6A',
  '7&7A': 'Schooner 7 & 7A',
};

const BROODER_LABELS = {1: 'Brooder 1', 2: 'Brooder 2', 3: 'Brooder 3'};

export function formatBroilerBatchLabel(name, meta) {
  if (!name) return '';
  const list = Array.isArray(meta) ? meta : [];
  const rec = list.find((b) => b && b.name === name);
  if (!rec) return name;
  const inSchooner = rec.brooderOut && new Date(rec.brooderOut + 'T12:00:00') <= new Date();
  if (inSchooner && rec.schooners && rec.schooners.length > 0) {
    const raw = rec.schooners.join('&');
    const label = SCHOONER_LABELS[raw] || 'Schooner ' + rec.schooners.join(' & ');
    return name + ' (' + label + ')';
  }
  if (rec.brooder) {
    const label = BROODER_LABELS[rec.brooder] || 'Brooder ' + rec.brooder;
    return name + ' (' + label + ')';
  }
  return name;
}
