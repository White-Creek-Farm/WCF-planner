// Sheep animal soft-delete and restore API.
// Both operations use transactional SECDEF RPCs that mutate
// the record and insert an Activity event in one transaction.

export async function softDeleteSheepAnimal(sb, id, label) {
  if (!sb) throw new Error('softDeleteSheepAnimal: sb required');
  const {data, error} = await sb.rpc('soft_delete_sheep_animal', {
    p_entity_id: id,
    p_entity_label: label || null,
  });
  if (error) throw new Error(`softDeleteSheepAnimal: ${error.message || String(error)}`);
  return data;
}

export async function restoreSheepAnimal(sb, id, label) {
  if (!sb) throw new Error('restoreSheepAnimal: sb required');
  const {data, error} = await sb.rpc('restore_sheep_animal', {
    p_entity_id: id,
    p_entity_label: label || null,
  });
  if (error) throw new Error(`restoreSheepAnimal: ${error.message || String(error)}`);
  return data;
}
