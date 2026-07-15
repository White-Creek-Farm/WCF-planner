// Phase 2 Round 3 extraction (verbatim).
import React from 'react';
import {useAuth} from '../contexts/AuthContext.jsx';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
import {unwrapEdgeFunctionError} from '../lib/edgeErrors.js';
import {setUserName, setUserProgramAccess, setUserRole} from '../lib/userManagementApi.js';
import {createUserMutationLock} from './usersModalMutationLock.js';
function UsersModal({sb, authState, allUsers, setAllUsers, setShowUsers, loadUsers}) {
  const {setAuthState} = useAuth() || {};
  const [umTab, setUmTab] = React.useState('users');
  const [addEmail, setAddEmail] = React.useState('');
  const [addName, setAddName] = React.useState('');
  const [addRole, setAddRole] = React.useState('farm_team');
  const [umMsg, setUmMsg] = React.useState('');
  const [umErr, setUmErr] = React.useState('');
  const [umLoading, setUmLoading] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState(null);
  const [addPassword, setAddPassword] = React.useState('');
  const [addPasswordConfirm, setAddPasswordConfirm] = React.useState('');
  // Every mutation must claim this lock before touching notices, list state,
  // or the network. The ref guards synchronously (before React re-renders);
  // the state mirror drives the disabled controls.
  const userMutationLockRef = React.useRef(null);
  if (userMutationLockRef.current === null) userMutationLockRef.current = createUserMutationLock();
  const [activeUserMutation, setActiveUserMutation] = React.useState(null);
  const userMutationBusy = umLoading || activeUserMutation !== null;

  function beginUserMutation(kind, targetId = null) {
    const token = userMutationLockRef.current.begin(kind, targetId);
    if (token) setActiveUserMutation(token);
    return token;
  }

  function endUserMutation(token) {
    if (userMutationLockRef.current.release(token)) setActiveUserMutation(null);
  }

  // Closing unmounts the modal and destroys the lock, so reopening during an
  // in-flight request could start an overlapping mutation. Both close paths
  // (backdrop and the header X) must refuse while a mutation holds the lock.
  function requestCloseUsers() {
    if (userMutationBusy) return;
    setShowUsers(false);
  }

  const ROLES = [
    {v: 'farm_team', l: 'Farm Team'},
    {v: 'management', l: 'Management'},
    {v: 'admin', l: 'Admin'},
    {v: 'equipment_tech', l: 'Equipment Tech'},
    {v: 'light', l: 'Light'},
  ];

  React.useEffect(() => {
    loadUsers();
  }, []);

  async function createUser() {
    if (!addEmail.trim()) {
      setUmErr('Email required.');
      return;
    }
    const wantsManualPassword = addPassword.length > 0 || addPasswordConfirm.length > 0;
    if (wantsManualPassword) {
      if (addPassword.length < 6) {
        setUmErr('Password must be at least 6 characters.');
        return;
      }
      const bytes = new TextEncoder().encode(addPassword).length;
      if (bytes > 72) {
        setUmErr('Password is too long. Use 72 bytes or fewer.');
        return;
      }
      if (addPassword !== addPasswordConfirm) {
        setUmErr('Passwords do not match.');
        return;
      }
    }
    const token = beginUserMutation('create');
    if (!token) return;
    setUmLoading(true);
    setUmErr('');
    setUmMsg('');
    try {
      const payload = {email: addEmail.trim(), name: addName.trim(), role: addRole};
      if (wantsManualPassword) payload.initialPassword = addPassword;
      const {data: fnData, error} = await sb.functions.invoke('rapid-processor', {
        body: {type: 'user_create', data: payload},
      });
      if (error) throw error;
      // The auth account succeeded if we reached this branch. Welcome
      // email is best-effort \u2014 when rapid-processor returns
      // welcomeEmailDelivered:false the account IS usable, but we must
      // not show a green "Invite sent" \u2014 surface the Resend error and
      // tell the admin to use Send Password Reset on the user row.
      if (fnData && fnData.manualPasswordSet) {
        setUmMsg(
          '\u2705 User created for ' +
            addEmail.trim() +
            '. No email was sent. Give them the password you set through a trusted channel.',
        );
      } else if (fnData && fnData.welcomeEmailDelivered === false) {
        const reason = fnData.emailError || 'unknown error';
        setUmErr(
          'Account created for ' +
            addEmail.trim() +
            ', but the welcome email failed: ' +
            reason +
            '. Use Send Password Reset on the new user row to deliver a working link.',
        );
      } else {
        setUmMsg(
          '\u2705 Invite sent to ' + addEmail.trim() + '. They\u2019ll set their password via the link in the email.',
        );
      }
      setAddEmail('');
      setAddName('');
      setAddRole('farm_team');
      setAddPassword('');
      setAddPasswordConfirm('');
      loadUsers();
      setUmTab('users');
    } catch (e) {
      const msg = await unwrapEdgeFunctionError(e);
      setUmErr('Error: ' + msg);
    } finally {
      setUmLoading(false);
      endUserMutation(token);
    }
  }

  async function sendPasswordReset(userId, email, name) {
    window._wcfConfirm(
      'Send a password reset email to ' + email + '?',
      async () => {
        const token = beginUserMutation('password_reset', userId);
        if (!token) return;
        setUmErr('');
        setUmMsg('');
        try {
          const {error} = await sb.functions.invoke('rapid-processor', {
            body: {type: 'password_reset', data: {email, name: name || ''}},
          });
          if (error) throw error;
          setUmMsg('✅ Password reset email sent to ' + email);
        } catch (e) {
          const msg = await unwrapEdgeFunctionError(e);
          setUmErr('Error sending reset email: ' + msg);
        } finally {
          endUserMutation(token);
        }
      },
      'Send',
    );
  }

  async function updateRole(userId, newRole) {
    const token = beginUserMutation('role', userId);
    if (!token) return;
    setUmErr('');
    setUmMsg('');
    try {
      const result = await setUserRole(sb, userId, newRole);
      setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, role: result.role} : p)));
      setEditingUser(null);
    } catch (e) {
      setUmErr(e.message || 'Could not update the user role.');
    } finally {
      endUserMutation(token);
    }
  }

  async function updateName(userId, newName) {
    const fullName = (newName || '').trim();
    const token = beginUserMutation('name', userId);
    if (!token) return;
    setUmErr('');
    setUmMsg('');
    try {
      const result = await setUserName(sb, userId, fullName);
      const savedName = result.full_name || '';
      setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, full_name: savedName} : p)));
      if (userId === authState?.user?.id && typeof setAuthState === 'function') {
        setAuthState((prev) => {
          if (!prev || prev === false || prev.user?.id !== userId) return prev;
          return {
            ...prev,
            profile: prev.profile ? {...prev.profile, full_name: savedName} : prev.profile,
            name: savedName || prev.user?.email || prev.name || '',
          };
        });
      }
      setEditingUser(null);
    } catch (e) {
      setUmErr(e.message || 'Could not update the user name.');
    } finally {
      endUserMutation(token);
    }
  }

  async function deactivateUser(userId, email) {
    window._wcfConfirm(
      'Deactivate ' + email + '? They will no longer be able to log in.',
      async () => {
        await updateRole(userId, 'inactive');
      },
      'Deactivate',
    );
  }

  // Hard delete is owned by rapid-processor. Migration 171 preflights retained
  // profile references and writes audit intent before the Edge function deletes
  // auth.users; profiles then cascades from that one delete.
  async function deleteUser(userId, email) {
    window._wcfConfirmDelete(
      'PERMANENTLY DELETE ' +
        email +
        '? This removes the auth account so the email can be re-invited from scratch. Deactivate instead if you just want to block login.',
      async () => {
        const token = beginUserMutation('delete', userId);
        if (!token) return;
        setUmErr('');
        setUmMsg('');
        try {
          const {data: fnData, error: fnErr} = await sb.functions.invoke('rapid-processor', {
            body: {type: 'user_delete', data: {id: userId, email}},
          });
          if (fnErr) throw fnErr;
          setAllUsers((prev) => prev.filter((p) => p.id !== userId));
          setUmMsg('\u2705 Deleted ' + email + '. Email is now free to re-invite.');
          if (fnData?.auditFinalized === false) {
            setUmErr('The account was deleted, but final audit confirmation failed. Contact support before retrying.');
          }
        } catch (e) {
          const msg = await unwrapEdgeFunctionError(e);
          setUmErr(
            'Could not delete ' +
              email +
              ': ' +
              msg +
              '. Reload Users before retrying. If the user is still listed, deactivate them instead.',
          );
        } finally {
          endUserMutation(token);
        }
      },
    );
  }

  async function updateProgramAccess(userId, newList) {
    // Empty array → null (means "all programs"). Avoids empty-array ambiguity.
    const value = newList && newList.length > 0 ? newList : null;
    const token = beginUserMutation('program_access', userId);
    if (!token) return;
    setUmErr('');
    setUmMsg('');
    try {
      const result = await setUserProgramAccess(sb, userId, value);
      const savedAccess = Array.isArray(result.program_access) ? result.program_access : null;
      setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, program_access: savedAccess} : p)));
    } catch (e) {
      setUmErr(e.message || 'Could not update program access.');
    } finally {
      endUserMutation(token);
    }
  }

  const roleColor = {
    admin: '#b91c1c',
    management: '#1d4ed8',
    farm_team: '#085041',
    equipment_tech: '#6b7280',
    light: '#7c3aed',
    inactive: '#9ca3af',
  };
  const roleBg = {
    admin: '#fef2f2',
    management: '#eff6ff',
    farm_team: '#ecfdf5',
    equipment_tech: '#f3f4f6',
    light: '#f5f3ff',
    inactive: '#f3f4f6',
  };

  return (
    <div
      data-user-management-modal="1"
      onClick={requestCloseUsers}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.5)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 12,
          width: '100%',
          maxWidth: 580,
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            position: 'sticky',
            top: 0,
            background: 'white',
            zIndex: 1,
          }}
        >
          <div style={{fontSize: 15, fontWeight: 700}}>User Management</div>
          <button
            type="button"
            aria-label="Close user management"
            data-user-management-close="1"
            disabled={userMutationBusy}
            onClick={requestCloseUsers}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              cursor: userMutationBusy ? 'not-allowed' : 'pointer',
              color: 'var(--ink-faint)',
              lineHeight: 1,
              padding: '0 4px',
              opacity: userMutationBusy ? 0.6 : 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 20px'}}>
          {[
            ['users', '👥 Users'],
            ['add', '➕ Add User'],
          ].map(([t, l]) => (
            <button
              key={t}
              disabled={userMutationBusy}
              onClick={() => {
                if (userMutationBusy) return;
                setUmTab(t);
                setUmErr('');
                setUmMsg('');
              }}
              style={{
                padding: '10px 16px',
                border: 'none',
                background: 'none',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: umTab === t ? 700 : 400,
                color: umTab === t ? '#085041' : '#6b7280',
                borderBottom: umTab === t ? '2px solid #085041' : '2px solid transparent',
                cursor: userMutationBusy ? 'not-allowed' : 'pointer',
                marginBottom: -1,
                opacity: userMutationBusy ? 0.6 : 1,
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <div style={{padding: '16px 20px'}}>
          {umMsg && (
            <div
              data-user-management-message="success"
              style={{
                background: '#ecfdf5',
                border: '1px solid #a7f3d0',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 12,
                color: '#065f46',
                marginBottom: 12,
              }}
            >
              {umMsg}
            </div>
          )}
          {umErr && (
            <div
              data-user-management-message="error"
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 12,
                color: '#b91c1c',
                marginBottom: 12,
              }}
            >
              {umErr}
            </div>
          )}

          {umTab === 'users' && (
            <div>
              {/* Permissions reference */}
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 11,
                  marginBottom: 14,
                }}
              >
                <div style={{fontWeight: 600, marginBottom: 6, fontSize: 12}}>Permission levels</div>
                <div style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', lineHeight: 1.5}}>
                  <span style={{fontWeight: 700, color: '#085041'}}>🌾 Farm Team</span>
                  <span style={{color: 'var(--ink-muted)'}}>Edit & delete daily reports only</span>
                  <span style={{fontWeight: 700, color: '#1d4ed8'}}>🔑 Management</span>
                  <span style={{color: 'var(--ink-muted)'}}>Edit anything · delete daily reports only</span>
                  <span style={{fontWeight: 700, color: '#b91c1c'}}>👑 Admin</span>
                  <span style={{color: 'var(--ink-muted)'}}>Full access — edit & delete everything</span>
                  <span style={{fontWeight: 700, color: '#7c3aed'}}>📋 Light</span>
                  <span style={{color: 'var(--ink-muted)'}}>
                    Field portal only — daily/feed/equipment/weigh-in forms + Tasks
                  </span>
                </div>
              </div>

              {allUsers.length === 0 && (
                <div style={{textAlign: 'center', padding: '2rem', color: 'var(--ink-faint)', fontSize: 13}}>
                  Loading users…
                </div>
              )}

              {allUsers.map((u) => (
                <div
                  key={u.id}
                  data-user-management-row={u.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    marginBottom: 8,
                    overflow: 'hidden',
                    background: 'white',
                  }}
                >
                  <div style={{padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12}}>
                    {/* Avatar */}
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: '50%',
                        background: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 18,
                        flexShrink: 0,
                        border: '2px solid ' + (roleColor[u.role] || '#e5e7eb'),
                      }}
                    >
                      {u.role === 'admin'
                        ? '👑'
                        : u.role === 'management'
                          ? '🔑'
                          : u.role === 'equipment_tech'
                            ? '🚜'
                            : u.role === 'inactive'
                              ? '🚫'
                              : u.role === 'light'
                                ? '📋'
                                : '🌾'}
                    </div>
                    {/* Name + email */}
                    <div style={{flex: 1, minWidth: 0, overflow: 'hidden'}}>
                      {editingUser?.id === u.id ? (
                        <input
                          autoFocus
                          value={editingUser.full_name || ''}
                          onChange={(e) => setEditingUser({...editingUser, full_name: e.target.value})}
                          onBlur={() => updateName(u.id, editingUser.full_name || '')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.currentTarget.blur();
                            }
                          }}
                          disabled={userMutationBusy}
                          data-user-management-name-input={u.id}
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            border: '1px solid #3b82f6',
                            borderRadius: 10,
                            padding: '2px 6px',
                            width: '100%',
                            fontFamily: 'inherit',
                          }}
                        />
                      ) : (
                        <div style={{display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2}}>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 13,
                              color: 'var(--ink)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              flex: 1,
                              minWidth: 0,
                            }}
                          >
                            {u.full_name || '(no name)'}
                          </div>
                          {u.id === authState?.user?.id && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#085041',
                                background: '#dcfce7',
                                padding: '1px 6px',
                                borderRadius: 10,
                                fontWeight: 600,
                                flexShrink: 0,
                              }}
                            >
                              you
                            </span>
                          )}
                          <button
                            type="button"
                            title="Edit name"
                            aria-label={`Edit name for ${u.full_name || u.email || 'user'}`}
                            data-user-management-edit-name={u.id}
                            disabled={userMutationBusy}
                            onClick={() => setEditingUser({id: u.id, full_name: u.full_name || ''})}
                            style={{
                              fontSize: 11,
                              color: 'var(--ink-faint)',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '0 2px',
                              flexShrink: 0,
                            }}
                          >
                            ✎
                          </button>
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--ink-faint)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {u.email}
                      </div>
                    </div>
                    {/* Role selector */}
                    <select
                      value={u.role || 'farm_team'}
                      onChange={(e) => updateRole(u.id, e.target.value)}
                      disabled={u.id === authState?.user?.id || userMutationBusy}
                      data-user-management-role={u.id}
                      style={{
                        fontSize: 12,
                        padding: '5px 10px',
                        borderRadius: 10,
                        border: '1px solid var(--border-strong)',
                        color: roleColor[u.role] || '#374151',
                        fontWeight: 600,
                        flexShrink: 0,
                        width: '140px',
                        background: roleBg[u.role] || '#f9fafb',
                        opacity: u.id === authState?.user?.id || userMutationBusy ? 0.6 : 1,
                        cursor: u.id === authState?.user?.id || userMutationBusy ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {ROLES.map((r) => (
                        <option key={r.v} value={r.v}>
                          {r.l}
                        </option>
                      ))}
                      {u.role === 'inactive' && <option value="inactive">Inactive</option>}
                    </select>
                  </div>
                  {u.id !== authState?.user?.id && u.role !== 'admin' && u.role !== 'light' && (
                    <div style={{padding: '5px 14px', borderTop: '1px solid var(--divider)', background: '#fafafa'}}>
                      <div
                        style={{
                          fontSize: 10,
                          color: 'var(--ink-muted)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 4,
                          fontWeight: 600,
                        }}
                      >
                        Program access
                      </div>
                      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                        {[
                          ['broiler', '\ud83d\udc14 Broiler'],
                          ['layer', '\ud83e\udd5a Layer'],
                          ['pig', '\ud83d\udc37 Pig'],
                          ['cattle', renderCattleIconLabel('Cattle', {size: 15})],
                          ['sheep', '\ud83d\udc11 Sheep'],
                          ['equipment', '\ud83d\ude9c Equipment'],
                        ].map(([k, l]) => {
                          const list = Array.isArray(u.program_access) ? u.program_access : null;
                          const allAccess = !list || list.length === 0;
                          const has = allAccess || list.includes(k);
                          return (
                            <button
                              key={k}
                              type="button"
                              data-user-management-program={`${u.id}:${k}`}
                              disabled={userMutationBusy}
                              onClick={() => {
                                const cur =
                                  Array.isArray(u.program_access) && u.program_access.length > 0
                                    ? u.program_access
                                    : ['broiler', 'layer', 'pig', 'cattle', 'sheep', 'equipment'];
                                const next = has ? cur.filter((x) => x !== k) : Array.from(new Set([...cur, k]));
                                updateProgramAccess(u.id, next);
                              }}
                              style={{
                                fontSize: 11,
                                padding: '4px 10px',
                                borderRadius: 10,
                                border: '1px solid ' + (has ? 'var(--brand)' : 'var(--border-strong)'),
                                background: 'white',
                                color: has ? 'var(--brand)' : 'var(--ink-muted)',
                                fontFamily: 'inherit',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              {l}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{fontSize: 10, color: 'var(--ink-faint)', marginTop: 4}}>
                        {!Array.isArray(u.program_access) || u.program_access.length === 0
                          ? 'All programs'
                          : u.program_access.length + ' of 6 programs'}
                      </div>
                    </div>
                  )}
                  {u.id !== authState?.user?.id && (
                    <div
                      style={{
                        padding: '5px 14px',
                        borderTop: '1px solid var(--divider)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: '#fafafa',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      {u.role !== 'inactive' ? (
                        <button
                          onClick={() => sendPasswordReset(u.id, u.email, u.full_name)}
                          disabled={userMutationBusy}
                          style={{
                            fontSize: 11,
                            color: 'var(--brand)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          🔑 Send password reset
                        </button>
                      ) : (
                        <span></span>
                      )}
                      <div style={{display: 'flex', gap: 10, alignItems: 'center'}}>
                        {u.role !== 'inactive' ? (
                          <button
                            onClick={() => deactivateUser(u.id, u.email)}
                            data-user-management-deactivate={u.id}
                            disabled={userMutationBusy}
                            style={{
                              fontSize: 11,
                              color: '#b91c1c',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            onClick={() => updateRole(u.id, 'farm_team')}
                            data-user-management-reactivate={u.id}
                            disabled={userMutationBusy}
                            style={{
                              fontSize: 11,
                              color: '#085041',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          onClick={() => deleteUser(u.id, u.email)}
                          data-user-management-delete={u.id}
                          disabled={userMutationBusy}
                          style={{
                            fontSize: 11,
                            color: '#7f1d1d',
                            background: 'none',
                            border: '1px solid #fecaca',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            padding: '2px 8px',
                            borderRadius: 10,
                          }}
                        >
                          {'\ud83d\uddd1 Delete'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {umTab === 'add' && (
            <div>
              <div
                style={{
                  background: '#fffbeb',
                  border: '1px solid #fde68a',
                  borderRadius: 10,
                  padding: '10px 14px',
                  fontSize: 12,
                  color: '#92400e',
                  marginBottom: 14,
                }}
              >
                Set a password now to skip email delivery, or leave the password fields blank to send a password reset
                email.
              </div>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div style={{gridColumn: '1/-1'}}>
                  <label
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      display: 'block',
                      marginBottom: 3,
                      fontWeight: 500,
                    }}
                  >
                    Full name
                  </label>
                  <input
                    value={addName}
                    disabled={userMutationBusy}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="e.g. Simon Jones"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      width: '100%',
                    }}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      display: 'block',
                      marginBottom: 3,
                      fontWeight: 500,
                    }}
                  >
                    Email address *
                  </label>
                  <input
                    type="email"
                    value={addEmail}
                    disabled={userMutationBusy}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="user@whitecreek.farm"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      width: '100%',
                    }}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      display: 'block',
                      marginBottom: 3,
                      fontWeight: 500,
                    }}
                  >
                    Role
                  </label>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${ROLES.length}, 1fr)`,
                      borderRadius: 10,
                      overflow: 'hidden',
                      border: '1px solid #d1d5db',
                    }}
                  >
                    {ROLES.map((r, i) => (
                      <button
                        key={r.v}
                        type="button"
                        disabled={userMutationBusy}
                        onClick={() => setAddRole(r.v)}
                        style={{
                          padding: '9px 0',
                          border: 'none',
                          borderRight: i < ROLES.length - 1 ? '1px solid #d1d5db' : 'none',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: userMutationBusy ? 'not-allowed' : 'pointer',
                          background: 'white',
                          color: addRole === r.v ? 'var(--brand)' : 'var(--ink-muted)',
                          opacity: userMutationBusy ? 0.6 : 1,
                        }}
                      >
                        {r.l}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      display: 'block',
                      marginBottom: 3,
                      fontWeight: 500,
                    }}
                  >
                    Set password
                  </label>
                  <input
                    type="password"
                    value={addPassword}
                    disabled={userMutationBusy}
                    onChange={(e) => setAddPassword(e.target.value)}
                    placeholder="Optional"
                    autoComplete="new-password"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      width: '100%',
                    }}
                  />
                </div>
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-muted)',
                      display: 'block',
                      marginBottom: 3,
                      fontWeight: 500,
                    }}
                  >
                    Confirm password
                  </label>
                  <input
                    type="password"
                    value={addPasswordConfirm}
                    disabled={userMutationBusy}
                    onChange={(e) => setAddPasswordConfirm(e.target.value)}
                    placeholder="Optional"
                    autoComplete="new-password"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      width: '100%',
                    }}
                  />
                </div>
              </div>
              <button
                onClick={createUser}
                disabled={userMutationBusy}
                style={{
                  width: '100%',
                  marginTop: 16,
                  padding: '10px',
                  borderRadius: 10,
                  border: 'none',
                  background: umLoading ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: umLoading ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {umLoading
                  ? 'Creating user…'
                  : addPassword || addPasswordConfirm
                    ? 'Create User with Password'
                    : 'Create User & Send Email'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default UsersModal;
