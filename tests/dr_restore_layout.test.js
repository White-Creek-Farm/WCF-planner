import {describe, it, expect} from 'vitest';
import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const RL = require('../scripts/lib/dr_restore_layout.cjs');

const REF = 'abcdefghij0123456789';
const good = () => ({
  projectRef: REF,
  projectUrl: `https://${REF}.supabase.co`,
  dsn: `postgresql://postgres:secretpw@db.${REF}.supabase.co:5432/postgres`,
  confirmation: `RESTORE INTO ${REF}`,
});

describe('recovery destination guard — structural, deny by default', () => {
  it('accepts a well-formed destination and returns the decoded password', () => {
    const r = RL.assertRecoveryDestination(good());
    expect(r.ok).toBe(true);
    expect(r.projectRef).toBe(REF);
    expect(r.dsnPassword).toBe('secretpw');
  });

  it('decodes a percent-encoded password for redaction registration', () => {
    const c = good();
    c.dsn = `postgresql://postgres:p%40ss%2Fword@db.${REF}.supabase.co:5432/postgres`;
    expect(RL.assertRecoveryDestination(c).dsnPassword).toBe('p@ss/word');
  });

  it('refuses every known PROD/TEST reference', () => {
    for (const ref of Object.keys(RL.FORBIDDEN_PROJECT_REFS)) {
      const c = {
        projectRef: ref,
        projectUrl: `https://${ref}.supabase.co`,
        dsn: `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`,
        confirmation: `RESTORE INTO ${ref}`,
      };
      expect(() => RL.assertRecoveryDestination(c)).toThrow(/never a restore target/);
    }
  });

  it('refuses a DSN host that is a forbidden project (exact-host mismatch)', () => {
    const c = good();
    c.dsn = 'postgresql://postgres:pw@db.pzfujbjtayhkdlxiblwe.supabase.co:5432/postgres';
    expect(() => RL.assertRecoveryDestination(c)).toThrow(/DSN host must be exactly/);
  });

  it('refuses a lookalike DSN host (suffix trick)', () => {
    const c = good();
    c.dsn = `postgresql://postgres:pw@db.${REF}.supabase.co.evil.com:5432/postgres`;
    expect(() => RL.assertRecoveryDestination(c)).toThrow(/DSN host must be exactly/);
  });

  it('refuses a non-postgresql protocol, wrong db, and wrong user', () => {
    expect(() =>
      RL.assertRecoveryDestination({...good(), dsn: `https://postgres:pw@db.${REF}.supabase.co/postgres`}),
    ).toThrow(/postgresql: protocol/);
    expect(() =>
      RL.assertRecoveryDestination({...good(), dsn: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/otherdb`}),
    ).toThrow(/DSN database must be postgres/);
    expect(() =>
      RL.assertRecoveryDestination({...good(), dsn: `postgresql://root:pw@db.${REF}.supabase.co:5432/postgres`}),
    ).toThrow(/direct-connection user postgres/);
  });

  it('refuses a DSN with a query string or fragment', () => {
    expect(() =>
      RL.assertRecoveryDestination({
        ...good(),
        dsn: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?host=evil`,
      }),
    ).toThrow(/no query string or fragment/);
    expect(() =>
      RL.assertRecoveryDestination({...good(), dsn: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres#x`}),
    ).toThrow(/no query string or fragment/);
  });

  it('refuses credentials that smuggle a supabase domain or forbidden ref', () => {
    expect(() =>
      RL.assertRecoveryDestination({
        ...good(),
        dsn: `postgresql://postgres:supabase.co@db.${REF}.supabase.co:5432/postgres`,
      }),
    ).toThrow(/must not embed a project reference or supabase domain/);
    expect(() =>
      RL.assertRecoveryDestination({
        ...good(),
        dsn: `postgresql://postgres:pzfujbjtayhkdlxiblwe@db.${REF}.supabase.co:5432/postgres`,
      }),
    ).toThrow(/must not embed a project reference or supabase domain/);
  });

  it('refuses a project URL that is http, has a path/query, or carries credentials', () => {
    expect(() => RL.assertRecoveryDestination({...good(), projectUrl: `http://${REF}.supabase.co`})).toThrow(
      /must be https/,
    );
    expect(() => RL.assertRecoveryDestination({...good(), projectUrl: `https://${REF}.supabase.co/x`})).toThrow(
      /no path, query, or fragment/,
    );
    expect(() => RL.assertRecoveryDestination({...good(), projectUrl: `https://u:p@${REF}.supabase.co`})).toThrow(
      /must not carry credentials/,
    );
  });

  it('refuses missing fields, malformed ref, and wrong confirmation without echoing the DSN', () => {
    for (const k of ['projectRef', 'projectUrl', 'dsn', 'confirmation']) {
      const c = good();
      delete c[k];
      expect(() => RL.assertRecoveryDestination(c)).toThrow(new RegExp(`missing required destination field "${k}"`));
    }
    expect(() => RL.assertRecoveryDestination({...good(), projectRef: 'short'})).toThrow(/not a valid 20-char/);
    try {
      RL.assertRecoveryDestination({...good(), confirmation: 'nope'});
    } catch (e) {
      expect(e.message).not.toContain('secretpw');
      expect(e.message).toMatch(/confirmation string must be exactly/);
    }
  });
});

describe('R2 source pinning', () => {
  const okSrc = () => ({
    endpoint: `https://${RL.APPROVED_R2.endpointHost}`,
    bucket: RL.APPROVED_R2.bucket,
    region: 'auto',
  });
  it('accepts the exact approved endpoint/bucket/region', () => {
    expect(RL.assertR2Source(okSrc())).toEqual({ok: true});
  });
  it('refuses http, wrong host, wrong bucket, wrong region, path, and port', () => {
    expect(() => RL.assertR2Source({...okSrc(), endpoint: `http://${RL.APPROVED_R2.endpointHost}`})).toThrow(
      /must be https/,
    );
    expect(() => RL.assertR2Source({...okSrc(), endpoint: 'https://s3.amazonaws.com'})).toThrow(
      /approved Cloudflare endpoint/,
    );
    expect(() => RL.assertR2Source({...okSrc(), bucket: 'some-other-bucket'})).toThrow(/approved DR secondary bucket/);
    expect(() => RL.assertR2Source({...okSrc(), region: 'us-east-1'})).toThrow(/region must be auto/);
    expect(() => RL.assertR2Source({...okSrc(), endpoint: `https://${RL.APPROVED_R2.endpointHost}/path`})).toThrow(
      /no path, query, or fragment/,
    );
    expect(() => RL.assertR2Source({...okSrc(), endpoint: `https://${RL.APPROVED_R2.endpointHost}:8443`})).toThrow(
      /must not specify a port/,
    );
  });
});

describe('path containment (canonical, case-insensitive on Windows)', () => {
  it('treats the repo root and files inside it as inside; siblings as outside', () => {
    const repo = 'C:\\Users\\Ronni\\WCF-planner';
    expect(RL.pathIsInside(repo, repo, {win: true})).toBe(true);
    expect(RL.pathIsInside(repo + '\\scripts\\x.cjs', repo, {win: true})).toBe(true);
    expect(RL.pathIsInside('C:\\Users\\Ronni\\other', repo, {win: true})).toBe(false);
    // Prefix that is not a path boundary is NOT inside.
    expect(RL.pathIsInside('C:\\Users\\Ronni\\WCF-planner-cc1', repo, {win: true})).toBe(false);
  });
  it('ignores case on Windows so a casing change cannot bypass the refusal', () => {
    expect(RL.pathIsInside('c:\\users\\ronni\\wcf-planner\\x', 'C:\\Users\\Ronni\\WCF-planner', {win: true})).toBe(
      true,
    );
  });
});

describe('plaintext location (C:/BitLocker only)', () => {
  const repo = 'C:\\Users\\Ronni\\WCF-planner';
  it('accepts a dedicated dir on C: outside the repo and cloud folders', () => {
    expect(RL.assertPlaintextLocation('C:\\wcf-dr-restore', {repoReal: repo, win: true})).toEqual({ok: true});
  });
  it('refuses another drive, inside the repo, and cloud-synced folders', () => {
    expect(() => RL.assertPlaintextLocation('D:\\tmp', {repoReal: repo, win: true})).toThrow(
      /device-encrypted C: drive/,
    );
    expect(() => RL.assertPlaintextLocation(repo + '\\tmp', {repoReal: repo, win: true})).toThrow(
      /OUTSIDE the repository/,
    );
    expect(() => RL.assertPlaintextLocation('C:\\Users\\Ronni\\OneDrive\\dr', {repoReal: repo, win: true})).toThrow(
      /cloud-synced/,
    );
  });
});

describe('generation pinning + source keys', () => {
  it('accepts an exact run id and refuses symbolic/malformed', () => {
    expect(RL.requireExplicitGeneration('20260724T180923Z')).toBe('20260724T180923Z');
    for (const g of ['latest', 'current', 'newest', '', '2026-07-24'])
      expect(() => RL.requireExplicitGeneration(g)).toThrow();
  });
  it('computes db/manifest/storage keys with @runId storage suffix', () => {
    const k = RL.restoreSourceKeys('20260724T180923Z', 'hourly');
    expect(k.dbPackage).toBe('db/hourly/2026/07/24/wcf-db-20260724T180923Z.dump.age');
    expect(k.storageManifest).toBe('storage/manifests/2026/07/24/storage-20260724T180923Z.json');
    expect(k.storageObjectKey('daily-photos', 'a/b.jpg')).toBe('storage/objects/daily-photos/a/b.jpg@20260724T180923Z');
  });
});

const goodManifest = () => ({
  run_id: '20260724T180923Z',
  env: 'prod',
  tier: 'hourly',
  coverage: 'database-and-storage',
  physical_retention: {policy: 'indefinite'},
  database: {
    dump_bytes: 2359296,
    dump_sha256: 'a'.repeat(64),
    encrypted_sha256: 'b'.repeat(64),
    encryption: 'age-asymmetric',
  },
  storage: {
    total_objects: 2,
    total_bytes: 30,
    objects: [
      {bucket: 'daily-photos', path: 'a.jpg', size: 10},
      {bucket: 'task-photos', path: 'b.png', size: 20},
    ],
  },
  not_backed_up: {vault_secret_names: ['x'], cron_jobs: [], extensions: ['pg_net']},
});

describe('manifest verification + dual-manifest agreement', () => {
  it('passes a good manifest and rejects coverage/checksum/count problems', () => {
    expect(RL.verifyManifest(goodManifest(), {runId: '20260724T180923Z', tier: 'hourly'}).ok).toBe(true);
    const m = goodManifest();
    m.coverage = 'database-only';
    m.database.dump_sha256 = 'bad';
    m.storage.total_objects = 99;
    const r = RL.verifyManifest(m, {runId: '20260724T180923Z', tier: 'hourly'});
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  it('requires both manifests present and byte-identical in defining fields', () => {
    expect(RL.assertManifestsAgree(goodManifest(), goodManifest())).toEqual({ok: true});
    const b = goodManifest();
    b.storage.objects[0].size = 999;
    expect(() => RL.assertManifestsAgree(goodManifest(), b)).toThrow(/manifests disagree on "storage"/);
    expect(() => RL.assertManifestsAgree(goodManifest(), null)).toThrow(/storage manifest missing/);
  });
  it('sanitizes untrusted manifest content (control chars stripped, bounded)', () => {
    const m = goodManifest();
    m.coverage = 'x' + String.fromCharCode(0, 0x1f) + 'y'.repeat(300);
    const r = RL.verifyManifest(m, {runId: '20260724T180923Z', tier: 'hourly'});
    const line = r.errors.find((e) => e.includes('coverage'));
    expect([...line].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
    expect(line.length).toBeLessThan(120);
  });
});

describe('checksum + byte-count assertions', () => {
  it('passes on match, throws on mismatch or bad expected', () => {
    expect(RL.assertSha256('a'.repeat(64), 'a'.repeat(64), 'db')).toBe(true);
    expect(() => RL.assertSha256('a'.repeat(64), 'b'.repeat(64), 'db')).toThrow(/checksum mismatch/);
    expect(RL.assertByteCount(100, 100, 'db')).toBe(true);
    expect(() => RL.assertByteCount(99, 100, 'db')).toThrow(/byte count mismatch/);
    expect(() => RL.assertByteCount(100, 0, 'db')).toThrow(/no valid expected byte count/);
  });
});

describe('selective restore TOC policy (fail-closed, explicit allowlist)', () => {
  const line = (id, desc, schema, tag, owner = 'postgres') => `${id}; 1 2 ${desc} ${schema} ${tag} ${owner}`;
  // A realistic TOC covering SCHEMA, EXTENSION, TABLE, TABLE DATA, SEQUENCE,
  // SEQUENCE SET, FUNCTION, TYPE, FK CONSTRAINT, TRIGGER, INDEX, COMMENT, ACL, and
  // managed-schema entries (auth/storage), including allowed + disallowed DATA.
  const toc = [
    '; Archive created ...',
    line(1, 'SCHEMA', '-', 'public'),
    line(2, 'SCHEMA', '-', 'auth'),
    line(3, 'EXTENSION', '-', 'pg_stat_statements', '-'),
    line(4, 'TYPE', 'public', 'my_enum'),
    line(5, 'TABLE', 'public', 'animals'),
    line(6, 'SEQUENCE', 'public', 'animals_id_seq'),
    line(7, 'SEQUENCE SET', 'public', 'animals_id_seq'),
    line(8, 'FUNCTION', 'public', 'fn(integer)'),
    line(9, 'TABLE DATA', 'public', 'animals'),
    line(10, 'FK CONSTRAINT', 'public', 'animals animals_fkey'),
    line(11, 'TRIGGER', 'public', 'animals trg_x'),
    line(12, 'INDEX', 'public', 'animals_pkey'),
    line(13, 'COMMENT', '-', 'SCHEMA public'),
    line(14, 'ACL', 'public', 'animals'),
    line(15, 'TABLE DATA', 'auth', 'users'),
    line(16, 'TABLE DATA', 'auth', 'identities'),
    line(17, 'TABLE DATA', 'auth', 'sessions'),
    line(18, 'TABLE', 'auth', 'users'),
    line(19, 'FUNCTION', 'storage', 'foldername'),
    line(20, 'TABLE DATA', 'storage', 'buckets'),
    line(21, 'TABLE DATA', 'storage', 'objects'),
  ].join('\n');

  it('parses every non-comment line fail-closed (unknown desc / malformed throws)', () => {
    expect(RL.parseRestoreList(toc)).toHaveLength(21);
    expect(() => RL.parseRestoreList('12; 1 2 BOGUSDESC public x postgres')).toThrow(/unknown TOC object type/);
    expect(() => RL.parseRestoreList('12; 1 2')).toThrow(/unparseable/);
  });

  it('decides include/exclude/refuse by desc+schema+tag', () => {
    expect(RL.tocDecision({desc: 'TABLE', schema: 'public', tag: 'x'})).toBe('include');
    expect(RL.tocDecision({desc: 'SCHEMA', schema: '-', tag: 'public'})).toBe('exclude');
    expect(RL.tocDecision({desc: 'ACL', schema: 'public', tag: 'x'})).toBe('exclude');
    expect(RL.tocDecision({desc: 'TABLE DATA', schema: 'auth', tag: 'users'})).toBe('include');
    expect(RL.tocDecision({desc: 'TABLE DATA', schema: 'auth', tag: 'sessions'})).toBe('exclude');
    expect(RL.tocDecision({desc: 'TABLE DATA', schema: 'storage', tag: 'objects'})).toBe('exclude');
    expect(RL.tocDecision({desc: 'TABLE DATA', schema: 'storage', tag: 'buckets'})).toBe('include');
    expect(RL.tocDecision({desc: 'TABLE', schema: 'auth', tag: 'users'})).toBe('exclude');
    // Not understood → refuse the whole restore.
    expect(RL.tocDecision({desc: 'TABLE', schema: 'otherschema', tag: 'x'})).toBe('refuse');
    expect(RL.tocDecision({desc: 'POLICY', schema: '-', tag: 'x'})).toBe('refuse');
  });

  it('builds a list with public DDL+data + only allowlisted managed DATA; never SCHEMA/ACL/managed DDL/storage.objects', () => {
    const {list, included, excluded} = RL.buildSelectiveRestoreList(RL.parseRestoreList(toc));
    const inKeys = included.map((e) => `${e.desc}/${e.schema}.${e.tag}`);
    expect(inKeys).toContain('TABLE DATA/auth.users');
    expect(inKeys).toContain('TABLE DATA/auth.identities');
    expect(inKeys).toContain('TABLE DATA/storage.buckets');
    expect(inKeys).toContain('TABLE/public.animals');
    expect(inKeys).not.toContain('TABLE DATA/storage.objects');
    expect(inKeys).not.toContain('TABLE DATA/auth.sessions');
    expect(list).not.toMatch(/SCHEMA - (public|auth)/);
    expect(list).not.toContain('storage objects');
    expect(list).not.toContain('ACL public');
    // storage.objects, auth.sessions, managed DDL, SCHEMA, ACL, EXTENSION excluded.
    expect(excluded.length).toBe(9);
  });

  it('refuses an empty TOC, a not-understood entry, and a missing allowlisted table', () => {
    expect(() => RL.buildSelectiveRestoreList([])).toThrow(/empty or unparseable TOC/);
    const withUnknown = RL.parseRestoreList(toc + '\n' + line(99, 'TABLE', 'weird', 'x'));
    expect(() => RL.buildSelectiveRestoreList(withUnknown)).toThrow(/not understood\/approved/);
    const missing = RL.parseRestoreList(
      [line(1, 'TABLE DATA', 'auth', 'users'), line(2, 'TABLE DATA', 'public', 'x')].join('\n'),
    );
    expect(() => RL.buildSelectiveRestoreList(missing)).toThrow(/missing required managed data auth\.identities/);
  });
});
