import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {TEAM_AVAILABILITY_FORM_KEYS} from '../../src/lib/teamAvailability.js';
import {_REGISTRY as RPC_REGISTRY} from '../../src/lib/offlineRpcForms.js';

// ============================================================================
// Public Tasks webform — C3 static-shape lock
// ============================================================================
// Locks the wiring so future refactors can't silently regress:
//   1. Routes map tasksWebform → /dailys/tasks (post 2026-05-06 rename).
//   2. main.jsx mounts TasksWebform on view='tasksWebform'.
//   3. WebformHub form selector exposes a Tasks tile pointing at
//      /dailys/tasks.
//   4. TasksWebform uses useOfflineRpcSubmit('task_submit') and passes
//      a stable `ti-...` parentId.
//   5. offlineRpcForms registry has a task_submit entry whose buildArgs
//      assembles parent_in with the C3 contract fields and uses the
//      caller-provided parentId (so 'ti-<uuid>' makes it through).
//   6. teamAvailability lists 'tasks-public' (10 keys total).
//   7. WebformsAdminView FORM_LABELS contains 'tasks-public': 'Public
//      Tasks'.
//   8. TeamAvailabilityEditor renders BOTH a Submitted-by/Assignor
//      section (roster checkboxes) AND an Assignee section (profile
//      checkboxes) for 'tasks-public'.
//   9. mig 041 ships the two RPCs:
//      - list_eligible_assignees returns only id + full_name (no role/
//        email leak) and filters role != 'inactive'.
//      - submit_task_instance validates assignor + assignee against the
//        admin's availability config, inserts task_instances with
//        template_id NULL + submission_source 'public_webform', and
//        is idempotent by client_submission_id.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const routesSrc = fs.readFileSync(path.join(ROOT, 'src/lib/routes.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const hubSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformHub.jsx'), 'utf8');
const formSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/TasksWebform.jsx'), 'utf8');
const adminSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformsAdminView.jsx'), 'utf8');
const adminTasksSrc = fs.readFileSync(path.join(ROOT, 'src/admin/AdminTasksView.jsx'), 'utf8');
const migSrc = fs.readFileSync(path.join(ROOT, 'supabase-migrations/041_tasks_public_rpcs.sql'), 'utf8');

describe('Routes wiring', () => {
  it('tasksWebform → /dailys/tasks in routes.js (post 2026-05-06 rename)', () => {
    expect(routesSrc).toMatch(/tasksWebform:\s*'\/dailys\/tasks'/);
  });

  it("main.jsx includes 'tasksWebform' in VALID_VIEWS", () => {
    expect(mainSrc).toMatch(/'tasksWebform'/);
  });

  it("main.jsx mounts TasksWebform when view==='tasksWebform'", () => {
    expect(mainSrc).toMatch(/view\s*===\s*'tasksWebform'[\s\S]{0,200}TasksWebform/);
  });

  it('URL→view sync prefers an exact PATH_TO_VIEW match over the generic /dailys/* fallback', () => {
    // The /dailys/tasks dedicated view must beat WebformHub's "any
    // /dailys/<sub> is webformhub" rule. Locking the exactPathView
    // shortcut so a future refactor doesn't accidentally swallow C3's
    // dedicated route.
    expect(mainSrc).toMatch(/const exactPathView\s*=\s*PATH_TO_VIEW\[location\.pathname\]/);
    expect(mainSrc).toMatch(/!exactPathView\s*&&\s*location\.pathname\.startsWith\('\/dailys\/'\)/);
  });
});

describe('WebformHub Tasks tile', () => {
  it('renders a tile with data-tile="tasks" navigating to /dailys/tasks (post 2026-05-06 rename)', () => {
    expect(hubSrc).toMatch(/data-tile="tasks"/);
    expect(hubSrc).toMatch(/navigate\(\s*'\/dailys\/tasks'\s*\)/);
  });

  it('uses the approved Tasks tile description copy', () => {
    expect(hubSrc.replace(/\s+/g, ' ')).toContain(
      "Use this to assign tasks to a Wcf Planner user when there is a repair needed or anything that shouldn't be forgotten.",
    );
  });
});

