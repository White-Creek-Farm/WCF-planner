const MONTH_NAMES = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]);

function parseAccountingMonth(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4})-(\d{2})$/) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return {year, monthIndex: month - 1};
}

function padMonth(monthIndex) {
  return String(monthIndex + 1).padStart(2, '0');
}

function isoDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function currentAccountingMonth(todayMs = Date.now()) {
  const date = new Date(todayMs);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${padMonth(date.getUTCMonth())}`;
}

export function shiftAccountingMonth(month, offset) {
  const parsed = parseAccountingMonth(month);
  if (!parsed) return '';
  const date = new Date(Date.UTC(parsed.year, parsed.monthIndex + offset, 1, 12));
  return `${date.getUTCFullYear()}-${padMonth(date.getUTCMonth())}`;
}

export function accountingSnapshotMinMonth(todayMs = Date.now(), pastMonths = 12) {
  const current = currentAccountingMonth(todayMs);
  return current ? shiftAccountingMonth(current, -pastMonths) : '';
}

export function accountingMonthEndISO(month) {
  const parsed = parseAccountingMonth(month);
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 0, 12)).toISOString().slice(0, 10);
}

export function formatAccountingMonthEnd(month) {
  const parsed = parseAccountingMonth(month);
  const endDate = accountingMonthEndISO(month);
  if (!parsed || !endDate) return '';
  return `${MONTH_NAMES[parsed.monthIndex]} ${Number(endDate.slice(8, 10))}, ${parsed.year}`;
}

function entryDateForAnimal(row) {
  return isoDate(row && (row.purchase_date || row.birth_date || row.created_at));
}

function transferDateMs(row) {
  const date = row && (row.transferred_at || row.created_at);
  if (!date) return null;
  const ms = new Date(date).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function groupTransfersByAnimal(transfers, transferEntityIdField) {
  const byAnimal = new Map();
  for (const transfer of transfers || []) {
    if (!transfer || !transfer[transferEntityIdField]) continue;
    const key = String(transfer[transferEntityIdField]);
    const list = byAnimal.get(key) || [];
    list.push(transfer);
    byAnimal.set(key, list);
  }
  for (const list of byAnimal.values()) {
    list.sort((a, b) => (transferDateMs(b) || 0) - (transferDateMs(a) || 0));
  }
  return byAnimal;
}

export function animalGroupAsOfMonthEnd(row, transfersByAnimal, config, month) {
  const endDate = accountingMonthEndISO(month);
  if (!row || !endDate) return row ? row[config.groupField] || null : null;

  const cutoffMs = new Date(endDate + 'T23:59:59.999Z').getTime();
  const animalTransfers = transfersByAnimal.get(String(row.id)) || [];
  let group = row[config.groupField] || null;

  for (const transfer of animalTransfers) {
    const ms = transferDateMs(transfer);
    if (ms == null) continue;
    if (ms <= cutoffMs) break;
    if (transfer[config.transferFromField]) group = transfer[config.transferFromField];
  }

  return group;
}

export function animalWasActiveAtMonthEnd(row, transfersByAnimal, config, month) {
  const endDate = accountingMonthEndISO(month);
  if (!row || !endDate) return false;

  const entryDate = entryDateForAnimal(row);
  if (entryDate && entryDate > endDate) return false;

  const deathDate = isoDate(row.death_date);
  if (deathDate && deathDate <= endDate) return false;

  const saleDate = isoDate(row.sale_date);
  if (saleDate && saleDate <= endDate) return false;

  const deletedAt = isoDate(row.deleted_at);
  if (deletedAt && deletedAt <= endDate) return false;

  const group = animalGroupAsOfMonthEnd(row, transfersByAnimal, config, month);
  return config.activeGroups.includes(group);
}

export function accountingSnapshotRows(rows, transfers, config, month) {
  const endDate = accountingMonthEndISO(month);
  if (!endDate) return rows || [];

  const transfersByAnimal = groupTransfersByAnimal(transfers, config.transferEntityIdField);
  return (rows || [])
    .filter((row) => animalWasActiveAtMonthEnd(row, transfersByAnimal, config, month))
    .map((row) => {
      const groupAsOf = animalGroupAsOfMonthEnd(row, transfersByAnimal, config, month);
      return {
        ...row,
        [config.groupField]: groupAsOf,
        _accountingSnapshotMonth: month,
        _accountingSnapshotEndDate: endDate,
        _accountingSnapshotOriginalGroup: row[config.groupField] || null,
      };
    });
}
