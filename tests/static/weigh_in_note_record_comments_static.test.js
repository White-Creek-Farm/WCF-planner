import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const MIG = fs.readFileSync(path.join(ROOT, 'supabase-migrations/111_weigh_in_note_record_comments.sql'), 'utf8');
const FORM = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');

describe('weigh-in note record comments bridge', () => {
  it('syncs entry notes through deterministic record comment ids', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.sync_weigh_in_entry_note_comment()');
    expect(MIG).toContain("v_comment_id := 'wi-note-' || v_row.id");
    expect(MIG).toContain('AFTER INSERT OR UPDATE OF note, tag, session_id, weight, new_tag_flag OR DELETE');
    expect(MIG).toContain('CREATE TRIGGER weigh_in_entry_note_comment_sync');
  });

  it('routes supported entry notes to animal or batch record entity types', () => {
    for (const entityType of ['cattle.animal', 'sheep.animal', 'pig.batch', 'broiler.batch']) {
      expect(MIG).toContain(`v_entity_type := '${entityType}'`);
    }
  });

  it('resolves pig weigh-in labels to the parent pig.batch record id', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public._weigh_in_resolve_pig_batch');
    expect(MIG).toContain("WHERE key = 'ppp-feeders-v1'");
    expect(MIG).toContain("v_group->>'id'");
    expect(MIG).toContain("v_sub->>'name'");
  });

  it('syncs pig and broiler session notes to batch record comments', () => {
    expect(MIG).toContain('CREATE OR REPLACE FUNCTION public.sync_weigh_in_session_note_comment()');
    expect(MIG).toContain("v_comment_id := 'wis-note-' || v_row.id");
    expect(MIG).toContain('CREATE TRIGGER weigh_in_session_note_comment_sync_upsert');
    expect(MIG).toContain('CREATE TRIGGER weigh_in_session_note_comment_sync_delete');
  });

  it('uses server-side comment writes instead of exposing comments table access to the form', () => {
    expect(MIG).toContain('SECURITY DEFINER');
    expect(MIG).toContain('INSERT INTO public.comments');
    expect(MIG).toContain('DELETE FROM public.comments');
    expect(FORM).not.toContain("from('comments')");
    expect(FORM).not.toContain("from('comment_edits')");
  });

  it('lets clearing a broiler session note remove the mirrored record comment', () => {
    expect(FORM).toContain('const sessionNote = noteInput && noteInput.trim() ? noteInput.trim() : null');
    expect(FORM).toContain('update({notes: sessionNote})');
    expect(FORM).not.toContain('if (noteInput && noteInput.trim())');
  });
});
