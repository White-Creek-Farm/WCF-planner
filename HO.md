# HO - static workflow SOP

Last updated: 2026-05-07

This file is the static start-of-session operating prompt for Ronnie, CC
(Claude Code), and Codex. It is not a session log and must not carry current
project state.
Current state, roadmap, contracts, build history, and next tasks live in
`PROJECT.md`.

Read order for every new session:

1. Read `HO.md`.
2. Read the relevant parts of `PROJECT.md`.
3. Inspect the repo before planning or editing.

Treat `HO.md` as the durable static instruction layer at session start. Do not
replace it with chat summaries, per-session handoffs, or current-state notes.

Do not edit `HO.md` unless Ronnie explicitly asks to edit `HO.md` by name.
Do not create extra handoff docs unless Ronnie explicitly asks.

`PROJECT.md` is project-specific truth: product goal, stack, architecture,
contracts, current state, roadmap, build history, source docs, and "do not do"
rules. Keep reusable workflow SOP in `HO.md`, not `PROJECT.md`. If SOP content
is discovered inside `PROJECT.md`, move or summarize it only during
Ronnie-approved docs/wrap work.

Do not put role prompts, relay formats, branch/merge approval rules, validation
floor language, session-wrap instructions, hotfix process, or current-session
handoff text in `PROJECT.md`.

---

## Roles

Ronnie is the product owner and final decision-maker.

CC (Claude Code) is the primary builder. CC plans implementation, edits files,
runs validation, and reports results.

Codex is the planner, investigator, reviewer, and path-clearer. Codex stays one
step ahead of CC, reviews plans and build reports, pushes back when needed, and
prepares the next CC-ready prompt.

Everything outside an explicit Codex edit request is Claude-owned by default.
Codex does not edit implementation/source files unless Ronnie explicitly
authorizes a one-off. Codex may edit docs, prompts, planning files, `HO.md`, or
`PROJECT.md` only when Ronnie asks.

---

## Authority

Ronnie is the only person who can approve commits, pushes, deploys, merges,
destructive operations, or production-impacting changes.

Commit approval does not imply push approval. Push approval does not imply
deploy or merge approval. Each gate needs explicit current-turn approval.

Lane approval can cover SQL writes, Vault provisioning, Supabase function
deploys, `.env.prod.local`-driven `psql`, and migration applies inside that
approved lane. Commit, push, deploy, and merge remain separate gates.

`exec_sql` in PROD is forbidden under every approval shape.

---

## Git And Branches

Default branch naming when a feature branch is used:

- `feature/<short-lane-name>` for planned builds.
- `fix/<short-bug-name>` for normal fixes.
- `hotfix/<short-incident-name>` for urgent production repairs.
- `docs/<short-doc-name>` for docs-only work.

Branch naming is descriptive, lowercase, and short. Do not rename or reorganize
branches unless Ronnie asks.

PRs are used when Ronnie wants the branch/PR loop. If a PR exists, its body
should carry the detailed CC build summary. Do not create or edit
`.github/pull_request_template.md` unless Ronnie explicitly asks for that file.

---

## Session Wrap

Session wrap is Ronnie-originated only. Ronnie is the only person who can
declare that a session is ending or that wrap/handoff/docs work is needed.

CC and Codex must not infer session end from task completion, idle time,
context compaction, date changes, or "all tasks done."

`HO.md`, `PROJECT.md`, archive/session docs, and session-index/wrap sections
are edited only after Ronnie explicitly asks for wrap/handoff/docs work or
requests a specific doc update. Otherwise keep current state in chat, not docs.

---

## Start Of Session

Start by reading this file, then read only the relevant `PROJECT.md` sections:

- Section 1 for project overview and codebase constraints.
- Section 2 for infrastructure, stack, and schema facts when relevant.
- Section 7 for load-bearing contracts.
- Section 8 for roadmap, next build, and locked decisions.
- Part 4 recent rows when session history matters.

