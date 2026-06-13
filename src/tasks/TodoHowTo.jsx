// How to Use modal for the shared To Do List (CattleLogHowTo pattern).
//
// Explains when to submit a real assigned Task vs when to add an item to the
// communal To Do List, plus the completion/approval flow. The management
// callout renders only for management/admin.

import React from 'react';

const CARD = {
  background: 'white',
  borderRadius: 10,
  padding: 20,
  width: 'min(540px, 94vw)',
  maxHeight: '88vh',
  overflowY: 'auto',
  fontFamily: 'inherit',
};

const H = {fontSize: 14, fontWeight: 700, color: '#085041', margin: '14px 0 4px'};
const P = {fontSize: 13, color: '#374151', margin: '0 0 6px', lineHeight: 1.5};

export default function TodoHowTo({onClose, canManage}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.5)',
        zIndex: 250,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="How to use the To Do List"
      data-todo-howto-modal="1"
      onClick={onClose}
    >
      <div style={CARD} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12}}>
          <h2 style={{fontSize: 18, margin: 0, color: '#111827'}}>How to use the To Do List</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'transparent',
              fontSize: 18,
              cursor: 'pointer',
              color: '#6b7280',
              fontFamily: 'inherit',
            }}
          >
            ✕
          </button>
        </div>

        <p style={{...P, marginTop: 8}}>
          The To Do List is the farm&apos;s shared pile of open work that anyone can pick up — a good list to work
          through on rain days. Anyone can add an item and anyone can knock one out.
        </p>

        <h3 style={H}>Task or To Do?</h3>
        <p style={P}>
          <strong>Submit a Task</strong> when the work belongs to a specific person or has a real deadline — tasks are
          assigned, dated, and tracked per person in the Task Center.
        </p>
        <p style={P}>
          <strong>Add a To Do</strong> when it just needs to get done by whoever gets to it first: you don&apos;t know
          who to assign it to, or it isn&apos;t urgent. No assignee, no required date.
        </p>

        <h3 style={H}>Sections and order</h3>
        <p style={P}>
          Items live in General, Chicken &amp; Pigs, or Cattle &amp; Sheep. The order inside a section IS the priority —
          managers arrange the list, so start near the top. Use the toggle at the top to view one section or all three.
        </p>

        <h3 style={H}>Completing an item</h3>
        <p style={P}>
          Did one? Hit Complete and add a note and photos of the result (each item holds up to 5 photos total). Your
          completion shows as <em>Awaiting approval</em> until a manager signs off and moves it into the collapsed
          Completed section. If it gets sent back, the item reopens with the manager&apos;s note.
        </p>

        <h3 style={H}>Mentions and photos</h3>
        <p style={P}>
          Open any item to comment on it — @mention someone there and they get a notification that links straight back
          to the item. Photos added when listing or completing an item always show as thumbnails.
        </p>

        {canManage ? (
          <>
            <h3 style={H}>Managers</h3>
            <p style={P}>
              Management and admin approve or reject completions, drag items to set priority, move items between
              sections, remove items, and can turn any To Do into a real assigned Task — the item leaves the list once
              the Task is created.
            </p>
          </>
        ) : null}

        <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 16}}>
          <button
            type="button"
            data-todo-howto-close="1"
            onClick={onClose}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              border: '1px solid #085041',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
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
