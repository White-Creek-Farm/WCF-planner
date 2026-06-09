export const taskModalOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  zIndex: 250,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

const taskModalPanelBase = {
  background: 'white',
  borderRadius: 10,
  padding: 18,
  fontFamily: 'inherit',
};

export const taskModalPanel = {
  ...taskModalPanelBase,
  width: 'min(560px, 96vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
};

export const taskModalSmallPanel = {
  ...taskModalPanelBase,
  width: 'min(480px, 96vw)',
};

export const taskModalFieldLabel = {
  fontSize: 12,
  fontWeight: 600,
  color: '#374151',
  marginBottom: 4,
  display: 'block',
};

export const taskModalInput = {
  width: '100%',
  padding: '8px 11px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const taskModalButtonBase = {
  padding: '10px 16px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};

export const taskModalPrimaryButton = {
  ...taskModalButtonBase,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
};

export const taskModalDangerButton = {
  ...taskModalButtonBase,
  border: '1px solid #b91c1c',
  background: '#b91c1c',
  color: 'white',
};

export const taskModalGhostButton = {
  ...taskModalButtonBase,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
};

export const taskModalErrorNotice = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  padding: '8px 12px',
  borderRadius: 6,
  marginTop: 12,
  fontSize: 13,
};

export const taskModalHistoryRow = {
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  color: '#374151',
};

export const taskModalSubtleText = {fontSize: 12, color: '#6b7280'};
