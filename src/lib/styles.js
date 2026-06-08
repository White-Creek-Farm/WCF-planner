// Shared inline-style object. Verbatim extract from main.jsx.
export const S = {
  header: {
    // Homepage-redesign "header-green" gradient (modern-themes.css .header-green):
    // 102deg, two-stop oklch greens. The shipped header was already a green
    // gradient with white text + white 36px icon buttons, so this aligns the
    // exact hue/angle to the design without touching DOM, hooks, or behavior.
    background: 'linear-gradient(102deg, oklch(0.355 0.058 166), oklch(0.435 0.078 170))',
    color: 'white',
    padding: '10px 1.25rem',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    position: 'sticky',
    top: 0,
    zIndex: 100,
    boxShadow: '0 2px 8px rgba(0,0,0,.12)',
  },
  navBtn: (active) => ({
    padding: '10px 16px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    fontFamily: 'inherit',
    background: active ? 'white' : 'rgba(255,255,255,.15)',
    color: active ? '#085041' : 'rgba(255,255,255,.9)',
  }),
  addBtn: {
    padding: '10px 16px',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    background: '#085041',
    color: 'white',
  },
  card: {background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden'},
  label: {fontSize: 12, color: '#4b5563', marginBottom: 3, display: 'block'},
  fieldGroup: {display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10},
  badge: (bg, tx) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    background: bg,
    color: tx,
  }),
  btnPrimary: {
    padding: '10px 16px',
    borderRadius: 6,
    border: 'none',
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
    background: '#085041',
    color: 'white',
    width: '100%',
    boxSizing: 'border-box',
  },
  btnDanger: {
    padding: '10px 16px',
    borderRadius: 6,
    border: '1px solid #F09595',
    cursor: 'pointer',
    background: 'white',
    color: '#b91c1c',
    fontSize: 13,
  },
  btnGhost: {
    padding: '10px 16px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    cursor: 'pointer',
    background: 'white',
    color: '#4b5563',
    fontSize: 13,
  },
};

// Pick dark or light text for any colored background. Threshold 0.5 on
// perceived luminance (YIQ): lighter half gets near-black, darker half
// gets white. Use anywhere program/palette colors back inline text —
// timeline bars, batch tile headers, herd/flock cycle headers, etc.
export function getReadableText(hexBg) {
  if (!hexBg) return '#0f172a';
  const c = String(hexBg).replace('#', '');
  if (c.length !== 6) return '#0f172a';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L >= 0.5 ? '#0f172a' : 'white';
}
