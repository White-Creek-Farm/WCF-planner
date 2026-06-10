// Phase 2 Round 3 extraction (verbatim).
import React, {useState} from 'react';
import {sb} from '../lib/supabase.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
import {unwrapEdgeFunctionError} from '../lib/edgeErrors.js';
function UsersModal({sb, authState, allUsers, setAllUsers, setShowUsers, loadUsers}) {
  const {setAuthState} = useAuth() || {};
  const [umTab, setUmTab] = React.useState('users');
  const [addEmail, setAddEmail] = React.useState('');
  const [addName, setAddName] = React.useState('');
  const [addRole, setAddRole] = React.useState('farm_team');
  // No password field. The admin-only edge function creates the auth account
  // with a throwaway password, then sends a password-set link to the user.
  const [umMsg, setUmMsg] = React.useState('');
  const [umErr, setUmErr] = React.useState('');
  const [umLoading, setUmLoading] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState(null);

  const ROLES = [
    {v: 'farm_team', l: 'Farm Team'},
    {v: 'management', l: 'Management'},
    {v: 'admin', l: 'Admin'},
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
    setUmLoading(true);
    setUmErr('');
    setUmMsg('');
    try {
      const {data: fnData, error} = await sb.functions.invoke('rapid-processor', {
        body: {type: 'user_create', data: {email: addEmail.trim(), name: addName.trim(), role: addRole}},
      });
      if (error) throw error;
      // The auth account succeeded if we reached this branch. Welcome
      // email is best-effort \u2014 when rapid-processor returns
      // welcomeEmailDelivered:false the account IS usable, but we must
      // not show a green "Invite sent" \u2014 surface the Resend error and
      // tell the admin to use Send Password Reset on the user row.
      if (fnData && fnData.welcomeEmailDelivered === false) {
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
      loadUsers();
      setUmTab('users');
    } catch (e) {
      const msg = await unwrapEdgeFunctionError(e);
      setUmErr('Error: ' + msg);
    }
    setUmLoading(false);
  }

  async function sendPasswordReset(email, name) {
    window._wcfConfirm(
      'Send a password reset email to ' + email + '?',
      async () => {
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
        }
      },
      'Send',
    );
  }

  async function updateRole(userId, newRole) {
    await sb.from('profiles').update({role: newRole}).eq('id', userId);
    setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, role: newRole} : p)));
    setEditingUser(null);
  }

  async function updateName(userId, newName) {
    const fullName = (newName || '').trim();
    await sb.from('profiles').update({full_name: fullName}).eq('id', userId);
    setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, full_name: fullName} : p)));
    if (userId === authState?.user?.id && typeof setAuthState === 'function') {
      setAuthState((prev) => {
        if (!prev || prev === false || prev.user?.id !== userId) return prev;
        return {
          ...prev,
          profile: prev.profile ? {...prev.profile, full_name: fullName} : prev.profile,
          name: fullName || prev.user?.email || prev.name || '',
        };
      });
    }
    setEditingUser(null);
  }

  async function deactivateUser(userId, email) {
    window._wcfConfirm(
      'Deactivate ' + email + '? They will no longer be able to log in.',
      async () => {
        await sb.from('profiles').update({role: 'inactive'}).eq('id', userId);
        setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, role: 'inactive'} : p)));
      },
      'Deactivate',
    );
  }

  // Hard delete: removes the auth.users row (via service-role edge function)
  // AND the profiles row. After this the email is fully recyclable for a
  // fresh invite. Deactivate keeps the user but blocks login.
  async function deleteUser(userId, email) {
    window._wcfConfirmDelete(
      'PERMANENTLY DELETE ' +
        email +
        '? This removes the auth account so the email can be re-invited from scratch. Deactivate instead if you just want to block login.',
      async () => {
        setUmErr('');
        setUmMsg('');
        try {
          const {error: fnErr} = await sb.functions.invoke('rapid-processor', {
            body: {type: 'user_delete', data: {id: userId, email}},
          });
          if (fnErr) throw fnErr;
          await sb.from('profiles').delete().eq('id', userId);
          setAllUsers((prev) => prev.filter((p) => p.id !== userId));
          setUmMsg('\u2705 Deleted ' + email + '. Email is now free to re-invite.');
        } catch (e) {
          const msg = await unwrapEdgeFunctionError(e);
          setUmErr(
            'Could not delete ' +
              email +
              ': ' +
              msg +
              '. The auth account stays. Add the user_delete handler to your rapid-processor edge function to enable hard delete.',
          );
        }
      },
    );
  }

  async function updateProgramAccess(userId, newList) {
    // Empty array → null (means "all programs"). Avoids empty-array ambiguity.
    const value = newList && newList.length > 0 ? newList : null;
    await sb.from('profiles').update({program_access: value}).eq('id', userId);
    setAllUsers((prev) => prev.map((p) => (p.id === userId ? {...p, program_access: value} : p)));
  }

  const roleColor = {
    admin: '#b91c1c',
    management: '#1d4ed8',
    farm_team: '#085041',
    light: '#7c3aed',
    inactive: '#9ca3af',
  };
  const roleBg = {admin: '#fef2f2', management: '#eff6ff', farm_team: '#ecfdf5', light: '#f5f3ff', inactive: '#f3f4f6'};

  return (
    <div
      onClick={() => setShowUsers(false)}
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
            borderBottom: '1px solid #e5e7eb',
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
            onClick={() => setShowUsers(false)}
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              cursor: 'pointer',
              color: '#9ca3af',
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        <div style={{display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px'}}>
          {[
            ['users', '👥 Users'],
            ['add', '➕ Add User'],
          ].map(([t, l]) => (
            <button
              key={t}
              onClick={() => {
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
                cursor: 'pointer',
                marginBottom: -1,
              }}
            >
              {l}
            </button>
          ))}
        </div>

        <div style={{padding: '16px 20px'}}>
          {umMsg && (
            <div
              style={{
                background: '#ecfdf5',
                border: '1px solid #a7f3d0',
                borderRadius: 6,
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
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: 6,
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
                  background: '#f8fafc',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '10px 14px',
                  fontSize: 11,
                  marginBottom: 14,
                }}
              >
                <div style={{fontWeight: 600, marginBottom: 6, fontSize: 12}}>Permission levels</div>
                <div style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', lineHeight: 1.5}}>
                  <span style={{fontWeight: 700, color: '#085041'}}>🌾 Farm Team</span>
                  <span style={{color: '#6b7280'}}>Edit & delete daily reports only</span>
                  <span style={{fontWeight: 700, color: '#1d4ed8'}}>🔑 Management</span>
                  <span style={{color: '#6b7280'}}>Edit anything · delete daily reports only</span>
                  <span style={{fontWeight: 700, color: '#b91c1c'}}>👑 Admin</span>
                  <span style={{color: '#6b7280'}}>Full access — edit & delete everything</span>
                  <span style={{fontWeight: 700, color: '#7c3aed'}}>📋 Light</span>
                  <span style={{color: '#6b7280'}}>
                    Field portal only — daily/feed/equipment/weigh-in forms + Tasks
                  </span>
                </div>
              </div>

              {allUsers.length === 0 && (
                <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af', fontSize: 13}}>Loading users…</div>
              )}

              {allUsers.map((u) => (
                <div
                  key={u.id}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    marginBottom: 8,
                    overflow: 'hidden',
                    background: u.id === authState?.user?.id ? '#f0fdf4' : 'white',
                  }}
                >
                  <div style={{padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12}}>
                    {/* Avatar */}
                    <div
                      style={{
                        width: 38,
                        height: 38,
                        borderRadius: '50%',
                        background: roleBg[u.role] || '#f3f4f6',
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
                            if (e.key === 'Enter') updateName(u.id, editingUser.full_name || '');
                          }}
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            border: '1px solid #3b82f6',
                            borderRadius: 4,
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
                              color: '#111827',
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
                            onClick={() => setEditingUser({id: u.id, full_name: u.full_name || ''})}
                            style={{
                              fontSize: 11,
                              color: '#9ca3af',
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
                          color: '#9ca3af',
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
                      disabled={u.id === authState?.user?.id}
                      style={{
                        fontSize: 12,
                        padding: '5px 10px',
                        borderRadius: 6,
                        border: '1px solid #d1d5db',
                        color: roleColor[u.role] || '#374151',
                        fontWeight: 600,
                        flexShrink: 0,
                        width: '130px',
                        background: roleBg[u.role] || '#f9fafb',
                        opacity: u.id === authState?.user?.id ? 0.6 : 1,
                        cursor: u.id === authState?.user?.id ? 'not-allowed' : 'pointer',
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
                    <div style={{padding: '5px 14px', borderTop: '1px solid #f3f4f6', background: '#fafafa'}}>
                      <div
                        style={{
                          fontSize: 10,
                          color: '#6b7280',
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
                                borderRadius: 6,
                                border: '1px solid ' + (has ? '#085041' : '#d1d5db'),
                                background: has ? '#085041' : 'white',
                                color: has ? 'white' : '#9ca3af',
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
                      <div style={{fontSize: 10, color: '#9ca3af', marginTop: 4}}>
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
                        borderTop: '1px solid #f3f4f6',
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
                          onClick={() => sendPasswordReset(u.email, u.full_name)}
                          style={{
                            fontSize: 11,
                            color: '#1d4ed8',
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
                          style={{
                            fontSize: 11,
                            color: '#7f1d1d',
                            background: 'none',
                            border: '1px solid #fecaca',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            padding: '2px 8px',
                            borderRadius: 4,
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
                  borderRadius: 6,
                  padding: '10px 14px',
                  fontSize: 12,
                  color: '#92400e',
                  marginBottom: 14,
                }}
              >
                The new user will receive a password reset email to set their own password.
              </div>
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3, fontWeight: 500}}>
                    Full name
                  </label>
                  <input
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                    placeholder="e.g. Simon Jones"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      width: '100%',
                    }}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3, fontWeight: 500}}>
                    Email address *
                  </label>
                  <input
                    type="email"
                    value={addEmail}
                    onChange={(e) => setAddEmail(e.target.value)}
                    placeholder="user@whitecreek.farm"
                    style={{
                      fontSize: 13,
                      padding: '8px 12px',
                      border: '1px solid #d1d5db',
                      borderRadius: 6,
                      width: '100%',
                    }}
                  />
                </div>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3, fontWeight: 500}}>
                    Role
                  </label>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${ROLES.length}, 1fr)`,
                      borderRadius: 6,
                      overflow: 'hidden',
                      border: '1px solid #d1d5db',
                    }}
                  >
                    {ROLES.map((r, i) => (
                      <button
                        key={r.v}
                        type="button"
                        onClick={() => setAddRole(r.v)}
                        style={{
                          padding: '9px 0',
                          border: 'none',
                          borderRight: i < ROLES.length - 1 ? '1px solid #d1d5db' : 'none',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: addRole === r.v ? '#085041' : '#f9fafb',
                          color: addRole === r.v ? 'white' : '#4b5563',
                        }}
                      >
                        {r.l}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                onClick={createUser}
                disabled={umLoading}
                style={{
                  width: '100%',
                  marginTop: 16,
                  padding: '10px',
                  borderRadius: 6,
                  border: 'none',
                  background: umLoading ? '#9ca3af' : '#085041',
                  color: 'white',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: umLoading ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {umLoading ? 'Creating user…' : 'Create User & Send Email'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default UsersModal;
