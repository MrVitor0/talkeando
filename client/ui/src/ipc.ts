export type Envelope = { v: number; op: string; data: any };
type Listener = (event: Envelope) => void;
const listeners = new Set<Listener>();

declare global { interface Window { chrome?: { webview?: { postMessage: (message: unknown) => void; addEventListener: (name: string, handler: (event: MessageEvent<unknown>) => void) => void } } } }

// The native host posts events via CoreWebView2.PostWebMessageAsJson, which
// (unlike PostWebMessageAsString) delivers event.data as an *already-parsed*
// value, not a JSON string — calling JSON.parse on it here used to throw on
// every single event (a plain object stringifies to "[object Object]",
// which isn't valid JSON) and get silently swallowed, so no event from
// native ever reached the UI. Confirmed by comparing a native-side log that
// showed every step of auth/login succeeding against a UI that never
// changed state at all.
window.chrome?.webview?.addEventListener("message", event => {
  try { const envelope = event.data as Envelope; listeners.forEach(listener => listener(envelope)); }
  catch (error) { console.error("Failed to handle host event", event.data, error); }
});

export function send(op: string, data: Record<string, unknown> = {}) { window.chrome?.webview?.postMessage({ v: 1, op, data }); }
export function subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); }
