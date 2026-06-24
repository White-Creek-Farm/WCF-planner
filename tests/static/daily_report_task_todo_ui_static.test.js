import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const hubSrc = read('src/webforms/WebformHub.jsx');
const tasksFormSrc = read('src/webforms/TasksWebform.jsx');

describe('Daily Report form toggles', () => {
  it('uses the canonical program color for selected yes/no and option toggles', () => {
    expect(hubSrc).toMatch(/import \{getProgramColor\} from '\.\.\/lib\/programColors\.js'/);
    expect(hubSrc).toMatch(/const DAILY_FORM_PROGRAMS = \{/);
    expect(hubSrc).toMatch(/const activeProgramColor = getProgramColor\(DAILY_FORM_PROGRAMS\[activeForm\]\)/);
    expect(hubSrc).toMatch(/background: selected \? activeProgramColor : 'white'/);
    expect(hubSrc).toMatch(/color: selected \? '#ffffff' : '#000000'/);
  });

  it('keeps Daily Report form labels and typed values black', () => {
    expect(hubSrc).toMatch(/const inputStyle = \{[\s\S]*?color: '#000000'/);
    expect(hubSrc).toMatch(/const labelStyle = \{[^}]*color: '#000000'/);
  });
});

describe('Daily Reports task-or-todo entry', () => {
  it('renames the Daily Reports tile and Tasks form heading', () => {
    expect(hubSrc).toContain('Submit a Task or a Todo');
    expect(tasksFormSrc).toContain('Submit a Task or a Todo');
  });

  it('renders a Task / To Do mode toggle with filled selected-state styling', () => {
    expect(tasksFormSrc).toContain('data-submit-kind-toggle="1"');
    expect(tasksFormSrc).toContain('data-submit-kind={opt.key}');
    expect(tasksFormSrc).toMatch(/background: selected \? '#085041' : 'white'/);
    expect(tasksFormSrc).toMatch(/color: selected \? '#ffffff' : '#000000'/);
  });

  it('creates To Dos through the existing To Do RPC wrapper, not task_submit', () => {
    expect(tasksFormSrc).toMatch(/TODO_SECTIONS/);
    expect(tasksFormSrc).toMatch(/generateTodoItemId/);
    expect(tasksFormSrc).toMatch(/uploadTodoPhotos\(sb, id, 'origination', \[photoFile\]\)/);
    expect(tasksFormSrc).toMatch(/createTodoItem\(sb, \{/);
    expect(tasksFormSrc).toMatch(/fireTodoChangeEvent\(\)/);
  });

  it('keeps Task-only fields and offline queueing on the Task branch', () => {
    expect(tasksFormSrc).toMatch(/!isTodoMode && !dueDate/);
    expect(tasksFormSrc).toMatch(/!isTodoMode && !assignee/);
    expect(tasksFormSrc).toMatch(/!isTodoMode && \(/);
    expect(tasksFormSrc).toMatch(
      /submit\(payload,\s*\{\s*parentId:\s*mintTiInstanceId\(\),\s*photo:\s*photoFile\s*\|\|\s*null\s*\}\)/,
    );
  });
});
