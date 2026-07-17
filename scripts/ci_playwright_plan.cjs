#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const FULL_LABELS = new Set(['full-e2e', 'high-risk']);

const HIGH_RISK = [
  /^\.github\/workflows\//,
  /^playwright(?:\.[^/]+)?\.config\.(?:js|cjs|mjs|ts)$/,
  /^package(?:-lock)?\.json$/,
  /^scripts\/build_test_bootstrap\.js$/,
  /^tests\/(?:setup|fixtures|helpers)\//,
  /^tests\/global\.setup\./,
  /^supabase-migrations\//,
  /^supabase-functions\//,
  /^supabase\/functions\//,
  /^src\/auth\//,
  /^src\/contexts\/(?:Auth|Session|Role)/,
  /^src\/components\/(?:Header|Protected|AppShell|Role)/,
  /^src\/(?:main|App)\.jsx$/,
  /^src\/lib\/(?:auth|session|role|permissions?)/i,
  /^src\/lib\/(?:offlineQueue|activityEntity|supabase)/,
  /^public\/(?:sw|service-worker)\./,
];

const DOC_ONLY = [/^(?:HO|PROJECT|README|AGENTS)\.md$/, /^archive\//, /^docs\//, /^\.codex\//];

const PASTURE = [
  /^src\/pasture\//,
  /^src\/lib\/pasture/i,
  /^tests\/pasture_map_.*\.spec\.js$/,
  /^playwright\.pasture\.config\.js$/,
  /^supabase-migrations\/[0-9_]*pasture/i,
];

const SURFACES = [
  {
    name: 'layer',
    source: [/^src\/layer\//, /^src\/lib\/(?:animalHistory|layerHousing|layerBatchStats)/],
    specs: [/^tests\/(?:animal_history_page|layer_sequence_nav)\.spec\.js$/],
  },
  {
    name: 'newsletter',
    source: [/^src\/newsletter\//, /^src\/lib\/newsletter/i],
    specs: [/^tests\/newsletter_.*\.spec\.js$/],
  },
  {
    name: 'equipment',
    source: [
      /^src\/(?:equipment|admin\/Equipment)/,
      /^src\/admin\/(?:Fuel|Equipment)/,
      /^src\/webforms\/Equipment/,
      /^src\/lib\/(?:equipment|fuel)/i,
    ],
    specs: [/^tests\/(?:equipment_|fuel_|home_dashboard_equipment).*\.spec\.js$/],
  },
  {
    name: 'processing',
    source: [/^src\/processing\//, /^src\/lib\/processing/i],
    specs: [
      /^tests\/processing_.*\.spec\.js$/,
      /^tests\/(?:cattle|sheep)_send_to_processor\.spec\.js$/,
      /^tests\/pig_send_to_planned_trip\.spec\.js$/,
    ],
  },
  {
    name: 'tasks',
    source: [/^src\/(?:tasks|todo)\//, /^src\/lib\/(?:task|todo)/i],
    specs: [
      /^tests\/(?:tasks_v2_|todo_|task_sequence_nav|notifications_task_completed|generate_task_instances_rpc).*\.spec\.js$/,
    ],
  },
  {
    name: 'cattle',
    source: [/^src\/cattle\//, /^src\/lib\/cattle/i],
    specs: [/^tests\/(?:cattle_|animal_transfer).*\.spec\.js$/],
  },
  {
    name: 'sheep',
    source: [/^src\/sheep\//, /^src\/lib\/sheep/i],
    specs: [/^tests\/sheep_.*\.spec\.js$/],
  },
  {
    name: 'pig',
    source: [/^src\/pig\//, /^src\/lib\/pig/i],
    specs: [/^tests\/pig_.*\.spec\.js$/],
  },
  {
    name: 'broiler',
    source: [/^src\/broiler\//, /^src\/lib\/broiler/i],
    specs: [/^tests\/(?:broiler_|admin_broiler_).*\.spec\.js$/],
  },
  {
    name: 'livestock weigh-in',
    source: [/^src\/livestock\//, /^src\/lib\/weigh/i],
    specs: [/^tests\/(?:weigh|record_sequence_nav_fixed).*\.spec\.js$/],
  },
  {
    name: 'daily reports',
    source: [/^src\/daily\//, /^src\/dailys\//, /^src\/lib\/daily/i],
    specs: [/^tests\/(?:daily_|add_feed_parent_submission|feed_).*\.spec\.js$/],
  },
  {
    name: 'home',
    source: [/^src\/home\//, /^src\/components\/Home/, /^src\/lib\/weather/i],
    specs: [/^tests\/(?:home_|light_home_).*\.spec\.js$/],
  },
  {
    name: 'PWA',
    source: [/^src\/pwa\//, /^src\/lib\/pwa/i],
    specs: [/^tests\/pwa_.*\.spec\.js$/],
  },
];

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

function normalizeFiles(files) {
  return [...new Set(files.map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean))].sort();
}

function discoverRootSpecs(rootDir = process.cwd()) {
  const testsDir = path.join(rootDir, 'tests');
  if (!fs.existsSync(testsDir)) return [];
  return fs
    .readdirSync(testsDir, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.js'))
    .map((entry) => `tests/${entry.name}`)
    .filter((file) => !file.startsWith('tests/pasture_map_'))
    .filter((file) => !/(?:screenshots|ux_audit)\.spec\.js$/.test(file))
    .sort();
}

function planPlaywright({
  files,
  labels = [],
  event = 'pull_request',
  forceFull = false,
  trustedPrMerge = false,
  rootDir,
} = {}) {
  const changed = normalizeFiles(files || []);
  const normalizedLabels = new Set((Array.isArray(labels) ? labels : []).map((label) => String(label).toLowerCase()));
  const rootSpecs = discoverRootSpecs(rootDir);
  const pasture = changed.some((file) => matchesAny(file, PASTURE));

  if (event === 'schedule' || forceFull || [...normalizedLabels].some((label) => FULL_LABELS.has(label))) {
    return {mode: 'full', pasture, specs: [], reason: 'scheduled, manual, or explicitly labelled full run'};
  }

  if (event === 'push' && trustedPrMerge) {
    return {
      mode: 'none',
      pasture: false,
      specs: [],
      reason: 'GitHub PR merge already evaluated at its combined head; DB-free main verification only',
    };
  }

  if (changed.length === 0) {
    return {mode: 'full', pasture: true, specs: [], reason: 'changed-file diff unavailable; failed safe to full'};
  }

  const highRiskFile = changed.find((file) => matchesAny(file, HIGH_RISK));
  if (highRiskFile) {
    return {mode: 'full', pasture, specs: [], reason: `high-risk path: ${highRiskFile}`};
  }

  const rootTestChanges = changed.filter((file) => /^tests\/[^/]+\.spec\.js$/.test(file) && !matchesAny(file, PASTURE));
  const selected = new Set(rootTestChanges);
  const covered = new Set(
    changed.filter(
      (file) =>
        matchesAny(file, DOC_ONLY) ||
        matchesAny(file, PASTURE) ||
        /^tests\/static\//.test(file) ||
        /\.test\.[cm]?js$/.test(file),
    ),
  );

  for (const surface of SURFACES) {
    const surfaceFiles = changed.filter((file) => matchesAny(file, surface.source));
    if (surfaceFiles.length === 0) continue;
    surfaceFiles.forEach((file) => covered.add(file));
    rootSpecs.filter((spec) => matchesAny(spec, surface.specs)).forEach((spec) => selected.add(spec));
  }
  rootTestChanges.forEach((file) => covered.add(file));

  const unknown = changed.filter((file) => !covered.has(file));
  if (unknown.length > 0) {
    return {mode: 'full', pasture, specs: [], reason: `unclassified path: ${unknown[0]}`};
  }

  const specs = [...selected].filter((spec) => rootSpecs.includes(spec)).sort();
  if (specs.length > 0) {
    return {mode: 'focused', pasture, specs, reason: `focused coverage for ${specs.length} spec file(s)`};
  }

  return {
    mode: 'none',
    pasture,
    specs: [],
    reason: pasture ? 'pasture-only browser coverage' : 'DB-free/docs/unit-only change',
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return result;
}

function safeOutput(value) {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const files = args.files && fs.existsSync(args.files) ? fs.readFileSync(args.files, 'utf8').split(/\r?\n/) : [];
  let labels = [];
  try {
    labels = JSON.parse(args.labels || '[]');
  } catch {
    labels = [];
  }
  const plan = planPlaywright({
    files,
    labels,
    event: args.event,
    forceFull: args['force-full'] === 'true',
    trustedPrMerge: args['trusted-pr-merge'] === 'true',
  });
  process.stdout.write(`mode=${plan.mode}\n`);
  process.stdout.write(`pasture=${plan.pasture}\n`);
  process.stdout.write(`specs_json=${JSON.stringify(plan.specs)}\n`);
  process.stdout.write(`reason=${safeOutput(plan.reason)}\n`);
}

module.exports = {planPlaywright};