describe('TasksWebform component', () => {
  it("uses useOfflineRpcSubmit('task_submit')", () => {
    expect(formSrc).toMatch(/useOfflineRpcSubmit\(\s*'task_submit'\s*\)/);
  });

  it('passes a stable ti-<uuid> parentId to submit()', () => {
    expect(formSrc).toMatch(/'ti-' \+ crypto\.randomUUID\(\)/);
    expect(formSrc).toMatch(/submit\(payload,\s*\{\s*parentId:/);
  });

  it('reads availability for the assignor dropdown via tasks-public form key', () => {
    expect(formSrc).toMatch(/availableNamesFor\(\s*'tasks-public'/);
  });

  it('reads list_eligible_assignees + assignee availability for the assignee dropdown', () => {
    expect(formSrc).toMatch(/listEligibleAssignees/);
    expect(formSrc).toMatch(/loadPublicAssigneeAvailability/);
    expect(formSrc).toMatch(/visiblePublicAssignees/);
  });

  it('has no recurrence selector form control', () => {
    // Public form is one-time only; recurrence belongs in admin Tasks
    // Center. The form may MENTION recurring tasks in operator copy
    // ("Need a recurring task? Log in…") — strip comments + JSX text
    // and look only for actual code identifiers like RECURRENCE_OPTIONS,
    // a `recurrence` form-state variable, or a "Recurrence *" label.
    const stripped = formSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/RECURRENCE_OPTIONS/);
    expect(stripped).not.toMatch(/setRecurrence\b/);
    expect(stripped).not.toMatch(/Recurrence\s*\*/);
  });
});

describe('offlineRpcForms task_submit registry', () => {
  it('has a task_submit entry pointing at submit_task_instance', () => {
    expect(RPC_REGISTRY.task_submit).toBeDefined();
    expect(RPC_REGISTRY.task_submit.rpc).toBe('submit_task_instance');
  });

  it('buildArgs produces parent_in with the C3 contract fields', () => {
    const out = RPC_REGISTRY.task_submit.buildArgs(
      {
        title: 'Refill mineral',
        description: 'East pasture',
        due_date: '2026-05-10',
        assignee_profile_id: '00000000-0000-0000-0000-000000000001',
        submitted_by_team_member: 'ALICE',
      },
      {csid: 'csid-abc', parentId: 'ti-fixed'},
    );
    expect(out.rpc).toBe('submit_task_instance');
    expect(out.args.parent_in).toEqual({
      id: 'ti-fixed',
      client_submission_id: 'csid-abc',
      title: 'Refill mineral',
      description: 'East pasture',
      due_date: '2026-05-10',
      assignee_profile_id: '00000000-0000-0000-0000-000000000001',
      submitted_by_team_member: 'ALICE',
    });
  });

  it('buildArgs preserves the caller-provided parentId (no auto-mint)', () => {
    const out = RPC_REGISTRY.task_submit.buildArgs(
      {title: 'x', due_date: '2026-05-10', assignee_profile_id: 'u', submitted_by_team_member: 'A'},
      {csid: 'c', parentId: 'ti-should-make-it-through'},
    );
    expect(out.args.parent_in.id).toBe('ti-should-make-it-through');
  });
});

describe('Team availability + admin tile', () => {
  it("'tasks-public' is in TEAM_AVAILABILITY_FORM_KEYS (10 total)", () => {
    expect(TEAM_AVAILABILITY_FORM_KEYS).toContain('tasks-public');
    expect(TEAM_AVAILABILITY_FORM_KEYS).toHaveLength(10);
  });

  it("WebformsAdminView FORM_LABELS contains 'tasks-public': 'Public Tasks'", () => {
    expect(adminSrc).toMatch(/'tasks-public':\s*'Public Tasks'/);
  });

  it('Public Tasks tile renders BOTH the Submitted-by/Assignor section and the Assignee section', () => {
    expect(adminSrc).toMatch(/Submitted-by\s*\/\s*Assignor/);
    expect(adminSrc).toMatch(/Assignee \(planner users\)/);
    // Lock the data-attrs so a UI refactor still exposes both rows for tests.
    expect(adminSrc).toMatch(/data-availability-assignee-row="tasks-public"/);
    expect(adminSrc).toMatch(/data-availability-assignee-id=/);
  });

  it('admin tile uses savePublicAssigneeAvailability for assignee writes (not the roster path)', () => {
    expect(adminSrc).toMatch(/savePublicAssigneeAvailability/);
    // The two storage layers MUST be separate — no roster call inside the
    // assignee toggle handler. Locking the indirection through
    // setPublicAssigneeHidden:
    expect(adminSrc).toMatch(/setPublicAssigneeHidden/);
  });

  it('TeamAvailabilityEditor accepts loadUsers and hydrates allUsers on mount when empty', () => {
    // Direct admin /webforms loads bypass the Header → Users click that
    // populates allUsers, so the assignee section would render empty.
    // Lock: the editor accepts loadUsers as a prop, AND the parent
    // WebformsAdminView passes loadUsers down.
    expect(adminSrc).toMatch(/function TeamAvailabilityEditor\(\{[^}]*\bloadUsers\b[^}]*\}\)/);
    expect(adminSrc).toMatch(/<TeamAvailabilityEditor loadUsers=\{loadUsers\}/);
    // Inside the editor, the empty-allUsers-gated loadUsers() call.
    expect(adminSrc).toMatch(/typeof loadUsers !==\s*'function'/);
    expect(adminSrc).toMatch(/allUsers\.length\s*>\s*0/);
    expect(adminSrc).toMatch(/loadUsers\(\)/);
  });

  it('Public Tasks tile shows the default-inclusion copy at the top of the tile (C3.1a)', () => {
    // Codex-locked exact phrase. Lives only inside the 'tasks-public'
    // tile branch — locked via the data-availability-default-copy attr.
    expect(adminSrc).toMatch(/data-availability-default-copy="tasks-public"/);
    expect(adminSrc).toMatch(/New roster members and active planner users are included by default\. Uncheck to hide\./);
  });
});

