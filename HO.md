# HO - Static Workflow SOP

Last updated: 2026-05-23.

This is the durable start-of-session workflow for Ronnie, CC (Claude Code), and
Codex. It is not a session log and must not carry current project state.

Current state, roadmap, architecture, contracts, and build history live in
[PROJECT.md](PROJECT.md).

Read order for every new session:

1. Read `HO.md`.
2. Read the relevant sections of `PROJECT.md`.
3. Inspect the repo before planning or editing.

Do not create extra handoff docs, session indexes, or archive notes unless
Ronnie explicitly asks. Docs are updated only during Ronnie-requested
wrap/docs work or when Ronnie asks for a specific doc change.

---

## Roles

Ronnie is product owner and final decision-maker. Ronnie does not run tests,
migrations, `psql`, deploys, or PROD verification when CC has the access to do
it.

CC is the primary builder. CC reads the lane context, edits files, runs
validation, applies approved Supabase work, pushes back on risk, and reports
results.

Codex is planning lead and reviewer. Codex scopes lanes, reads the repo/docs,
names contracts/files/tests/gates, reviews CC reports, and writes CC-ready
prompts.

Everything outside an explicit Codex edit request is Claude-owned by default.
Codex may edit docs/prompts/planning files when Ronnie asks.

---

## Authority And Gates

Ronnie alone approves commits, pushes, deploys, merges, destructive actions, and
production-impacting changes.

Each gate is separate:

- Commit approval does not imply push approval.
- Push approval does not imply migration/function/Vault approval.
- Push to `main` implies Netlify production runtime change for code-only lanes.

Production gates:

| Action | Required gate |
|---|---|
| Push to `main` | Push approval |
| PROD `psql` migration apply | Separate PROD apply approval |
| Supabase Edge Function deploy | Separate deploy approval |
| Vault secret add/rotate | Separate Vault approval |
| TEST DB migration apply | No separate gate inside an approved lane |
| Validation commands | No gate |

Lane approval can cover SQL writes, Vault checks, function deploys, and
migration applies inside that lane only when the approval says so. Commit, push,
deploy, and merge still remain separate.

`exec_sql` in PROD is forbidden under every approval shape.

CC owns approved Supabase execution and verification. Do not route routine SQL,
migration applies, function deploys, Vault checks, or PROD verification back to
Ronnie when CC has the needed access.

---

## Git And Branches

Default branch names when a feature branch is used:

- `feature/<short-lane-name>`
- `fix/<short-bug-name>`
- `hotfix/<short-incident-name>`
- `docs/<short-doc-name>`

Do not rename/reorganize branches unless Ronnie asks.

If a PR exists, its body should hold the detailed build report. Chat summaries
stay short.

---

## Session Start

Before planning or editing:

- Read `HO.md`.
- Read `PROJECT.md` Current State, Active Roadmap, and relevant Contracts.
- Run `git status --short`.
- Check recent git log.
- Inspect relevant source/test/migration files.

Codex must identify the working queue before planning: current lane, next lane,
paused work, open gates, hotfixes, known blockers, and dirty-tree risks. Use
`PROJECT.md`, git state, and source files; do not rely on chat memory alone.

If a lane touches a load-bearing contract, call that out before editing.

---

## Core Loop

1. Ronnie chooses the lane or question.
2. Codex investigates and writes a CC-ready plan or review.
3. Ronnie relays the `From Codex:` block to CC.
4. CC builds, validates, and reports back with `From CC:`.
5. Codex reviews and either pushes back or clears the next gate.
6. Ronnie approves or redirects commit, push, deploy, merge, wrap, or next lane.

After a clean checkpoint, Codex provides the next CC-ready prompt or names the
exact blocker. Do not ask CC to choose the next scope.

Keep a working queue during the session. Hotfixes may interrupt the queue, but
return to the paused lane afterward.

---

## Scope, Hotfixes, And Questions

Once Ronnie approves a build plan, scope is frozen.

CC/Codex may still push back if new facts show risk, bad assumptions, missing
contracts, or a better path. Product behavior, data model, permissions,
business workflow, and UI meaning changes go back through Codex and Ronnie.

Hotfixes stay small:

- Name the production symptom and affected surface.
- Identify whether source, migration, secret, deploy, or data action is needed.
- Avoid adjacent cleanup.
- Run focused validation plus any high-risk adjacent regression.
- Return to the paused lane after verification.

