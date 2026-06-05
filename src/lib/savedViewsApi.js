// Saved views API — thin wrapper over the app_saved_views table (migration
// 095). Direct client CRUD is intentional here: saved views are user
// preferences, not audit-critical entity writes, and RLS scopes every
// operation to public-or-owner SELECT + owner-only INSERT/UPDATE/DELETE.
//
// Ownership is server-trusted: the table's BEFORE INSERT trigger stamps
// owner_profile_id = auth.uid(), so callers MUST NOT send owner_profile_id —
// any client value is overwritten. The caller passes the shared `sb` client;
// no new Supabase client is created here.

const VALID_VISIBILITY = new Set(['private', 'public']);

// view_state is opaque jsonb to the DB. The app stores {filters, sortRules,
// viewMode}. This shape is documented here so callers agree on the contract.
export function buildViewState({filters, sortRules, viewMode}) {
  return {
    filters: filters && typeof filters === 'object' ? filters : {},
    sortRules: Array.isArray(sortRules) ? sortRules : [],
    viewMode: viewMode === 'flat' ? 'flat' : 'grouped',
  };
}

export async function listSavedViews(sb, surfaceKey) {
  if (!sb) throw new Error('listSavedViews: sb required');
  if (!surfaceKey) throw new Error('listSavedViews: surfaceKey required');
  // RLS returns only public-or-owner rows. Order public-then-private by name so
  // the picker is stable; ownership/visibility split is done in the UI.
  const {data, error} = await sb
    .from('app_saved_views')
    .select('id, surface_key, name, visibility, view_state, owner_profile_id, created_at, updated_at')
    .eq('surface_key', surfaceKey)
    .order('name', {ascending: true});
  if (error) throw new Error(`listSavedViews: ${error.message || String(error)}`);
  return data || [];
}

export async function createSavedView(sb, {surfaceKey, name, visibility, viewState}) {
  if (!sb) throw new Error('createSavedView: sb required');
  if (!surfaceKey) throw new Error('createSavedView: surfaceKey required');
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('createSavedView: name required');
  const vis = VALID_VISIBILITY.has(visibility) ? visibility : 'private';
  // owner_profile_id intentionally omitted — the DB trigger stamps auth.uid().
  const {data, error} = await sb
    .from('app_saved_views')
    .insert({surface_key: surfaceKey, name: trimmed, visibility: vis, view_state: viewState || {}})
    .select('id, surface_key, name, visibility, view_state, owner_profile_id, created_at, updated_at')
    .single();
  if (error) throw new Error(`createSavedView: ${error.message || String(error)}`);
  return data;
}

export async function updateSavedView(sb, id, {name, visibility, viewState} = {}) {
  if (!sb) throw new Error('updateSavedView: sb required');
  if (!id) throw new Error('updateSavedView: id required');
  const patch = {};
  if (name != null) {
    const trimmed = String(name).trim();
    if (!trimmed) throw new Error('updateSavedView: name cannot be blank');
    patch.name = trimmed;
  }
  if (visibility != null) {
    if (!VALID_VISIBILITY.has(visibility)) throw new Error('updateSavedView: invalid visibility');
    patch.visibility = visibility;
  }
  if (viewState != null) patch.view_state = viewState;
  if (Object.keys(patch).length === 0) throw new Error('updateSavedView: nothing to update');
  // RLS + the freeze trigger guarantee only the owner can update and that
  // owner_profile_id / created_at are not mutated here.
  const {data, error} = await sb
    .from('app_saved_views')
    .update(patch)
    .eq('id', id)
    .select('id, surface_key, name, visibility, view_state, owner_profile_id, created_at, updated_at')
    .single();
  if (error) throw new Error(`updateSavedView: ${error.message || String(error)}`);
  return data;
}

export async function deleteSavedView(sb, id) {
  if (!sb) throw new Error('deleteSavedView: sb required');
  if (!id) throw new Error('deleteSavedView: id required');
  // RLS rejects deletes the caller does not own.
  const {error} = await sb.from('app_saved_views').delete().eq('id', id);
  if (error) throw new Error(`deleteSavedView: ${error.message || String(error)}`);
  return true;
}