describe('AdminTasksView Repeat-this-task UI (C3.1a)', () => {
  it('the Repeat-this-task toggle row sits directly after the Due date input', () => {
    // After the Due-date input closes, the next form section in the modal
    // is the Repeat-this-task toggle. JSX comments + whitespace are
    // allowed between them. The `{!isEditingTemplate` gate is the
    // marker that the toggle wrapper begins.
    const m = adminTasksSrc.match(/<input\s+type="date"[\s\S]{0,1000}?<\/div>([\s\S]{0,1500}?)Repeat this task/);
    expect(m, 'expected Repeat-this-task toggle proximate to the Due date input').not.toBeNull();
    // The gap between the Due-date `</div>` and the toggle should
    // include the `{!isEditingTemplate` guard — proves the toggle is
    // the first form section after the Due date, not buried under the
    // recurrence-fields block.
    expect(m[1]).toMatch(/\{!isEditingTemplate\b/);
  });

  it("the toggle label reads exactly 'Repeat this task' (not 'Make recurring')", () => {
    expect(adminTasksSrc).toMatch(/>\s*Repeat this task\s*<\/span>/);
    // strip comments + jsdoc; comments mentioning the old label are OK.
    const stripped = adminTasksSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/>\s*Make recurring\s*<\/span>/);
  });

  it('the toggle row has small helper copy below the label', () => {
    // Lock that there's a sibling div with smaller font + grey color
    // immediately after the toggle label. Use a permissive regex —
    // exact wording can drift, but the helper-copy block must exist.
    expect(adminTasksSrc).toMatch(/Repeat this task[\s\S]{0,200}<\/label>\s*\n\s*<div[^>]*fontSize:\s*11/);
  });

  it('the toggle row has NO bordered card — checkbox sits immediately beside the label', () => {
    // Codex C3.1a hotfix: drop the border/padding/background card and
    // use a plain compact checkbox row. The label must use inline-flex
    // (or flex) with a small gap (≤ 12) and NO justifyContent that
    // pushes the label across the modal. Lock the absence of the card
    // styles + presence of the tight checkbox/label proximity.
    const m = adminTasksSrc.match(
      /\{!isEditingTemplate && \(\s*\n\s*<div[\s\S]{0,200}?>([\s\S]{0,800}?)Repeat this task/,
    );
    expect(m, 'expected the Repeat-this-task wrapper to render').not.toBeNull();
    const wrapper = m[0];
    // No card chrome.
    expect(wrapper).not.toMatch(/border:\s*'1px solid/);
    expect(wrapper).not.toMatch(/background:\s*'#f9fafb'/);
    expect(wrapper).not.toMatch(/borderRadius/);
    expect(wrapper).not.toMatch(/padding:\s*'10px 12px'/);
    // Tight label: flex / inline-flex with a small gap.
    expect(wrapper).toMatch(/(?:inline-flex|flex)[\s\S]{0,100}gap:\s*[0-9]+/);
    // No justifyContent that would split label off to the right.
    expect(wrapper).not.toMatch(/justifyContent:\s*'space-between'/);
  });

  it('recurrence + interval + active fields render only when editForm.recurring is true', () => {
    // Existing C1.1 lock — the gate stays.
    expect(adminTasksSrc).toMatch(/\{editForm\.recurring\s*&&/);
  });
});

describe('AdminTasksView Assignee dropdown respects tasks_public_assignee_availability (C3.1a hotfix)', () => {
  it('imports visiblePublicAssignees + loadPublicAssigneeAvailability', () => {
    expect(adminTasksSrc).toMatch(/import\s*\{[^}]*\bvisiblePublicAssignees\b[^}]*\}\s*from\s*'\.\.\/lib\/tasks\.js'/);
    expect(adminTasksSrc).toMatch(
      /import\s*\{[^}]*\bloadPublicAssigneeAvailability\b[^}]*\}\s*from\s*'\.\.\/lib\/tasksAdminApi\.js'/,
    );
  });

  it('eligibleAssignees pipes the active list through visiblePublicAssignees', () => {
    // The assignee-availability config gates BOTH the public form AND
    // the admin Tasks Center New Task dropdown. Lock that both halves
    // appear in the same useMemo: role-active filter + visiblePublicAssignees.
    expect(adminTasksSrc).toMatch(
      /const eligibleAssignees\s*=\s*React\.useMemo\([\s\S]{0,500}?role !==\s*'inactive'[\s\S]{0,200}?visiblePublicAssignees\([^)]*assigneeAvailability/,
    );
  });

  it('loads assignee availability state in the refresh callback', () => {
    expect(adminTasksSrc).toMatch(
      /Promise\.all\(\[[\s\S]{0,200}?loadPublicAssigneeAvailability\(sb\)[\s\S]{0,100}?\]\)/,
    );
    expect(adminTasksSrc).toMatch(/setAssigneeAvailability/);
  });

  it("when the open modal's selected assignee becomes hidden, falls back to the first visible (or clears)", () => {
    // The watch effect uses `eligibleAssignees.some(...assignee_profile_id...)`
    // for the still-eligible check AND `eligibleAssignees[0]?.id || ''`
    // for the fallback. Both must be present.
    expect(adminTasksSrc).toMatch(/eligibleAssignees\.some\([\s\S]{0,300}?assignee_profile_id/);
    expect(adminTasksSrc).toMatch(/eligibleAssignees\[0\]\?\.id\s*\|\|\s*''/);
  });

  it('the re-pin effect depends on BOTH eligibleAssignees AND editForm?.assignee_profile_id', () => {
    // Codex C3.1a hotfix re-review: the effect must re-run when the
    // selected assignee changes too, so startEditTemplate(tpl) on a
    // template whose assignee is hidden gets caught even though
    // eligibleAssignees didn't change. Lock both deps in the array.
    // Anchor on .some(...assignee_profile_id...) and walk forward to
    // the deps array — that closes the useEffect.
    const m = adminTasksSrc.match(
      /eligibleAssignees\.some\([\s\S]{0,300}?assignee_profile_id[\s\S]{0,800}?\}\s*,\s*\[([^\]]+)\]\s*\)/,
    );
    expect(m, 'expected to find the re-pin effect deps array').not.toBeNull();
    expect(m[1]).toMatch(/eligibleAssignees/);
    expect(m[1]).toMatch(/editForm\?\.assignee_profile_id/);
  });
});

