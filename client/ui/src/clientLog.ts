/**
 * Structured client-side event log. SPEC-014 turns this into a ring buffer
 * plus `POST /api/client-logs`. For now it just writes to the console so the
 * call-session / screen-publisher events exist and have a stable shape.
 */
export function logClient(event: string, fields: Record<string, unknown> = {}) {
  console.info(`[client] ${event}`, fields);
}
