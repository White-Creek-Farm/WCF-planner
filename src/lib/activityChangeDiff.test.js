import {describe, it, expect} from 'vitest';
import {buildChanges, countSummary, makeFieldChange} from './activityChangeDiff.js';

describe('buildChanges', () => {
  it('detects a scalar change with presence flags', () => {
    const changes = buildChanges({tag: 'A1'}, {tag: 'A2'});
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      field: 'tag',
      label: 'tag',
      from: 'A1',
      to: 'A2',
      old_present: true,
      new_present: true,
    });
  });

  it('skips no-op when values are equal', () => {
    const changes = buildChanges({tag: 'A1', breed: 'Angus'}, {tag: 'A1', breed: 'Angus'});
    expect(changes).toHaveLength(0);
  });

  it('skips null-to-null and empty-to-null transitions', () => {
    expect(buildChanges({a: null}, {a: null})).toHaveLength(0);
    expect(buildChanges({a: null}, {a: ''})).toHaveLength(0);
    expect(buildChanges({a: ''}, {a: null})).toHaveLength(0);
  });

  it('null-to-value includes old_present false, new_present true', () => {
    const changes = buildChanges({breed: null}, {breed: 'Hereford'});
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe(null);
    expect(changes[0].to).toBe('Hereford');
    expect(changes[0].old_present).toBe(false);
    expect(changes[0].new_present).toBe(true);
  });

  it('value-to-null includes old_present true, new_present false', () => {
    const changes = buildChanges({breed: 'Angus'}, {breed: null});
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe('Angus');
    expect(changes[0].to).toBe(null);
    expect(changes[0].old_present).toBe(true);
    expect(changes[0].new_present).toBe(false);
  });

  it('value-to-value includes both present true', () => {
    const changes = buildChanges({breed: 'Angus'}, {breed: 'Hereford'});
    expect(changes[0].old_present).toBe(true);
    expect(changes[0].new_present).toBe(true);
  });

  it('skips excluded fields', () => {
    const changes = buildChanges({tag: 'A1', herd: 'mommas'}, {tag: 'A2', herd: 'finishers'}, {exclude: ['herd']});
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('tag');
  });

  it('uses custom labels', () => {
    const changes = buildChanges({tag: 'A1'}, {tag: 'A2'}, {labels: {tag: 'Tag'}});
    expect(changes[0].label).toBe('Tag');
  });

  it('uses formatter for complex fields', () => {
    const oldArr = [{name: 'x'}, {name: 'y'}];
    const newArr = [{name: 'x'}, {name: 'y'}, {name: 'z'}];
    const changes = buildChanges(
      {items: oldArr},
      {items: newArr},
      {
        formatters: {items: (v) => (Array.isArray(v) ? v.length + ' items' : 'none')},
      },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe('2 items');
    expect(changes[0].to).toBe('3 items');
  });

  it('treats boolean false !== boolean true as a change', () => {
    const changes = buildChanges({active: false}, {active: true});
    expect(changes).toHaveLength(1);
  });

  it('returns empty for null newFields', () => {
    expect(buildChanges({a: 1}, null)).toHaveLength(0);
  });

  it('handles missing oldRec gracefully', () => {
    const changes = buildChanges(null, {tag: 'A1'});
    expect(changes).toHaveLength(1);
    expect(changes[0].from).toBe(null);
    expect(changes[0].to).toBe('A1');
  });

  it('skips equal arrays', () => {
    const arr = [{tag: 'x'}];
    expect(buildChanges({old_tags: arr}, {old_tags: [{tag: 'x'}]})).toHaveLength(0);
  });

  it('detects array change', () => {
    expect(buildChanges({old_tags: [{tag: 'x'}]}, {old_tags: [{tag: 'x'}, {tag: 'y'}]})).toHaveLength(1);
  });
});

describe('makeFieldChange', () => {
  it('includes old_present and new_present', () => {
    const c = makeFieldChange('tag', 'Tag', null, 'A1');
    expect(c).toEqual({field: 'tag', label: 'Tag', from: null, to: 'A1', old_present: false, new_present: true});
  });

  it('handles both present', () => {
    const c = makeFieldChange('name', 'Name', 'Old', 'New');
    expect(c.old_present).toBe(true);
    expect(c.new_present).toBe(true);
  });
});

describe('countSummary', () => {
  it('returns "none" for empty or null', () => {
    expect(countSummary([], 'tag')).toBe('none');
    expect(countSummary(null, 'tag')).toBe('none');
  });

  it('returns singular for 1 item', () => {
    expect(countSummary([1], 'tag')).toBe('1 tag');
  });

  it('returns plural for multiple items', () => {
    expect(countSummary([1, 2, 3], 'tag')).toBe('3 tags');
  });

  it('uses custom plural', () => {
    expect(countSummary([1, 2], 'entry', 'entries')).toBe('2 entries');
  });

  it('does not produce "assigneds"', () => {
    const result = countSummary([1, 2], 'team member');
    expect(result).toBe('2 team members');
    expect(result).not.toContain('assigneds');
  });
});
