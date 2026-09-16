// Wait for native focus recovery before focusing the mounted form field.
export function focusModalInput(
  getInput: () => HTMLElement | null,
  focusWindow: () => Promise<unknown>,
): () => void {
  let cancelled = false;
  let frame: number | undefined;
  void (async () => {
    try { await focusWindow(); } catch { /* Browser preview has no native window. */ }
    if (cancelled) return;
    frame = requestAnimationFrame(() => {
      if (!cancelled) getInput()?.focus({ preventScroll: true });
    });
  })();
  return () => {
    cancelled = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