describe('Mig 041 RPC contracts', () => {
  it('list_eligible_assignees returns ONLY id + full_name (no role/email leak in the SELECT list)', () => {
    // Locate the function body.
    const fn = migSrc.match(
      /CREATE OR REPLACE FUNCTION public\.list_eligible_assignees\(\)[\s\S]*?\$list_eligible_assignees\$;/,
    );
    expect(fn, 'expected list_eligible_assignees definition').not.toBeNull();
    const body = fn[0];
    // SELECT clause must list id + full_name and nothing else. role / email
    // are allowed in the WHERE filter (we filter role != 'inactive') but
    // must NOT appear in the projection.
    const selectMatch = body.match(/SELECT\s+([\s\S]*?)\s+FROM\s+public\.profiles/);
    expect(selectMatch, 'expected SELECT clause before FROM public.profiles').not.toBeNull();
    const projection = selectMatch[1];
    expect(projection).toMatch(/p\.id,\s*p\.full_name/);
    expect(projection).not.toMatch(/role/);
    expect(projection).not.toMatch(/email/);
    // Must filter role != 'inactive' (allow quoting variants like
    // coalesce(role, '') <> 'inactive').
    expect(body).toMatch(/role[\s\S]{0,50}'inactive'/);
    // SECDEF + search_path.
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public/);
  });

  it('list_eligible_assignees grants EXECUTE to anon + authenticated', () => {
    expect(migSrc).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_eligible_assignees\(\) TO anon, authenticated/);
  });

  it('submit_task_instance validates submitted_by + assignee + idempotency', () => {
    const fn = migSrc.match(
      /CREATE OR REPLACE FUNCTION public\.submit_task_instance\(parent_in jsonb\)[\s\S]*?\$submit_task_instance\$;/,
    );
    expect(fn, 'expected submit_task_instance definition').not.toBeNull();
    const body = fn[0];
    // SECDEF + search_path.
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public/);
    // Required-field RAISEs.
    expect(body).toMatch(/client_submission_id required/);
    expect(body).toMatch(/title required/);
    expect(body).toMatch(/due_date required/);
    expect(body).toMatch(/assignee_profile_id required/);
    expect(body).toMatch(/submitted_by_team_member required/);
    // Submitted_by validation.
    expect(body).toMatch(/submitted_by_team_member not allowed/);
    // Assignee validation: not in hidden list AND eligible profile.
    expect(body).toMatch(/assignee not allowed/);
    expect(body).toMatch(/assignee not eligible/);
    // Inserts with template_id NULL + 'public_webform' + 'open'.
    expect(body).toMatch(/template_id[\s\S]*?NULL/);
    expect(body).toMatch(/'public_webform'/);
    expect(body).toMatch(/'open'/);
    // Idempotent ON CONFLICT.
    expect(body).toMatch(/ON CONFLICT \(client_submission_id\) DO NOTHING/);
    // Returns idempotent_replay flag.
    expect(body).toMatch(/idempotent_replay/);
  });

  it('submit_task_instance grants EXECUTE to anon + authenticated', () => {
    expect(migSrc).toMatch(/GRANT EXECUTE ON FUNCTION public\.submit_task_instance\(jsonb\) TO anon, authenticated/);
  });

  it('mig 041 reads roster + tasks-public hiddenIds + tasks_public_assignee_availability', () => {
    expect(migSrc).toMatch(/'team_roster'/);
    expect(migSrc).toMatch(/'team_availability'/);
    expect(migSrc).toMatch(/'tasks_public_assignee_availability'/);
    expect(migSrc).toMatch(/forms,tasks-public,hiddenIds/);
    expect(migSrc).toMatch(/hiddenProfileIds/);
  });
});
