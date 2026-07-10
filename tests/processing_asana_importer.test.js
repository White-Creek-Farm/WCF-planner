// Unit tests for the importer-completeness layer of processingAsanaShape.js:
// stable gid/email user mapping, mention parsing, system-story mapping, 429
// backoff, and the fail-closed destination audit.
import {describe, expect, it} from 'vitest';
import {
  buildUserDirectory,
  mapAsanaUserToProfile,
  parseAsanaMentionProfileIds,
  isSystemStory,
  isRealComment,
  mapAsanaSystemStory,
  retryAfterMs,
  asanaColorToPalette,
  buildDestinationAudit,
  mergeTemplateChecklistAssignees,
} from '../supabase/functions/_shared/processingAsanaShape.js';

const USERS = [
  {gid: '101', name: 'Ronnie Jones', email: 'ronnie@mawaie.com'},
  {gid: '102', name: 'Isabel Hermann', email: 'isabel@mawaie.com'},
  {gid: '103', name: 'Brian Naide', email: 'brian@sonnysfarm.com'},
  {gid: '104', name: 'No Email'},
];
const PROFILES_BY_EMAIL = {
  'ronnie@mawaie.com': 'prof-ronnie',
  'isabel@mawaie.com': 'prof-isabel',
};

describe('buildUserDirectory + mapAsanaUserToProfile', () => {
  it('indexes by gid and lowercased email', () => {
    const dir = buildUserDirectory(USERS);
    expect(dir.byGid['101'].email).toBe('ronnie@mawaie.com');
    expect(dir.byEmail['ronnie@mawaie.com']).toBe('101');
    expect(dir.byGid['104'].email).toBeNull();
  });

  it('maps a user to a profile through gid → email → profile (stable identity)', () => {
    const dir = buildUserDirectory(USERS);
    expect(mapAsanaUserToProfile('101', dir, PROFILES_BY_EMAIL)).toEqual({
      profileId: 'prof-ronnie',
      name: 'Ronnie Jones',
    });
    // Email known but no planner profile → display-name fallback only.
    expect(mapAsanaUserToProfile('103', dir, PROFILES_BY_EMAIL)).toEqual({profileId: null, name: 'Brian Naide'});
    // Unknown gid → nothing.
    expect(mapAsanaUserToProfile('999', dir, PROFILES_BY_EMAIL)).toEqual({profileId: null, name: null});
  });
});

describe('parseAsanaMentionProfileIds', () => {
  const dir = buildUserDirectory(USERS);
  it('maps profile URLs to planner profile ids, de-duplicated', () => {
    const text =
      'Ping https://app.asana.com/0/profile/101 and https://app.asana.com/0/profile/102 ' +
      '(again https://app.asana.com/0/profile/101)';
    expect(parseAsanaMentionProfileIds(text, dir, PROFILES_BY_EMAIL)).toEqual(['prof-ronnie', 'prof-isabel']);
  });
  it('skips unresolvable mentions (no profile match) and non-mention URLs', () => {
    const text = 'See https://app.asana.com/0/profile/103 and https://app.asana.com/0/1201484014160203/list';
    expect(parseAsanaMentionProfileIds(text, dir, PROFILES_BY_EMAIL)).toEqual([]);
  });
  it('handles empty/absent text', () => {
    expect(parseAsanaMentionProfileIds(null, dir, PROFILES_BY_EMAIL)).toEqual([]);
    expect(parseAsanaMentionProfileIds('', dir, PROFILES_BY_EMAIL)).toEqual([]);
  });
});

describe('system stories', () => {
  it('isSystemStory / isRealComment split the story feed cleanly', () => {
    expect(isSystemStory({type: 'system', text: 'set status'})).toBe(true);
    expect(isSystemStory({type: 'comment', text: 'hi'})).toBe(false);
    expect(isRealComment({type: 'system'})).toBe(false);
  });
  it('maps a system story to the history-event p_row with the ORIGINAL timestamp', () => {
    const row = mapAsanaSystemStory(
      {
        gid: 'st9',
        type: 'system',
        text: 'marked complete',
        created_at: '2025-03-01T09:00:00Z',
        created_by: {name: 'Isabel Hermann'},
      },
      'task1',
    );
    expect(row).toEqual({
      parent_asana_gid: 'task1',
      asana_story_gid: 'st9',
      body: 'marked complete',
      original_author_name: 'Isabel Hermann',
      created_at: '2025-03-01T09:00:00Z',
    });
  });
});

describe('retryAfterMs (HTTP 429 backoff)', () => {
  it('honors a numeric Retry-After header in seconds (capped at 60s)', () => {
    expect(retryAfterMs('3', 1)).toBe(3000);
    expect(retryAfterMs('120', 1)).toBe(60000);
  });
  it('falls back to capped exponential backoff', () => {
    expect(retryAfterMs(null, 1)).toBe(1000);
    expect(retryAfterMs('', 2)).toBe(2000);
    expect(retryAfterMs(undefined, 3)).toBe(4000);
    expect(retryAfterMs(null, 10)).toBe(30000);
  });
});

