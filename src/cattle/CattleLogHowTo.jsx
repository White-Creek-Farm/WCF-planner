// CattleLogHowTo — role-aware "How to use" modal for the Cattle Log page.
// Pattern copied from the Daily Reports hub App Setup modal (WebformHub →
// AppSetupModal): fixed overlay closes on backdrop click, card stops
// propagation, right-aligned "Got it" button.
//
// All roles see the core usage notes (#tag linking, mirroring, search,
// @mentions, the Issue checkbox, unknown-tag calf details, attachment cap,
// offline queueing). management/admin additionally see the issue clear /
// re-check instructions (toggles save immediately).
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
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
const managerCalloutS = {
  marginTop: 14,
  background: '#f0f7f4',
  border: '1px solid #cfe6d8',
  borderRadius: 8,
  padding: '10px 12px',
  color: '#085041',
  fontSize: 12,
  lineHeight: 1.45,
};

export default function CattleLogHowTo({onClose, canManageIssues = false}) {
  return (
    <div
      style={overlayS}
      role="dialog"
      aria-modal="true"
      aria-label="How to use the Cattle Log"
      data-cattle-log-howto-modal="1"
      onClick={onClose}
    >
      <div style={cardS} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
          <div style={{fontSize: 17, fontWeight: 800, color: '#111827'}}>How to use the Cattle Log</div>
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
          The Cattle Log is the running notebook for the herd. Write what you saw, link the cows involved, and flag
          anything that needs follow-up.
        </div>

        <div style={sectionTitle}>Linking cows with #tags</div>
        <ul style={ulS}>
          <li>
            Type <b>#</b> followed by the cow's tag number (for example <b>#214</b>) anywhere in your note.
          </li>
          <li>Each linked entry also shows up on that cow's record page automatically.</li>
          <li>One note can link several cows — every #tag in the note mirrors to its cow.</li>
        </ul>

        <div style={sectionTitle}>Unknown tags (new calves)</div>
        <ul style={ulS}>
          <li>
            If a #tag doesn't match an active cow, you'll be asked for calf details — herd, date of birth, sex, and
            origin — before submitting.
          </li>
          <li>The entry stays flagged as an issue until the tag is resolved.</li>
          <li>When a cow with that tag is added later, the entry links to it automatically.</li>
        </ul>

        <div style={sectionTitle}>Mentions, issues, and search</div>
        <ul style={ulS}>
          <li>
            Type <b>@</b> to mention a teammate — they get a notification that links straight to the entry.
          </li>
          <li>
            The <b>Issue</b> checkbox means "this needs attention." It starts checked; uncheck it for purely
            informational notes. Entries with unknown tags are always issues.
          </li>
          <li>
            The <b>Issues</b> filter is the work queue; <b>All</b> shows the full history.
          </li>
          <li>
            Search covers the entire log — note text, author names, and tags. Searching <b>214</b> or <b>#214</b> both
            find tag #214.
          </li>
        </ul>

        <div style={sectionTitle}>Photos</div>
        <ul style={ulS}>
          <li>Attach up to 5 photos per entry.</li>
        </ul>

        <div style={calloutS}>
          No signal? Submit anyway. The entry is saved on this device, shows at the top of the list as queued, and sends
          automatically when you reconnect. Calf details for unknown tags can be sorted out afterwards.
        </div>

        {canManageIssues && (
          <div style={managerCalloutS} data-cattle-log-howto-manager="1">
            <b>Management:</b> you can check or uncheck the Issue box on any entry, in both directions — clear an issue
            once it's handled, or re-check it to put the entry back in the queue. Clicking the checkbox saves
            immediately; there is no separate save step. You can also delete any entry.
          </div>
        )}

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
