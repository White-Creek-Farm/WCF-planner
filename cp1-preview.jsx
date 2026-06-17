// CP1 primitives showcase — isolated preview entry (NOT wired into the app).
// Renders the real CP1 components so the new design language can be judged from
// screenshots without touching any live surface. Navigate /cp1-preview.html.
import React from 'react';
import {createRoot} from 'react-dom/client';
import Badge from './src/shared/Badge.jsx';
import StatusText from './src/shared/StatusText.jsx';
import Toolbar from './src/shared/Toolbar.jsx';
import Tabs from './src/shared/Tabs.jsx';
import DataTable from './src/shared/DataTable.jsx';
import EmptyState from './src/shared/EmptyState.jsx';
import {PROGRAM_COLORS, programDotStyle, getProgramColor} from './src/lib/programColors.js';
import {getReadableText} from './src/lib/styles.js';

const PROGRAMS = ['broiler', 'layer', 'pig', 'cattle', 'sheep', 'equipment'];

const HERD_ROWS = [
  {id: 1, program: 'cattle', tag: 'C-0427', name: 'Mommas', head: 42, adg: 2.3, status: 'Active'},
  {id: 2, program: 'cattle', tag: 'C-0431', name: 'Backgrounders', head: 28, adg: 1.9, status: 'Active'},
  {id: 3, program: 'cattle', tag: 'C-0440', name: 'Finishers', head: 16, adg: 3.1, status: 'Active'},
  {id: 4, program: 'cattle', tag: 'C-0402', name: 'Bulls', head: 3, adg: 1.2, status: 'Active'},
];

const WEIGH_ACTIVE = [
  {id: 'a1', tag: 'p-26-01a', date: '04/26/26', entries: 5, avg: 250, adg: 1.43, status: 'Draft'},
];
const WEIGH_DONE = [
  {id: 'd1', tag: 'p-26-01a', date: '03/15/26', entries: 0, avg: 0, adg: 0, status: 'Complete'},
];

function Section({title, children}) {
  return (
    <section style={{marginBottom: 40}}>
      <h2 style={{fontSize: 16, fontWeight: 700, color: '#000', margin: '0 0 14px'}}>{title}</h2>
      {children}
    </section>
  );
}

function Swatch({program}) {
  const hex = getProgramColor(program);
  return (
    <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6}}>
      <div style={{width: 56, height: 56, borderRadius: 14, background: hex}} />
      <div style={{fontSize: 12, fontWeight: 700, color: '#000', textTransform: 'capitalize'}}>{program}</div>
      <div style={{fontSize: 11, color: 'var(--text-secondary)'}}>{hex}</div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: 999,
          background: hex,
          color: getReadableText(hex),
        }}
      >
        pill text
      </span>
    </div>
  );
}

