// Human labels for the admin Newsletter "Recent runs" / draft-history lists.
//
// A run row from list_newsletter_runs_admin has { runType, provider, status,
// createdAt }. These pure helpers turn that into a plain-language line so the
// admin can tell whether the last action was a planner fact harvest (no AI), an
// AI/template draft, a reminder task, or a publish — and whether it used the real
// AI provider or the offline template fallback. Kept pure + in src/lib so they
// are unit-testable under the node vitest environment.
//
// Note: the Edge Function logs both a first "write" and a later "revise" as the
// same `ai_draft` run type, so a run row alone can't distinguish those — the
// label stays honest ("Wrote draft") rather than guessing.

export function describeNewsletterRunProvider(provider) {
  if (provider === 'anthropic') return 'AI · Anthropic';
  if (provider === 'template') return 'Template';
  return '';
}

export function describeNewsletterRun(run) {
  const type = run && run.runType;
  switch (type) {
    case 'harvest':
      return {label: 'Gathered facts', detail: 'planner scan · no AI'};
    case 'ai_draft':
      return {label: 'Wrote draft', detail: describeNewsletterRunProvider(run && run.provider)};
    case 'task_create':
      return {label: 'Reminder task', detail: ''};
    case 'publish':
      return {label: 'Published', detail: ''};
    default:
      return {
        label: typeof type === 'string' && type ? type : 'Run',
        detail: describeNewsletterRunProvider(run && run.provider),
      };
  }
}

export function isRunError(run) {
  return !!run && run.status === 'error';
}

// Compact local timestamp for a run (e.g. "Jul 1, 2:05 PM"). Returns '' for a
// missing/invalid date so the caller can omit it cleanly.
export function formatRunTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}
