// ============================================================================
// src/lib/cattleLogTags.js — Cattle Log #tag parsing + client-side matching
// ----------------------------------------------------------------------------
// Pure module — no imports, no React, no supabase, no side effects.
//
// A tag reference is '#' followed by one or more digits ([0-9]+): the tag is
// the MAXIMAL run of digits immediately after the '#'. '#12a' yields tag '12';
// '#a12' yields nothing. Tags are exact-text identities: '#0123' and '#123'
// are DIFFERENT tags (no numeric normalization, leading zeros preserved).
//
// matchTagToCattle mirrors the migration-110 dam-resolution rule exactly:
//   - candidates are ACTIVE cattle only: deleted_at IS NULL AND herd IN
//     ('mommas','backgrounders','finishers','bulls')
//   - current `tag` exact match wins; old_tags are only consulted when NO
//     current-tag match exists
//   - old_tags fallback considers jsonb entries {tag, source} where
//     COALESCE(source,'') <> 'import' (selling-farm purchase tags can collide,
//     so import-sourced tags never count)
//   - more than one distinct matching row within the winning tier → ambiguous
//
// This is the client PREVIEW matcher only — the server-side RPCs are
// authoritative at submit/edit time.
// ============================================================================

// Active herds eligible for tag matching. Kept local (this module is
// import-free by contract); must stay in sync with CATTLE_HERD_KEYS in
// cattleHerdFilters.js and the migration-112 RPC rule.
const ACTIVE_HERDS = ['mommas', 'backgrounders', 'finishers', 'bulls'];

// '#' followed by a maximal run of digits.
const TAG_PATTERN = /#([0-9]+)/g;

// parseCattleLogTags('check #12 and #0034, #12 again') → ['12', '0034']
// Deduped (exact text) preserving first-seen order. Null/empty body → [].
export function parseCattleLogTags(body) {
  if (typeof body !== 'string' || !body) return [];
  const seen = new Set();
  const tags = [];
  for (const match of body.matchAll(TAG_PATTERN)) {
    const tag = match[1];
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

// Normalize a search-box query for the list RPC's search semantics:
//   { text: trimmed query (used verbatim for ILIKE),
//     tag:  the query with any leading '#' stripped IF the remainder is all
//           digits (exact tag-link search), else null }
// '#123' → {text:'#123', tag:'123'}; '123' → {text:'123', tag:'123'};
// '#12a' / 'bessie' / '#' / '' → tag null.
export function normalizeTagSearchQuery(q) {
  const text = typeof q === 'string' ? q.trim() : '';
  if (!text) return {text: '', tag: null};
  const stripped = text.replace(/^#+/, '');
  const tag = stripped && /^[0-9]+$/.test(stripped) ? stripped : null;
  return {text, tag};
}

// Split a body into ordered render segments so #tags can be drawn as chips:
//   [{type:'text', value}, {type:'tag', value}, ...]
// Tag segment `value` is the digit string WITHOUT the leading '#' (matching
// parseCattleLogTags output — renderers prepend '#'); the '#' itself is
// consumed by the tag segment and never appears in a text segment. Duplicate
// tags each get their own segment (no dedupe here — this is layout, not
// identity). Empty/null body → [].
export function buildCattleLogBodySegments(body) {
  if (typeof body !== 'string' || !body) return [];
  const segments = [];
  let cursor = 0;
  for (const match of body.matchAll(TAG_PATTERN)) {
    if (match.index > cursor) {
      segments.push({type: 'text', value: body.slice(cursor, match.index)});
    }
    segments.push({type: 'tag', value: match[1]});
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    segments.push({type: 'text', value: body.slice(cursor)});
  }
  return segments;
}

function isActiveRow(row) {
  return (
    row &&
    typeof row === 'object' &&
    (row.deleted_at === null || row.deleted_at === undefined) &&
    ACTIVE_HERDS.includes(row.herd)
  );
}

// Exact-text compare tolerating jsonb round-trips that surface numbers
// (e.g. old_tags entries imported as {tag: 123}). Postgres ->> always yields
// text, so String() here matches the server's comparison semantics.
function tagEquals(value, tag) {
  if (typeof value === 'string') return value === tag;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value) === tag;
  return false;
}

function rowMatchesOldTag(row, tag) {
  const oldTags = Array.isArray(row.old_tags) ? row.old_tags : [];
  return oldTags.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    // COALESCE(source,'') <> 'import' — missing/null source counts as manual.
    const source = entry.source === null || entry.source === undefined ? '' : entry.source;
    return source !== 'import' && tagEquals(entry.tag, tag);
  });
}

// matchTagToCattle('123', cattleRows) →
//   {status:'matched',   cattle:[row]}    exactly one row in the winning tier
//   {status:'unmatched', cattle:[]}       no row in either tier
//   {status:'ambiguous', cattle:[rows]}   2+ distinct rows in the winning tier
// Rows: {id, tag, old_tags, herd, deleted_at}. Inactive rows (soft-deleted or
// outcome herds) never match. Current-tag matches form tier 1; old_tags
// (non-import) form tier 2 and are only consulted when tier 1 is empty —
// a single current-tag match is NOT ambiguous even if another active cow
// carries the same old tag.
export function matchTagToCattle(tag, cattleRows) {
  if (typeof tag !== 'string' || !/^[0-9]+$/.test(tag)) {
    return {status: 'unmatched', cattle: []};
  }
  const rows = Array.isArray(cattleRows) ? cattleRows.filter(isActiveRow) : [];

  const currentMatches = rows.filter((row) => tagEquals(row.tag, tag));
  const winning = currentMatches.length > 0 ? currentMatches : rows.filter((row) => rowMatchesOldTag(row, tag));

  if (winning.length === 0) return {status: 'unmatched', cattle: []};
  if (winning.length === 1) return {status: 'matched', cattle: winning};
  return {status: 'ambiguous', cattle: winning};
}
