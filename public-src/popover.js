import { useLayoutEffect } from 'preact/hooks';

/** A header popover closes on Escape, giving focus back to its button, and on a press outside `trigger` and `refs`. */
export function useDismiss(open, close, trigger, ...refs) {
  useLayoutEffect(() => {
    if (!open) return undefined;
    const inside = (target) => [trigger, ...refs].some((ref) => ref.current?.contains(target));
    const down = (e) => { if (!inside(e.target)) close(); };
    const key = (e) => {
      // A modal dialog over the popover (the photosensitivity question) answers its own Escape.
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      close();
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
}
