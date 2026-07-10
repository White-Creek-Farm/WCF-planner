// Admin-only user-management mutation wrappers. Runtime profile writes belong
// to migration 171's SECURITY DEFINER RPCs; browser code must never mutate the
// profiles table directly.

const FRIENDLY_ERRORS = [
  ['authenticated caller required', 'Your session expired. Sign in again before managing users.'],
  ['admin role required', 'Only an administrator can manage users.'],
  ['you cannot change your own role', 'You cannot change your own role. Ask another administrator.'],
  ['cannot remove the last active admin', 'At least one active administrator must remain.'],
  ['you cannot delete your own account', 'You cannot delete your own account. Ask another administrator.'],
  ['wait five minutes before retrying', 'This deletion is still in progress. Wait five minutes, then reload Users.'],
  ['account deletion is already in progress', 'This account already has a deletion in progress. Reload Users.'],
  ['account has retained farm records', 'This user is attached to retained farm records. Deactivate them instead.'],
  ['email no longer matches', 'This user changed since the list loaded. Reload Users and try again.'],
  ['auth/profile email mismatch', 'The account and profile do not match. Reload Users and contact support.'],
  ['auth account is already missing', 'The Auth account is already missing. Reload Users and contact support.'],
  ['profile not found', 'That user no longer exists. Reload Users and try again.'],
  ['invalid role', 'Choose a valid WCF Planner role.'],
  ['invalid program', 'Choose only valid WCF Planner programs.'],
  ['120 characters or fewer', 'Use 120 characters or fewer for the name.'],
];

export function userManagementErrorMessage(error, fallback = 'Could not update this user.') {
  const raw = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ');
  const lower = raw.toLowerCase();
  const match = FRIENDLY_ERRORS.find(([needle]) => lower.includes(needle));
  return match ? match[1] : raw || fallback;
}

async function callUserManagementRpc(sb, name, args, fallback) {
  if (!sb) throw new Error('User management is unavailable. Reload the page and try again.');
  const {data, error} = await sb.rpc(name, args);
  if (error) throw new Error(userManagementErrorMessage(error, fallback));
  if (!data || data.ok !== true) throw new Error(fallback);
  return data;
}

export function setUserName(sb, profileId, fullName) {
  return callUserManagementRpc(
    sb,
    'admin_set_user_name',
    {p_profile_id: profileId, p_full_name: String(fullName || '').trim()},
    'Could not update the user name.',
  );
}

export function setUserRole(sb, profileId, role) {
  return callUserManagementRpc(
    sb,
    'admin_set_user_role',
    {p_profile_id: profileId, p_role: role},
    'Could not update the user role.',
  );
}

export function setUserProgramAccess(sb, profileId, programAccess) {
  const normalized = Array.isArray(programAccess) && programAccess.length > 0 ? programAccess : null;
  return callUserManagementRpc(
    sb,
    'admin_set_user_program_access',
    {p_profile_id: profileId, p_program_access: normalized},
    'Could not update program access.',
  );
}
