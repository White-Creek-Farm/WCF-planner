import React from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isFocusable(el) {
  if (!el || typeof el.focus !== 'function') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.disabled) return false;
  return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
}

function focusInitial(dialog, selector) {
  if (!dialog) return;
  const initial = selector ? dialog.querySelector(selector) : null;
  const focusable = isFocusable(initial) ? initial : getFocusable(dialog)[0];
  if (focusable) focusable.focus();
  else if (typeof dialog.focus === 'function') dialog.focus();
}

function getFocusable(dialog) {
  if (!dialog || typeof dialog.querySelectorAll !== 'function') return [];
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusable);
}

export function useModalFocusTrap({onCancel, initialFocusSelector = '[data-modal-initial-focus]'}) {
  const dialogRef = React.useRef(null);
  const returnFocusRef = React.useRef(null);

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const active = document.activeElement;
    returnFocusRef.current = active && typeof active.focus === 'function' ? active : null;

    const runFocus = () => focusInitial(dialogRef.current, initialFocusSelector);
    let rafId = null;
    let timeoutId = null;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(runFocus);
    } else {
      timeoutId = setTimeout(runFocus, 0);
    }

    return () => {
      if (rafId != null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
      }
      if (timeoutId != null) clearTimeout(timeoutId);
      const target = returnFocusRef.current;
      if (target && typeof target.focus === 'function') {
        try {
          target.focus();
        } catch (_e) {
          /* return-focus is best effort; the opener may have unmounted */
        }
      }
    };
  }, [initialFocusSelector]);

  const handleDialogKeyDown = React.useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable(dialogRef.current);
      if (focusable.length === 0) {
        e.preventDefault();
        if (dialogRef.current && typeof dialogRef.current.focus === 'function') dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = typeof document !== 'undefined' ? document.activeElement : null;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  return {dialogRef, handleDialogKeyDown};
}
