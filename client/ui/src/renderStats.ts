/**
 * Per-component render counter, dev only. Proves memoization worked instead of
 * assuming it. Read from the console with `window.__tupiRenderStats()`.
 */
const counts = new Map<string, number>();

export function countRender(name: string) {
  if (!import.meta.env.DEV) return;
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__tupiRenderStats = () =>
    Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
  (window as unknown as Record<string, unknown>).__tupiResetRenderStats = () => counts.clear();
}
