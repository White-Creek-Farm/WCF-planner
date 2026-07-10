import {describe, expect, it, vi} from 'vitest';
import {setUserName, setUserProgramAccess, setUserRole, userManagementErrorMessage} from './userManagementApi.js';

function rpcClient(result) {
  return {rpc: vi.fn().mockResolvedValue(result)};
}

describe('userManagementApi', () => {
  it('routes name changes through the audited admin RPC and trims input', async () => {
    const sb = rpcClient({data: {ok: true, id: 'u-1', full_name: 'New Name'}, error: null});

    await expect(setUserName(sb, 'u-1', '  New Name  ')).resolves.toMatchObject({full_name: 'New Name'});
    expect(sb.rpc).toHaveBeenCalledWith('admin_set_user_name', {
      p_profile_id: 'u-1',
      p_full_name: 'New Name',
    });
  });

  it('routes role changes through the audited admin RPC', async () => {
    const sb = rpcClient({data: {ok: true, id: 'u-1', role: 'equipment_tech'}, error: null});

    await setUserRole(sb, 'u-1', 'equipment_tech');
    expect(sb.rpc).toHaveBeenCalledWith('admin_set_user_role', {
      p_profile_id: 'u-1',
      p_role: 'equipment_tech',
    });
  });

  it('normalizes empty program access to null (full access)', async () => {
    const sb = rpcClient({data: {ok: true, id: 'u-1', program_access: null}, error: null});

    await setUserProgramAccess(sb, 'u-1', []);
    expect(sb.rpc).toHaveBeenCalledWith('admin_set_user_program_access', {
      p_profile_id: 'u-1',
      p_program_access: null,
    });
  });

  it('preserves an explicit canonical program list', async () => {
    const programs = ['broiler', 'layer', 'pig', 'cattle', 'sheep', 'equipment'];
    const sb = rpcClient({data: {ok: true, id: 'u-1', program_access: programs}, error: null});

    await setUserProgramAccess(sb, 'u-1', programs);
    expect(sb.rpc).toHaveBeenCalledWith('admin_set_user_program_access', {
      p_profile_id: 'u-1',
      p_program_access: programs,
    });
  });

  it('turns server safety failures into actionable admin messages', async () => {
    const blocked = rpcClient({
      data: null,
      error: {message: 'user delete: account has retained farm records; deactivate it instead'},
    });
    await expect(setUserRole(blocked, 'u-1', 'inactive')).rejects.toThrow(/Deactivate them instead/i);

    expect(userManagementErrorMessage({message: 'user role: cannot remove the last active admin'})).toMatch(
      /At least one active administrator/i,
    );
    expect(
      userManagementErrorMessage({
        message: 'user delete: account deletion is already in progress; wait five minutes before retrying',
      }),
    ).toMatch(/Wait five minutes/i);
  });

  it('fails closed when the RPC returns no successful result', async () => {
    const sb = rpcClient({data: null, error: null});
    await expect(setUserName(sb, 'u-1', 'Name')).rejects.toThrow('Could not update the user name.');
  });
});
