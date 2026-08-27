export type Envelope = { v: number; op: string; data: any };
type Listener = (event: Envelope) => void;
const listeners = new Set<Listener>();

declare global { interface Window { chrome?: { webview?: { postMessage: (message: unknown) => void; addEventListener: (name: string, handler: (event: MessageEvent<string>) => void) => void } } } }

window.chrome?.webview?.addEventListener("message", event => {
  try { const envelope = JSON.parse(event.data) as Envelope; listeners.forEach(listener => listener(envelope)); } catch { /* Ignore malformed host events. */ }
});

export function send(op: string, data: Record<string, unknown> = {}) { window.chrome?.webview?.postMessage({ v: 1, op, data }); }
export function subscribe(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); }