function App() {
  const [tab, setTab] = React.useState('summary');
  const [progTab, setProgTab] = React.useState('cattle');
  const [selected, setSelected] = React.useState(new Set());

  const herdCols = [
    {key: 'dot', label: '', render: (r) => <span style={programDotStyle(r.program, 10)} />},
    {key: 'tag', label: 'Tag', primary: true},
    {key: 'name', label: 'Group'},
    {key: 'head', label: 'Head', align: 'right'},
    {
      key: 'adg',
      label: 'ADG',
      align: 'right',
      render: (r) => <StatusText tone={r.adg >= 2 ? 'ok' : 'warn'}>{r.adg.toFixed(1)} lb</StatusText>,
    },
    {key: 'status', label: 'Status', render: () => <Badge variant="neutral">Active</Badge>},
  ];

  const weighCols = [
    {key: 'tag', label: 'Session', primary: true},
    {
      key: 'status',
      label: 'Status',
      render: (r) => <Badge variant={r.status === 'Draft' ? 'warn' : 'ok'}>{r.status}</Badge>,
    },
    {key: 'date', label: 'Date'},
    {key: 'entries', label: 'Entries', align: 'right'},
    {key: 'avg', label: 'Avg wt', align: 'right', render: (r) => (r.avg ? `${r.avg} lb` : '—')},
  ];

  return (
    <div style={{maxWidth: 1080, margin: '0 auto', padding: '28px 24px 80px'}}>
      <h1 style={{fontSize: 28, fontWeight: 800, color: '#000', margin: '0 0 6px'}}>CP1 Primitives — Design Preview</h1>
      <p style={{color: 'var(--text-secondary)', margin: '0 0 32px', fontSize: 14}}>
        The real CP1 components on ratified tokens (true-black text, unified defined borders, 10px radius floor, locked
        program palette). Isolated page — not wired into the app.
      </p>

      <Section title="Program palette (A12) — solid dot / selected pill only">
        <div style={{display: 'flex', gap: 28, flexWrap: 'wrap'}}>
          {PROGRAMS.map((p) => (
            <Swatch key={p} program={p} />
          ))}
        </div>
      </Section>

      <Section title="Tabs — program-colored selected pill">
        <div style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          <Tabs
            tabs={[
              {key: 'summary', label: 'Summary'},
              {key: 'events', label: 'Processing Events'},
              {key: 'legacy', label: 'Legacy / Audit'},
            ]}
            active={tab}
            onChange={setTab}
          />
          <Tabs
            program={progTab}
            tabs={PROGRAMS.slice(0, 5).map((p) => ({key: p, label: p[0].toUpperCase() + p.slice(1)}))}
            active={progTab}
            onChange={setProgTab}
          />
        </div>
      </Section>

      <Section title="Badge (closed set) + StatusText">
        <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12}}>
          <Badge variant="ok">Complete</Badge>
          <Badge variant="warn">Low</Badge>
          <Badge variant="danger">Overdue</Badge>
          <Badge variant="info">Scheduled</Badge>
          <Badge variant="neutral">Draft</Badge>
        </div>
        <div style={{display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13}}>
          <StatusText tone="ok">+2.3 lb ADG</StatusText>
          <StatusText tone="warn">3 left</StatusText>
          <StatusText tone="danger">5 days overdue</StatusText>
          <StatusText tone="info">due tomorrow</StatusText>
          <StatusText tone="muted">no prior weigh-in</StatusText>
        </div>
      </Section>

      <Section title="Toolbar — one primary, grouped actions, overflow">
        <Toolbar
          title="Cattle Herds"
          count="4 groups"
          primaryAction={{label: '+ New Herd', onClick: () => {}}}
          secondaryActions={[{label: 'Filter', onClick: () => {}}]}
          overflowActions={[
            {label: 'Export CSV', onClick: () => {}},
            {label: 'Print', onClick: () => {}},
          ]}
        />
      </Section>

      <Section title="DataTable — list with row-number, program dot, right-aligned numbers, status">
        <DataTable
          surfaceKey="preview-herds"
          showRowNumbers
          columns={herdCols}
          rows={HERD_ROWS}
          onRowOpen={() => {}}
          stickyTop={0}
        />
      </Section>

      <Section title="DataTable — section bands (Active / Complete) + selectable">
        <DataTable
          surfaceKey="preview-weighins"
          selectable
          selectedIds={selected}
          onToggleSelect={(r) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(r.id)) next.delete(r.id);
              else next.add(r.id);
              return next;
            })
          }
          rowDisabled={(r) => r.status === 'Complete'}
          columns={weighCols}
          sections={[
            {key: 'active', label: 'Active', rows: WEIGH_ACTIVE},
            {key: 'complete', label: 'Complete', rows: WEIGH_DONE},
          ]}
          onRowOpen={() => {}}
        />
      </Section>

      <Section title="DataTable — loading (skeleton)">
        <DataTable surfaceKey="preview-loading" columns={weighCols} loading />
      </Section>

      <Section title="DataTable — load error (InlineNotice + Retry)">
        <DataTable
          surfaceKey="preview-error"
          columns={weighCols}
          loadError={{message: 'Failed to load sessions. Retry when your connection is back.'}}
          onRetry={() => {}}
        />
      </Section>

      <Section title="EmptyState (loaded, zero rows)">
        <div style={{border: '1px solid var(--border)', borderRadius: 14, background: 'var(--bg-card)'}}>
          <EmptyState message="No weigh-in sessions yet." action={{label: '+ New Weigh-In', onClick: () => {}}} />
        </div>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