describe('asanaColorToPalette', () => {
  it('maps Asana color names to the locked palette and unknowns to grey', () => {
    expect(asanaColorToPalette('green')).toEqual({bg: '#93C896', ink: '#285F33'});
    expect(asanaColorToPalette('Yellow')).toEqual({bg: '#E8B73E', ink: '#5A4304'});
    expect(asanaColorToPalette('made-up')).toEqual({bg: '#C8CDD3', ink: '#3F4650'});
    expect(asanaColorToPalette(null)).toEqual({bg: '#C8CDD3', ink: '#3F4650'});
  });
});

describe('buildDestinationAudit (fail-closed zero-unmapped)', () => {
  const SECTIONS = [
    {gid: 's1', name: 'WCF Broiler Processing'},
    {gid: 's2', name: 'WCF Cattle Processing'},
    {gid: 's3', name: 'WCF Pig Processing'},
    {gid: 's4', name: 'WCF Lamb Processing'},
  ];
  const CF_SETTINGS = [
    {
      custom_field: {
        gid: 'cf1',
        name: 'Status (Processing)',
        type: 'enum',
        enum_options: [
          {gid: 'o1', name: 'Planned', color: 'yellow'},
          {gid: 'o2', name: 'In-Proccess', color: 'orange'},
        ],
      },
    },
    {custom_field: {gid: 'cf2', name: 'Condemed', type: 'number'}},
    {custom_field: {gid: 'cf3', name: 'Farm Arrival Date', type: 'date'}},
  ];

  it('passes (ok:true) when every destination resolves', () => {
    const audit = buildDestinationAudit({
      sections: SECTIONS,
      customFieldSettings: CF_SETTINGS,
      users: USERS,
      storyTypeCounts: {comment: 10, system: 25},
      dependencyCount: 0,
      profilesByEmail: PROFILES_BY_EMAIL,
    });
    expect(audit.ok).toBe(true);
    expect(audit.unmapped).toEqual([]);
    expect(audit.counts.fields).toBe(3);
    expect(audit.counts.options).toBe(2);
    expect(audit.counts.usersMatched).toBe(2);
    // enum options carry gid + name + mapped palette color
    const status = audit.fields.find((f) => f.name === 'Status (Processing)');
    expect(status.options[0]).toEqual({
      gid: 'o1',
      name: 'Planned',
      color: 'yellow',
      palette: {bg: '#E8B73E', ink: '#5A4304'},
    });
  });

  it('fails closed on an unknown custom field', () => {
    const audit = buildDestinationAudit({
      sections: SECTIONS,
      customFieldSettings: [...CF_SETTINGS, {custom_field: {gid: 'cfX', name: 'Brand New Field', type: 'text'}}],
      users: USERS,
      profilesByEmail: PROFILES_BY_EMAIL,
    });
    expect(audit.ok).toBe(false);
    expect(audit.unmapped).toEqual([
      {kind: 'field', id: 'cfX', name: 'Brand New Field', reason: 'no destination in CF_DESTINATIONS'},
    ]);
  });

  it('fails closed on an unknown section, unmapped story type, and live dependencies', () => {
    const audit = buildDestinationAudit({
      sections: [...SECTIONS, {gid: 's9', name: 'WCF Goat Processing'}],
      customFieldSettings: CF_SETTINGS,
      users: USERS,
      storyTypeCounts: {comment: 3, weird_type: 2},
      dependencyCount: 4,
      profilesByEmail: PROFILES_BY_EMAIL,
    });
    expect(audit.ok).toBe(false);
    const kinds = audit.unmapped.map((u) => u.kind).sort();
    expect(kinds).toEqual(['dependency', 'section', 'story_type']);
  });

  it('treats users without profiles as mapped (display-name fallback) but identity-less users as unmapped', () => {
    const audit = buildDestinationAudit({
      sections: SECTIONS,
      customFieldSettings: CF_SETTINGS,
      users: [...USERS, {gid: '105'}],
      profilesByEmail: PROFILES_BY_EMAIL,
    });
    expect(audit.ok).toBe(false);
    expect(audit.unmapped).toEqual([{kind: 'user', id: '105', name: null, reason: 'no name or email identity'}]);
    const brian = audit.users.find((u) => u.gid === '103');
    expect(brian.profile_id).toBeNull(); // name fallback, not unmapped
  });
});

describe('mergeTemplateChecklistAssignees', () => {
  it('carries planner-side assignees across a re-import by label (first unconsumed match)', () => {
    const imported = [
      {label: 'A', assignee: null},
      {label: 'B', assignee: null},
      {label: 'A', assignee: null},
    ];
    const active = [
      {label: 'B', assignee: 'Ronnie Jones', assignee_profile_id: 'prof-ronnie'},
      {label: 'A', assignee: null, assignee_profile_id: 'prof-isabel'},
    ];
    const merged = mergeTemplateChecklistAssignees(imported, active);
    expect(merged).toEqual([
      {label: 'A', assignee: null, assignee_profile_id: 'prof-isabel'},
      {label: 'B', assignee: 'Ronnie Jones', assignee_profile_id: 'prof-ronnie'},
      {label: 'A', assignee: null}, // second A: no unconsumed match left
    ]);
  });
  it('renamed steps intentionally reset their assignment', () => {
    const merged = mergeTemplateChecklistAssignees(
      [{label: 'New name'}],
      [{label: 'Old name', assignee_profile_id: 'prof-x'}],
    );
    expect(merged).toEqual([{label: 'New name'}]);
  });
});
