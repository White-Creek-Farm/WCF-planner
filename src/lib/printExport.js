function printableText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value) {
  return printableText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function columnValue(column, row) {
  if (typeof column.value === 'function') return column.value(row);
  return row && column.key ? row[column.key] : '';
}

export function rowsToPrintHtml({title, subtitle = '', columns, rows}) {
  const cols = Array.isArray(columns) ? columns : [];
  const list = Array.isArray(rows) ? rows : [];
  const header = cols.map((c) => `<th>${escapeHtml(c.header || c.key || '')}</th>`).join('');
  const body = list
    .map((row) => {
      const cells = cols.map((c) => `<td>${escapeHtml(columnValue(c, row))}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || 'Print')}</title>
<style>
body{font-family:Arial,sans-serif;color:#000;margin:24px}
h1{font-size:20px;margin:0 0 4px}
.subtitle{font-size:12px;color:#4b5563;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:11px}
th,td{border:1px solid #d1d5db;padding:5px 6px;text-align:left;vertical-align:top}
th{background:#f3f4f6;font-weight:700}
tr{break-inside:avoid}
</style>
</head>
<body>
<h1>${escapeHtml(title || 'Print')}</h1>
${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ''}
<table>
<thead><tr>${header}</tr></thead>
<tbody>${body}</tbody>
</table>
</body>
</html>`;
}

export function printRows({title, subtitle = '', columns, rows}) {
  if (
    typeof document === 'undefined' ||
    typeof window === 'undefined' ||
    typeof window.print !== 'function' ||
    !document.body
  ) {
    return false;
  }

  const frame = document.createElement('iframe');
  frame.setAttribute('data-print-export-frame', '1');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
  if (!doc) {
    frame.remove();
    return false;
  }

  const cleanup = () => {
    setTimeout(() => frame.remove(), 0);
  };
  const runPrint = () => {
    const targetWindow = frame.contentWindow || window;
    if (targetWindow && typeof targetWindow.focus === 'function') targetWindow.focus();
    if (targetWindow && typeof targetWindow.print === 'function') targetWindow.print();
    else window.print();
    cleanup();
  };

  doc.open();
  doc.write(rowsToPrintHtml({title, subtitle, columns, rows}));
  doc.close();

  if (doc.readyState === 'complete') runPrint();
  else frame.onload = runPrint;
  return true;
}
