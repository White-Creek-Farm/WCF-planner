// Pre-insert duplicate check for daily reports.
// Checks by identity (date + label/herd/flock) and blocks inserts when
// a matching report already exists. Add Feed rows (source='add_feed_webform')
// are excluded for tables that share rows with Add Feed — egg_dailys never
// has Add Feed rows so the source filter is skipped there.

const IDENTITY_FIELDS = {
  poultry_dailys: ['date', 'batch_label'],
  pig_dailys: ['date', 'batch_label'],
  layer_dailys: ['date', 'batch_label'],
  egg_dailys: ['date'],
  cattle_dailys: ['date', 'herd'],
  sheep_dailys: ['date', 'flock'],
};

const TABLES_WITH_ADD_FEED = new Set(['poultry_dailys', 'pig_dailys', 'layer_dailys', 'cattle_dailys', 'sheep_dailys']);

export async function checkDailyDuplicate(sb, table, record) {
  const fields = IDENTITY_FIELDS[table];
  if (!fields) return null;
  for (const f of fields) {
    if (!record[f] && record[f] !== 0) return null;
  }
  let query = sb.from(table).select('id,date').limit(1);
  if (TABLES_WITH_ADD_FEED.has(table)) {
    query = query.or('source.is.null,source.neq.add_feed_webform');
  }
  for (const f of fields) {
    query = query.eq(f, record[f]);
  }
  const {data, error} = await query;
  if (error) {
    throw new Error(`Could not verify duplicate report: ${error.message}`);
  }
  if (!data || data.length === 0) return null;
  return data[0];
}

function identityKey(table, record) {
  const fields = IDENTITY_FIELDS[table];
  if (!fields) return null;
  return fields.map((f) => String(record[f] || '')).join('|');
}

export function checkInSubmissionDuplicates(table, records) {
  const seen = new Set();
  for (const rec of records) {
    const key = identityKey(table, rec);
    if (!key) continue;
    if (seen.has(key)) return rec;
    seen.add(key);
  }
  return null;
}

export function formatDuplicateError(table, record) {
  const label = record.batch_label || record.herd || record.flock || '';
  const date = record.date || '';
  if (label) {
    return `A report already exists for ${label} on ${date}. Edit the existing report if changes are needed.`;
  }
  return `A report already exists for ${date}. Edit the existing report if changes are needed.`;
}
