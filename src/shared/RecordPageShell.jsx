// Shared, purely presentational record-page chrome. These primitives capture
// the repeated non-domain layout that every shipped operational record page
// already uses: the app frame + Header, the loading state, the not-found state,
// the centered content wrapper, the back link, and the record title.
//
// They know nothing about entity types, routes, Supabase, auth, Comments,
// Activity, sequence navigation, or mutations. Pages keep their own data
// loading and branching and compose these pieces. Sequence navigation
// (RecordSequenceNav), Comments/Activity (RecordCollaborationSection), and
// inline notices (InlineNotice) remain page-composed and are intentionally not
// part of this shell.

const BACK_LINK_BASE = {
  background: 'none',
  border: 'none',
  color: '#1d4ed8',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'inherit',
  padding: 0,
};

// Outer app frame: full-height neutral background plus the optional Header.
// Used by every record-page state (loading, not-found, loaded). Extra props
// (e.g. a state-specific data attribute like data-access-denied="1") are spread
// onto the frame's root div.
export function RecordPageFrame({Header, children, ...rest}) {
  return (
    <div {...rest} style={{minHeight: '100vh', background: '#f1f3f2'}}>
      {Header && <Header />}
      {children}
    </div>
  );
}

// Centered loading state.
export function RecordPageLoading({Header, label = 'Loading…', ...rest}) {
  return (
    <RecordPageFrame Header={Header} {...rest}>
      <div style={{padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 14}}>{label}</div>
    </RecordPageFrame>
  );
}

// Not-found state: a plain back link above an explanatory message. The back
// link here is intentionally lighter (no fontWeight) than the loaded-page
// RecordBackLink, matching the existing record pages. Extra props (e.g. a
// state-specific frame data attribute) are forwarded to the frame's root div.
export function RecordPageNotFound({Header, backLabel, onBack, message, ...rest}) {
  return (
    <RecordPageFrame Header={Header} {...rest}>
      <div style={{padding: 24}}>
        <button type="button" onClick={onBack} style={BACK_LINK_BASE}>
          {'← '}
          {backLabel}
        </button>
        <div style={{marginTop: 16, color: '#6b7280', fontSize: 14}}>{message}</div>
      </div>
    </RecordPageFrame>
  );
}

// Centered content wrapper for the loaded record. `maxWidth` is configurable
// and defaults to the established 800. An optional `style` merges last so a
// page can extend the wrapper without losing the default margin/padding. Any
// other props (e.g. a page-specific data attribute) are spread onto the div.
export function RecordPageBody({children, maxWidth = 800, style, ...rest}) {
  return (
    <div {...rest} style={{maxWidth, margin: '0 auto', padding: '12px 16px', ...style}}>
      {children}
    </div>
  );
}

// Back link shown at the top of a loaded record page.
export function RecordBackLink({label, onBack}) {
  return (
    <div style={{marginBottom: 12}}>
      <button type="button" onClick={onBack} style={{...BACK_LINK_BASE, fontWeight: 500}}>
        {'← '}
        {label}
      </button>
    </div>
  );
}

// Record page title. `fontSize` and `margin` are configurable so denser batch
// title rows can opt into 24/0 while animal/daily pages keep the standard
// record default (26 / '0 0 12px'). An optional `style` merges last for any
// further tweak.
export function RecordTitle({children, fontSize = 26, margin = '0 0 12px', style}) {
  return (
    <h1 data-record-title="1" style={{fontSize, fontWeight: 700, color: '#111827', margin, lineHeight: 1.2, ...style}}>
      {children}
    </h1>
  );
}
