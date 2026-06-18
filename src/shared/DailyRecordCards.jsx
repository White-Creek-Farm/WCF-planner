// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import './DailyRecordCards.css';
import {openableProps} from './openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import DailyPhotoChip from './DailyPhotoChip.jsx';

// ============================================================================
// DailyRecordCards — the daily-report LIST card system (Build Queue item 5)
// ----------------------------------------------------------------------------
// The designer redesign of the six program daily-report list pages + the admin
// Home "Last 5 Days" feed. Each daily report becomes a clean white record-card
// (not a <table> row), so it can carry the SAME physical hover lift as the Home
// tiles via the locked global `.hoverable-tile` contract — transform:
// translateY(-3px) + elevated shadow + :focus-visible ring + reduced-motion
// drop, with a trailing › chevron that fades/slides in (global `.chev`). This
// satisfies the owner's "rows must lift like Home tiles" requirement WITHOUT
// transforming a <tr>, so the CP0 §A6 "no <tr> transform" guard stays valid.
//
// Design law (from the handoff README):
//   • white card, 1px #E6E8EB border, 14px radius, 10px gap, 14px pad — no zebra
//   • status = colored TEXT (ok #3F7A5B, fail #C0452F), never pills
//   • one soft mortality badge per row (bg #FBE7E3 / #C0452F + 7px dot)
//   • one soft comment note (bg #F8F0DA / border #ECE0BC / black text / ✎)
//   • flock/herd = dot + black label; batch IDs stay plain bold black (no dot)
//   • feed-type words are neutral gray tags (#F1F3F4 / #3F3F3F), not amber
//   • only 0 kV voltage is red; every other kV is black
//   • fixed-width columns so every field starts at the same x on every row; a
//     missing value still occupies its column, a long feed string wraps INSIDE
//     its column and never pushes later columns.
// ============================================================================

// Per-program fixed-column schema (after Name + Team), mirrors the mockup.
export const DAILY_COLS = {
  broiler: [
    {key: 'feed', icon: '🌾', w: 96},
    {key: 'feedTag', w: 80, kind: 'tag'},
    {key: 'grit', w: 104},
  ],
  pig: [
    {key: 'feed', icon: '🌾', w: 92},
    {key: 'pigs', icon: '🐖', w: 82},
    {key: 'volt', icon: '⚡', w: 84},
  ],
  layer: [
    {key: 'feed', icon: '🌾', w: 92},
    {key: 'feedTag', w: 70, kind: 'tag'},
    {key: 'grit', w: 84},
    {key: 'count', icon: '🥚', w: 92},
  ],
  cattle: [
    {key: 'feed', icon: '🌾', w: 300},
    {key: 'volt', icon: '⚡', w: 80},
  ],
  sheep: [
    {key: 'feed', icon: '🌾', w: 220},
    {key: 'volt', icon: '⚡', w: 80},
  ],
};

// ---- value wrappers: a metric value is a plain string (black) or a tagged
// object {t, kind} where kind ∈ muted | danger | tag. -------------------------
export const mutedVal = (t) => ({t, kind: 'muted'});
export const tagVal = (t) => ({t, kind: 'tag'});

// Voltage rule: only 0 kV is the danger signal; every other reading is black.
export function voltageVal(v) {
  if (v == null || String(v).trim() === '') return mutedVal('—');
  const text = v + ' kV';
  return parseFloat(v) === 0 ? {t: text, kind: 'danger'} : text;
}

// Feed quantity (single-number programs: broiler/pig/layer).
export function feedLbsVal(lbs) {
  return parseFloat(lbs) > 0 ? parseFloat(lbs).toLocaleString() + ' lbs' : mutedVal('no feed');
}

