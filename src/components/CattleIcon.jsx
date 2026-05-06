export const CATTLE_ICON_SRC = '/icons/black_angus_face.svg';

export default function CattleIcon({size = 18, style, ...props}) {
  return (
    <img
      src={CATTLE_ICON_SRC}
      alt=""
      aria-hidden="true"
      draggable="false"
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        display: 'inline-block',
        verticalAlign: 'middle',
        flex: '0 0 auto',
        ...style,
      }}
      {...props}
    />
  );
}

export function CattleIconLabel({children, size = 18, gap = 5, style}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap,
        verticalAlign: 'middle',
        ...style,
      }}
    >
      <CattleIcon size={size} />
      <span>{children}</span>
    </span>
  );
}

export function renderCattleIcon(size = 18, style) {
  return <CattleIcon size={size} style={style} />;
}

export function renderCattleIconLabel(children, {size = 18, gap = 5, style} = {}) {
  return (
    <CattleIconLabel size={size} gap={gap} style={style}>
      {children}
    </CattleIconLabel>
  );
}
