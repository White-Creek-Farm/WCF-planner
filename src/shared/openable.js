// Shared click + keyboard props for non-button openable surfaces (the
// .hoverable-tile / .hoverable-row affordance contract). Mirrors the inline
// pattern locked in EquipmentFleetView/WeighInSessionListTile: role="button",
// tabIndex={0}, and Enter/Space activation, so keyboard users get the same
// whole-element action as mouse users.
//
// The e.target !== e.currentTarget guard keeps Enter/Space on a nested
// control (Clear/Edit buttons inside a row) from also firing the row open;
// nested controls own their own activation. Click bubbling from nested
// controls is each call site's job (stopPropagation on the nested control).
export function openableProps(open) {
  return {
    onClick: open,
    role: 'button',
    tabIndex: 0,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(e);
      }
    },
  };
}