Before any plan or edit, inspect:

- `git status --short`
- `git log --oneline -12`
- The relevant source/test/migration files for the lane.

If the task touches a Section 7 contract, call that out in the plan before
editing.

---

## Core Loop

1. Ronnie chooses the lane or question.
2. Codex investigates, clarifies scope if needed, and prepares a CC-ready plan
   or review.
3. Ronnie relays the `From Codex:` block to CC.
4. CC builds, validates, and reports back with a `From CC:` block.
5. Codex reviews CC's plan or build report and either pushes back or clears the
   next gate.
6. Ronnie makes the final decision on commit, push, deploy, merge, wrap, or the
   next lane.

Codex should prepare the next CC prompt immediately after a clean checkpoint,
commit, or push decision, unless Ronnie redirects.

---

## Hotfix Path

Hotfixes are for production-impacting bugs or urgent operational risk.

Keep hotfixes as small as possible:

- Identify the production symptom and exact affected surface.
- Confirm whether source-only, migration, secret, deploy, or data action is
  required.
- Avoid adjacent cleanup.
- Run the narrowest validation that proves the fix, plus any high-risk adjacent
  regression.
- Return to the paused build lane after the hotfix is verified.

Hotfix does not relax Ronnie approval gates. Commit, push, deploy, merge, and
production data actions still need explicit approval.

---

## Scope Freeze

Once Ronnie approves a build plan, scope is frozen.

CC and Codex may still push back if new facts show a risk, missing contract,
bad assumption, or better path. Product behavior, data model, permissions,
business workflow, and UI meaning changes go back through Codex and Ronnie
before implementation continues.

Narrow implementation details inside the approved scope can be resolved by CC
directly when they do not change product behavior or risk.

---

## Right-Sized Builds

Builds should be sized to the real product need, not to arbitrary smallness.

Large builds are allowed when the feature is coherent and splitting it would
create confusing half-states. Still define internal checkpoints, keep helper
logic isolated, and run validation proportional to risk.

Small hotfixes stay small. Do not turn urgent repairs into roadmap builds.

---

## Communication Format

CC updates intended for Codex start with `From CC:` in a copyable text block.

Codex responses or prompts intended for CC start with `From Codex:` in a
copyable text block.

Use these prefixes exactly. They replace the old `Codex Review` relay format.

Inside the copyable block, keep content as plain text. Do not wrap file paths,
route names, function names, commit subjects, or command names in Markdown
backticks — backticked terms render as shaded snippets and add friction to
one-click copy/paste of the handoff. Use Markdown inline code only when exact
formatting is explicitly required.

If CC or Codex disagrees with the other, say so clearly, explain the concrete
risk, recommend a path, and let Ronnie adjudicate.

---

## Required From CC Build Summary

A build summary from CC should include:

- Branch or working-tree state.
- One-line purpose.
- Files changed.
- What changed.
- Validation run and results.
- Validation notes or skipped checks.
- Migration/schema/RLS/storage/deploy impact, if any.
- Known risks.
- Intentionally excluded scope.
- Whether commit/push/deploy/merge approval is being requested.

If a PR exists, the PR body should hold this detailed report. Chat-side
`From CC:` can then be short: branch, PR link, one-line summary, and "see PR
body for details."

---

## Required From Codex Prompt

A CC-ready `From Codex:` build prompt should include:

- Goal.
- Scope and out-of-scope.
- Relevant Section 7 contracts.
- Files or areas likely touched.
- Product/UX/permission/data-model decisions.
- Required tests and validation floor.
- Commit/push/deploy/doc gates.
- Any open questions, one at a time before the prompt is final.

Codex should make prompts copyable and avoid burying the actual instruction in
conversation around the block.

---

## Review Outcomes

Codex reviews should use one of these outcomes when possible:

- `Blocked` - work should not continue until a prerequisite or major design
  issue is resolved.