// Multi-item feed list (cattle/sheep jsonb feeds[] + minerals[]). Wraps inside
// its wide column; joined with the designer's middot. Preserves both feeds and
// minerals so no logged data is hidden on the list.
export function feedListVal(feeds, minerals, {emptyLabel = 'no feed log'} = {}) {
  const item = (x, nameKey) => {
    const parts = [x[nameKey] || '?'];
    if (x.qty != null && x.qty !== '') parts.push(String(x.qty));
    if (x.unit) parts.push(x.unit);
    let s = parts.join(' ');
    if (x.is_creep) s += ' 🍼';
    return s;
  };
  const feed = Array.isArray(feeds) && feeds.length ? feeds.map((f) => item(f, 'feed_name')).join(' · ') : '';
  const min =
    Array.isArray(minerals) && minerals.length
      ? minerals.map((m) => (m.name || '?') + (m.lbs != null ? ' ' + m.lbs + ' lb' : '')).join(' · ')
      : '';
  const combined = [feed, min].filter(Boolean).join(' · ');
  return combined || mutedVal(emptyLabel);
}

export const gritVal = (lbs) =>
  parseFloat(lbs) > 0 ? parseFloat(lbs).toLocaleString() + ' lb grit' : mutedVal('no grit');

export const countVal = (n) => (parseInt(n) > 0 ? String(n) : mutedVal('no count'));

export const check = (label, ok) => ({label, ok});

// Mortality string (no emoji — the badge supplies the red dot). Returns null
// when there is no mortality, so the badge is omitted.
export function mortText(count, reason) {
  const n = parseInt(count);
  if (!(n > 0)) return null;
  return n + ' mort.' + (reason ? ' — ' + reason : '');
}

// Comment string, clamped at the card. Returns null for empty/short comments.
export function commentText(comments) {
  const c = comments && String(comments).trim().length > 2 ? String(comments).trim() : '';
  return c || null;
}

const KIND_CLASS = {val: 'drc-v', muted: 'drc-v-muted', danger: 'drc-v-danger', tag: 'drc-tag'};

function buildCell(col, raw) {
  let text = '';
  let kind = col.kind || 'val';
  if (raw != null && raw !== '') {
    if (typeof raw === 'object') {
      text = raw.t;
      kind = raw.kind || kind;
    } else {
      text = raw;
    }
  }
  const has = !!text;
  return {icon: has && col.icon ? col.icon : '', text, kind, w: col.w};
}

// ---- one record card -------------------------------------------------------
export function DailyRecordCard({
  program,
  name,
  dot,
  team,
  source,
  photos,
  vals = {},
  checks = [],
  mort,
  comment,
  onOpen,
  attrs,
}) {
  const cols = DAILY_COLS[program] || [];
  return (
    <div className="drc-card hoverable-tile" {...attrs} {...openableProps(onOpen)}>
      <div className="drc-line">
        <span className="drc-name">
          {dot && <span className="drc-dot" style={{background: dot}} aria-hidden="true" />}
          <span className="drc-name-text">{name}</span>
          {source === 'add_feed_webform' && (
            <span className="drc-feedflag" title="Add Feed log" aria-label="Add Feed log">
              {'🌾'}
            </span>
          )}
          {photos && <DailyPhotoChip photos={photos} />}
        </span>
        <span className="drc-team-wrap">
          <span className="drc-team">{team}</span>
        </span>
        {cols.map((col) => {
          const cell = buildCell(col, vals[col.key]);
          return (
            <span key={col.key} className="drc-cell" style={{width: cell.w}}>
              {cell.icon && <span className="drc-icon">{cell.icon}</span>}
              {cell.text && <span className={`${KIND_CLASS[cell.kind]} tnum`}>{cell.text}</span>}
            </span>
          );
        })}
        {checks.length > 0 && (
          <div className="drc-checks">
            {checks.map((c, i) => (
              <span key={i} className={c.ok ? 'drc-ck-ok' : 'drc-ck-bad'}>
                {c.label + ' ' + (c.ok ? '✓' : '✗')}
              </span>
            ))}
          </div>
        )}
        <span className="chev" aria-hidden="true">
          {'›'}
        </span>
      </div>
      {mort && (
        <div className="drc-mort">
          <span className="drc-mort-dot" aria-hidden="true" />
          {mort}
        </div>
      )}
      {comment && (
        <div className="drc-comment">
          <span className="drc-comment-ic" aria-hidden="true">
            ✎
          </span>
          <span className="drc-comment-text">{comment}</span>
        </div>
      )}
    </div>
  );
}

