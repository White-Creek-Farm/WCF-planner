const listTileStyle = {
  background: 'white',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '10px 16px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const embeddedTileStyle = {
  padding: '10px 16px',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const labelStyle = {fontSize: 13, fontWeight: 700, color: 'var(--ink)', minWidth: 120};
const metaStyle = {fontSize: 11, color: 'var(--ink-muted)'};

export function WeighInSessionStatusBadge({status}) {
  const isComplete = status === 'complete';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 10,
        background: isComplete ? '#d1fae5' : '#fef3c7',
        color: isComplete ? '#065f46' : '#92400e',
        textTransform: 'uppercase',
      }}
    >
      {status}
    </span>
  );
}

export default function WeighInSessionListTile({
  session,
  label,
  fmt,
  countLabel,
  countColor = 'var(--brand)',
  onClick,
  beforeStatus = null,
  afterCount = null,
  embedded = false,
  children = null,
}) {
  // The whole tile is one action and every child is a static badge/label, so
  // it can safely carry button semantics for the keyboard :focus-visible
  // affordance. Callers that pass interactive children must drop these props.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (onClick) onClick(e);
    }
  };
  return (
    <div
      data-weighin-session-tile={session.id}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="hoverable-tile"
      style={embedded ? embeddedTileStyle : listTileStyle}
    >
      <span style={labelStyle}>{label}</span>
      {beforeStatus}
      <WeighInSessionStatusBadge status={session.status} />
      <span style={metaStyle}>{fmt(session.date)}</span>
      <span style={metaStyle}>{session.team_member}</span>
      <span style={{fontSize: 11, fontWeight: 600, color: countColor}}>{countLabel}</span>
      {afterCount}
      {children}
    </div>
  );
}