Ask only blocking questions. If the answer is in docs, code, schema, or prior
Ronnie decisions, use it and state the assumption. If many questions are
needed, send one compact decision packet with recommended defaults.

---

## Relay Format

CC updates intended for Codex start with:

`From CC:`

Codex prompts or reviews intended for CC start with:

`From Codex:`

Use those prefixes exactly. Inside copyable relay blocks, keep content plain
text. Avoid Markdown backticks around file paths, route names, function names,
commands, or commit subjects so Ronnie can paste the block cleanly.

If CC or Codex disagrees, state:

- Concrete risk.
- Recommended path.
- What proof would settle it.

Then Ronnie decides.

---

## Required CC Build Summary

Chat-side `From CC:` should be summary-first and short enough for one-glance
review. Include:

- Branch/working-tree state.
- One-line purpose.
- Files changed.
- What changed.
- Validation results.
- Skipped validation and residual risk.
- Migration/schema/RLS/storage/deploy impact.
- Known risks and excluded scope.
- Requested gates.

Detailed RPC contracts, exhaustive verification notes, and long implementation
reports belong in the PR body or a clearly separated appendix, not the main
chat block.

---

## Required Codex Prompt

A CC-ready `From Codex:` prompt should include:

- Goal.
- Scope and out-of-scope.
- Relevant `PROJECT.md` contracts.
- Likely files/areas touched.
- Product, UX, permission, and data-model decisions.
- Required validation.
- Commit/push/deploy/doc gates.
- Open blockers, if any.

Prompts should be copyable and direct.

---

## Review Outcomes

Use these outcomes when possible:

- `Blocked` - prerequisite or major design issue.
- `Needs fixes` - close, but changes are required before the next gate.
- `Ready for next checkpoint` - checkpoint is clean; next build step can begin.
- `Ready to commit` - review and validation are clean for commit approval.
- `Ready to push` - committed work is clean for push approval.
- `Pushed, next prompt follows` - push is reported complete and the next prompt
  is included.

---

## Responsibilities

CC:

- Read relevant docs and files before planning.
- Walk touched load-bearing contracts.
- Keep edits scoped.
- Preserve unrelated user/agent changes.
- Use approved Supabase access instead of handing routine execution to Ronnie.
- Run lane-appropriate validation.
- Report files, gates, risks, skipped checks, and open questions.
- Do not update docs/wrap files unless Ronnie asks.

Codex:

- Do planning legwork before CC starts.
- Turn roadmap items into CC-ready prompts.
- Track queue, gates, paused work, and blockers.
- Review CC plans/build reports before gates.
- Push back on missed scope, unsafe order, weak tests, or contract drift.
- Keep CC-facing instructions concise and copyable.
- Do not edit source files unless Ronnie explicitly authorizes it.

---

## Validation

Default code-lane floor:

- `npm run format:check`
- `npm run lint`
- `npm test`
- `npm run build`
- Focused Playwright for the touched path.
- Adjacent regression Playwright when shared contracts are touched.

Docs-only changes may skip code tests when clearly disclosed.

Any skipped validation must state the reason and residual risk.

### PROD Migration Verification

After any PROD migration apply, CC reports:

- Precheck for fail-closed seed dependencies.
- Sequential `psql` apply against `PROD_DB_URL` with `ON_ERROR_STOP=1`.
- Post-apply verification for row counts, RLS, policies, RPC signatures,
  triggers, grants, and runtime impact where relevant.
- One-line PROD-impact statement.

Skipped checks must say what was skipped and why.

---

## Handoffs And Memory

If work pauses mid-build, CC leaves a compact `From CC:` status:

- Current branch/status.
- Completed work.
- Files touched.
- Validation already run.
- Next exact step.
- Blockers or decisions needed.

Do not assume Claude memory, Codex memory, or chat history is shared across
tools or sessions. Durable project truth goes in `PROJECT.md` only during
Ronnie-approved docs/wrap work. Current-session operational state can live in
chat.

---

## File Hygiene

Always check `git status --short` before staging, committing, or reporting a
clean tree.

Do not stage unrelated changes. Treat unexpected edits as user/agent work and
do not revert them unless Ronnie explicitly asks.

Prefer scoped staging by path. Do not stage generated reports, local env files,
or unrelated line-ending churn.

Do not update `PROJECT.md` during normal builds unless Ronnie explicitly asks.
