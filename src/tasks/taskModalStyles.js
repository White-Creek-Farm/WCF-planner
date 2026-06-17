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

export const taskModalSystemRulePanel = {
  ...taskModalSmallPanel,
  width: 'min(520px, 96vw)',
};

export const taskModalFieldLabel = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ink)',
  marginBottom: 4,
  display: 'block',
};

export const taskModalInput = {
  width: '100%',
  padding: '8px 11px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

export const taskModalReadOnlyBlock = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  marginBottom: 10,
};

const taskModalButtonBase = {
  padding: '10px 16px',
  borderRadius: 10,
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
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink)',
};

export const taskModalErrorNotice = {
  background: '#fef2f2',
  border: '1px solid #fecaca',
  color: '#991b1b',
  padding: '8px 12px',
  borderRadius: 10,
  marginTop: 12,
  fontSize: 13,
};

export const taskModalHistoryRow = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--ink)',
};

export const taskModalSubtleText = {fontSize: 12, color: 'var(--ink-muted)'};

export const taskPhotoLightboxOverlay = {
  ...taskModalOverlay,
  background: 'rgba(0,0,0,.8)',
  zIndex: 300,
  flexDirection: 'column',
};

export const taskPhotoLightboxPanel = {
  background: 'white',
  borderRadius: 10,
  padding: 16,
  maxWidth: 'min(900px, 96vw)',
  maxHeight: '92vh',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

export const taskPhotoLightboxButton = {
  ...taskModalGhostButton,
  fontWeight: 500,
};

export const taskPhotoLightboxFrame = {
  background: '#0b0b0b',
  borderRadius: 10,
  padding: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 240,
  maxHeight: '70vh',
};
