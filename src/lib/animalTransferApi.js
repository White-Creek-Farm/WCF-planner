// Manual animal transfer API for cattle.animal and sheep.animal.
// Both operations use transactional SECDEF RPCs that update the source row,
// insert the transfer audit row, and insert a status.changed Activity event
// in one transaction. A no-op (destination == current herd/flock) returns
// {ok:true, noop:true} and writes nothing.

export async function transferCattleAnimal(sb, id, toHerd, teamMember, reason) {
  if (!sb) throw new Error('transferCattleAnimal: sb required');
  const {data, error} = await sb.rpc('transfer_cattle_animal', {
    p_entity_id: id,
    p_to_herd: toHerd,
    p_team_member: teamMember || null,
    p_reason: reason || 'manual',
  });
  if (error) throw new Error(`transferCattleAnimal: ${error.message || String(error)}`);
  return data;
}

export async function transferSheepAnimal(sb, id, toFlock, teamMember, reason) {
  if (!sb) throw new Error('transferSheepAnimal: sb required');
  const {data, error} = await sb.rpc('transfer_sheep_animal', {
    p_entity_id: id,
    p_to_flock: toFlock,
    p_team_member: teamMember || null,
    p_reason: reason || 'manual',
  });
  if (error) throw new Error(`transferSheepAnimal: ${error.message || String(error)}`);
  return data;
}