// ---- egg summary card (the /layer/eggs list + Home EGG block) ---------------
export function EggSummaryCard({total, team, breakdown = [], dozens, comment, onOpen, attrs}) {
  return (
    <div className="drc-card hoverable-tile" {...attrs} {...openableProps(onOpen)}>
      <div className="drc-line">
        <span className="drc-egg-total">
          <span className="drc-egg-n tnum">{total}</span>
          <span className="drc-egg-unit">eggs</span>
        </span>
        <span className="drc-team-wrap">
          <span className="drc-team">{team}</span>
        </span>
        {breakdown.map((b, i) => (
          <span key={i} className="drc-egg-house">
            <span className="drc-egg-loc">{b.loc}</span>
            <span className="drc-egg-count tnum">{b.n}</span>
          </span>
        ))}
        {dozens && <span className="drc-egg-doz tnum">{dozens}</span>}
        <span className="chev" aria-hidden="true">
          {'›'}
        </span>
      </div>
      {comment && (
        <div className="drc-comment">
          <span className="drc-comment-ic" aria-hidden="true">
            ✎
          </span>
          <span className="drc-comment-text">{comment}</span>
        </div>
      )}
    </div>
  );
}

// ---- date-grouped list wrapper (used by the six program list views) --------
// Rows arrive already filtered + sorted (date desc). We group consecutive same-
// date rows, render a date header + "N reports", and cap the rendered count at
// maxInitialRows with a "Show more" control (the full set stays in memory so
// export / print / filters are unaffected — same contract as the old DataTable).
export function DailyCardList({program, rows = [], fmt, onOpen, rowAttrs, mapRow, maxInitialRows}) {
  const step = maxInitialRows || 0;
  const [visible, setVisible] = React.useState(step || Infinity);
  React.useEffect(() => {
    setVisible(step || Infinity);
  }, [step, rows.length]);

  const groups = [];
  let cur = null;
  for (const d of rows) {
    if (!cur || cur.date !== d.date) {
      cur = {date: d.date, rows: []};
      groups.push(cur);
    }
    cur.rows.push(d);
  }

  let shown = 0;
  const rendered = [];
  for (const g of groups) {
    if (shown >= visible) break;
    const slice = g.rows.slice(0, visible - shown);
    shown += slice.length;
    rendered.push(
      <div key={g.date} className="drc-group">
        <div className="drc-date-head">
          <span className="drc-date tnum">{fmt ? fmt(g.date) : g.date}</span>
          <span className="drc-date-count tnum">
            {g.rows.length} report{g.rows.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="drc-stack">
          {slice.map((d) => {
            const m = mapRow(d);
            const attrs = rowAttrs ? rowAttrs(d) : undefined;
            const open = () => onOpen(d);
            return program === 'egg' ? (
              <EggSummaryCard key={d.id} {...m} onOpen={open} attrs={attrs} />
            ) : (
              <DailyRecordCard key={d.id} program={program} {...m} onOpen={open} attrs={attrs} />
            );
          })}
        </div>
      </div>,
    );
  }

  const remaining = rows.length - visible;
  return (
    <div className="drc-list" data-daily-cards={program}>
      {rendered}
      {remaining > 0 && (
        <button
          type="button"
          className="drc-show-more"
          data-daily-cards-show-more="1"
          onClick={() => setVisible((v) => v + (step || 200))}
        >
          {`Show ${Math.min(step || 200, remaining)} more (${remaining} remaining)`}
        </button>
      )}
    </div>
  );
}
