import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = process.cwd();

const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('To Do page selected controls', () => {
  const taskCenter = read('src/tasks/TaskCenterView.jsx');
  const todoList = read('src/tasks/TodoListTab.jsx');

  it('fills the active Task Center / To Do List mode button', () => {
    expect(taskCenter).toMatch(/const MODE_BTN_BASE = \{[\s\S]*?color: '#000000'/);
    expect(taskCenter).toMatch(/const MODE_BTN_ACTIVE = \{[\s\S]*?background: '#085041'[\s\S]*?color: '#ffffff'/);
  });

  it('fills active To Do section filter chips', () => {
    expect(todoList).toMatch(/const CHIP_BASE = \{[\s\S]*?color: '#000000'/);
    expect(todoList).toMatch(
      /const CHIP_ACTIVE = \{[\s\S]*?border: '1px solid #085041'[\s\S]*?background: '#085041'[\s\S]*?color: '#ffffff'/,
    );
    expect(todoList).toMatch(
      /pendingOnly[\s\S]*?\? \{background: '#b45309', border: '1px solid #b45309', color: '#ffffff'\}/,
    );
  });
});
