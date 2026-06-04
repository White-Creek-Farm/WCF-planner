// Lane 1 CP1: locked submitter field for the authenticated Light-user portal.
//
// When a report/form surface is opened by a signed-in user (sessionSubmitter
// present), the operator/team-member roster dropdown is replaced by this
// read-only field showing the signed-in user as the locked submitter. There is
// no submitter selection on the authenticated path.
//
// This is a PURE presentational component. It does NOT import auth state or the
// Supabase client — the signed-in identity is passed in as a plain `name`
// string from main.jsx, preserving the public-webforms boundary (the form
// components stay decoupled from useAuth / the auth session).
import React from 'react';

export default function LockedSubmitter({name, label = 'Team Member', labelStyle, style}) {
  const boxStyle = style || {
    fontSize: 14,
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    background: '#f9fafb',
    color: '#374151',
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  };
  return (
    <div data-locked-submitter="1">
      {label != null && <label style={labelStyle}>{label}</label>}
      <div style={boxStyle}>
        <span aria-hidden="true">🔒</span>
        <span style={{fontWeight: 600}}>{name || 'Signed-in user'}</span>
        <span style={{marginLeft: 'auto', fontSize: 11, color: '#9ca3af'}}>signed in</span>
      </div>
    </div>
  );
}
