// Cattle animal soft-delete and restore API.
// Both operations use transactional SECDEF RPCs that mutate
// the record and insert an Activity event in one transaction.

export async function softDeleteCattleAnimal(sb, id, label) {
  if (!sb) throw new Error('softDeleteCattleAnimal: sb required');
  const {data, error} = await sb.rpc('soft_delete_cattle_animal', {
    p_entity_id: id,
    p_entity_label: label || null,
  });
  if (error) throw new Error(`softDeleteCattleAnimal: ${error.message || String(error)}`);
  return data;
}

export async function restoreCattleAnimal(sb, id, label) {
  if (!sb) throw new Error('restoreCattleAnimal: sb required');
  const {data, error} = await sb.rpc('restore_cattle_animal', {
    p_entity_id: id,
    p_entity_label: label || null,
  });
  if (error) throw new Error(`restoreCattleAnimal: ${error.message || String(error)}`);
  return data;
}
