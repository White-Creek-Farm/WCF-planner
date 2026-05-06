// AppSetupModal — shared "App Setup" modal used by the public daily-reports
// hub (WebformHub) and the public equipment hub (FuelingHub). Teaches the
// canonical URLs and the Add-to-Home-Screen install flow on iOS Safari +
// Android Chrome. No service worker yet, so the copy includes the offline
// caveat: queued submissions stay tied to the same browser storage.
import React from 'react';

const overlayS = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.55)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '24px 12px',
  zIndex: 1000,
  overflowY: 'auto',
};

const cardS = {
  background: 'white',
  borderRadius: 14,
  border: '1px solid #e5e7eb',
  boxShadow: '0 14px 40px rgba(15,23,42,0.18)',
  padding: '20px 22px 22px',
  maxWidth: 520,
  width: '100%',
  fontFamily: 'inherit',
};

const sectionTitle = {fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 14, marginBottom: 6};
const labelS = {fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4};
const urlBoxS = {
  fontFamily: 'monospace',
  fontSize: 13,
  color: '#085041',
  background: '#f0f7f4',
  border: '1px solid #cfe6d8',
  borderRadius: 8,
  padding: '6px 10px',
  display: 'inline-block',
  marginTop: 4,
};
const olS = {paddingLeft: 18, margin: '4px 0 0', color: '#374151', fontSize: 13, lineHeight: 1.45};
const ulS = {paddingLeft: 18, margin: '4px 0 0', color: '#374151', fontSize: 13, lineHeight: 1.45};
const calloutS = {
  marginTop: 14,
  background: '#fff7ed',
  border: '1px solid #fdba74',
  borderRadius: 8,
  padding: '10px 12px',
  color: '#9a3412',
  fontSize: 12,
  lineHeight: 1.45,
};

export default function AppSetupModal({onClose}) {
  return (
    <div style={overlayS} role="dialog" aria-modal="true" aria-label="App Setup" onClick={onClose}>
      <div style={cardS} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
          <div style={{fontSize: 17, fontWeight: 800, color: '#111827'}}>App Setup</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              fontSize: 22,
              lineHeight: 1,
              color: '#6b7280',
              cursor: 'pointer',
              padding: '0 4px',
              fontFamily: 'inherit',
            }}
          >
            {'×'}
          </button>
        </div>

        <div style={{fontSize: 13, color: '#374151', lineHeight: 1.5}}>
          Open the right URL once, then add it to your home screen so it launches like an app.
        </div>

        <div style={sectionTitle}>Best URLs</div>
        <div>
          <div style={labelS}>Daily reports</div>
          <div style={urlBoxS}>wcfplanner.com/dailys</div>
        </div>
        <div style={{marginTop: 8}}>
          <div style={labelS}>Equipment / fueling</div>
          <div style={urlBoxS}>wcfplanner.com/equipment</div>
        </div>

        <div style={sectionTitle}>iPhone (Safari)</div>
        <ol style={olS}>
          <li>Open the URL in Safari (not Chrome or an in-app browser).</li>
          <li>Tap the Share button.</li>
          <li>Tap Add to Home Screen.</li>
        </ol>

        <div style={sectionTitle}>Android (Chrome)</div>
        <ol style={olS}>
          <li>Open the URL in Chrome.</li>
          <li>Tap the three-dot menu.</li>
          <li>Tap Add to Home screen, or Install app if it shows.</li>
        </ol>

        <div style={sectionTitle}>Why bother</div>
        <ul style={ulS}>
          <li>Opens like an app and lands on the right hub every time.</li>
          <li>Avoids in-app browsers from text/email links, which sometimes break the photo picker.</li>
          <li>Photo picker and camera are more reliable from the home-screen launcher.</li>
          <li>Queued submissions stay tied to the same browser storage as the icon you installed.</li>
        </ul>

        <div style={calloutS}>
          Heads up: this app does not have offline-cache yet. Start forms with signal when possible. If something says
          {' "queued"'} or {'"saved on this device,"'} reconnect and reopen the same home-screen icon to flush.
        </div>

        <div style={{marginTop: 16, textAlign: 'right'}}>
          <button
            onClick={onClose}
            style={{
              background: '#085041',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