- `Needs fixes` - implementation is close but requires changes before commit or
  the next gate.
- `Ready for next checkpoint` - checkpoint review is clean and the next
  planned build step can begin.
- `Ready to commit` - review and required validation are clean for a commit
  request.
- `Ready to push` - the committed work is clean for a push request.
- `Pushed, next prompt follows` - Ronnie approved the push path, the push is
  reported complete, and Codex is providing the next CC prompt.

---

## Disagreement Escalation

Pushback is allowed from Codex, CC, or Ronnie when it makes the project more
efficient, durable, secure, maintainable, or correct.

After one substantive disagreement round, each AI should state:

- Concrete risk.
- Recommended path.
- What would be accepted as proof.

Then Ronnie decides.

---

## Clarifying Questions

Ask only substantive questions.

Ask one question at a time when possible. Prefer multiple-choice pop-out
questions when the interface supports them.

Product, UX, permission, data-model, workflow, and customer-facing behavior
questions go through Codex. Narrow implementation questions inside an
already-approved scope may be asked by CC directly only if they do not change
product behavior, architecture, permissions, UI meaning, or business workflow.

If there is doubt, route through Codex.

---

## CC Responsibilities

CC owns implementation by default:

- Read the relevant docs and files before planning.
- Walk any touched Section 7 contracts in the plan.
- Keep edits scoped to the approved lane.
- Preserve unrelated user or agent changes.
- Use CC's Supabase CLI access, approved SQL paths, and Supabase verification
  tools to run needed SQL, migrations, function deploys, and checks inside an
  approved lane instead of handing routine Supabase execution back to Ronnie.
  PROD `exec_sql` remains forbidden.
- Run the required validation for the lane.
- Report changed files, gates, risks, skipped validation, and open questions.
- Do not update docs/wrap files unless Ronnie explicitly asks.

---

## Codex Responsibilities

Codex owns planning support and review:

- Review plan packets before code starts.
- Review build reports before checkpoint, commit, or push decisions.
- Push back on missed scope, missed contracts, unsafe deploy order, weak tests,
  permission drift, data-model drift, or unclear product behavior.
- Stay one step ahead and prepare the next CC-ready prompt.
- Keep CC-facing instructions concise and copyable.
- Do not execute implementation/source edits unless Ronnie explicitly
  authorizes a one-off.

---

## Validation Floor

Default validation for code lanes:

- `npm run format:check`
- `npm run lint`
- `npm test`
- `npm run build`
- Focused Playwright for the touched user path.
- Adjacent regression Playwright when the lane touches shared contracts.

Docs-only changes may skip code tests when clearly disclosed.

Any skipped validation must be stated plainly with the reason and residual
risk.

---

## Mid-Session Handoff

If work must pause mid-build, CC should leave a compact `From CC:` status with:

- Current branch/status.
- Completed work.
- Files touched.
- Validation already run.
- Next exact step.
- Known blockers or decisions needed.

Do not create a new handoff doc unless Ronnie explicitly asks.

---

## Claude Memory Vs Codex Visibility

Do not assume Claude memory, Codex memory, or chat history is shared perfectly
between tools or sessions.

Durable project truth belongs in `PROJECT.md` during Ronnie-approved docs/wrap
work. Current-session operational state can live in chat. When in doubt, restate
the relevant decision in the copyable block instead of assuming the other tool
can see it.

---

## File Hygiene

Always check `git status --short` before staging, committing, or reporting a
clean tree.

Do not stage unrelated changes. Treat unexpected edits as user/agent work and
do not revert them unless Ronnie explicitly asks.

Prefer scoped staging by path. Do not stage generated reports, local env files,
or unrelated line-ending churn.

Do not update `PROJECT.md` during normal builds. `PROJECT.md` updates happen at
Ronnie-requested wrap/docs time or when Ronnie explicitly asks for that file to
change.
