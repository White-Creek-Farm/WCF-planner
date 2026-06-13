import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const componentSrc = fs.readFileSync(path.join(ROOT, 'src/shared/RecordCollaborationSection.jsx'), 'utf8');

describe('RecordCollaborationSection — shared component contract', () => {
  it('exports a default function', () => {
    expect(componentSrc).toMatch(/export default function RecordCollaborationSection/);
  });
  it('accepts shared record identity props plus spacing, activity-only mode, and an optional mention loader', () => {
    // Destructure block (props may carry interleaved comments); assert every
    // expected param with its default appears within it.
    const block = componentSrc.slice(
      componentSrc.indexOf('RecordCollaborationSection({'),
      componentSrc.indexOf('}) {'),
    );
    for (const prop of ['sb', 'authState', 'entityType', 'entityId', 'entityLabel']) {
      expect(block, prop).toMatch(new RegExp(`\\b${prop}\\b`));
    }
    expect(block).toMatch(/spacing\s*=\s*16/);
    expect(block).toMatch(/showComments\s*=\s*true/);
    expect(block).toMatch(/activityLimit\s*=\s*50/);
    expect(block).toMatch(/activityEventFilter\s*=\s*null/);
    expect(block).toMatch(/loadMentionable\s*=\s*undefined/);
  });
  it('threads the optional mention loader through to CommentsSection', () => {
    expect(componentSrc).toMatch(/<CommentsSection[\s\S]*?loadMentionable=\{loadMentionable\}/);
  });
  it('composes CommentsSection and RecordActivityLog', () => {
    expect(componentSrc).toContain("import CommentsSection from './CommentsSection.jsx'");
    expect(componentSrc).toContain("import RecordActivityLog from './RecordActivityLog.jsx'");
    expect(componentSrc).toContain('{showComments && (');
    expect(componentSrc).toMatch(/<CommentsSection\b/);
    expect(componentSrc).toMatch(/<RecordActivityLog\b/);
  });
  it('passes entity props through to both children', () => {
    expect(componentSrc).toMatch(/<CommentsSection[\s\S]*?entityType=\{entityType\}/);
    expect(componentSrc).toMatch(/<CommentsSection[\s\S]*?entityId=\{entityId\}/);
    expect(componentSrc).toMatch(/<CommentsSection[\s\S]*?entityLabel=\{entityLabel\}/);
    expect(componentSrc).toMatch(/<RecordActivityLog[\s\S]*?entityType=\{entityType\}/);
    expect(componentSrc).toMatch(/<RecordActivityLog[\s\S]*?entityId=\{entityId\}/);
    expect(componentSrc).toMatch(/<RecordActivityLog[\s\S]*?limit=\{activityLimit\}/);
    expect(componentSrc).toMatch(/<RecordActivityLog[\s\S]*?eventFilter=\{activityEventFilter\}/);
  });
  it('applies spacing prop as marginTop on both wrappers', () => {
    const matches = componentSrc.match(/marginTop:\s*spacing/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
  it('exposes data-record-collaboration-section test hook', () => {
    expect(componentSrc).toContain('data-record-collaboration-section="1"');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(componentSrc).not.toContain('ActivityPanel');
    expect(componentSrc).not.toContain('ActivityModal');
  });
  it('does not fetch Activity, Comments, or any data directly', () => {
    expect(componentSrc).not.toContain('listActivityEvents');
    expect(componentSrc).not.toContain('listComments');
    expect(componentSrc).not.toContain('from(');
    expect(componentSrc).not.toContain('useEffect');
    expect(componentSrc).not.toContain('useState');
  });
  it('does not reference activity_events, activity_mentions, comments, or comment_edits tables', () => {
    expect(componentSrc).not.toContain('activity_events');
    expect(componentSrc).not.toContain('activity_mentions');
    expect(componentSrc).not.toMatch(/['"]comments['"]/);
    expect(componentSrc).not.toContain('comment_edits');
  });
});
