/**
 * Diagnostics ring buffer. Stays in memory and leaves the machine only when
 * the user asks or an error trigger fires (rate-limited). SPEC-014.
 *
 * NEVER record: session token, LiveKit JWT, message content, a shared file's
 * name, a captured window's title. Identities (user_id, channel_id, track_sid)
 * are fine — opaque, and needed to correlate with the server log.
 */
import { send, subscribe } from "./ipc";
import { serverInfo } from "./serverInfo";
import * as callSession from "./callSession";
import { getState as voiceState } from "./voiceStore";
import * as screenPublisher from "./screenPublisher";
import { getRemoteVideos } from "./remoteMedia";

export type ClientLogEntry = {
  at: string; // ISO 8601
  event: string;
  fields: Record<string, unknown>;
};

const CAPACITY = 500;
const buffer: ClientLogEntry[] = [];

const FORBIDDEN_KEYS = /token|secret|password|authorization|jwt|credential/i;
const MAX_VALUE_LENGTH = 200;

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      output[key] = value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      output[key] = value;
    } else {
      output[key] = String(value).slice(0, MAX_VALUE_LENGTH);
    }
  }
  return output;
}

export function logClient(event: string, fields: Record<string, unknown> = {}) {
  const entry: ClientLogEntry = { at: new Date().toISOString(), event, fields: sanitize(fields) };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.shift();
  if (import.meta.env.DEV) console.info(`[tupi] ${event}`, entry.fields);
}

export function snapshotLogs(): ClientLogEntry[] {
  return [...buffer];
}
export function clearLogs(): void {
  buffer.length = 0;
}

// ---- report + send ----

export type DiagnosticsReport = {
  client_version: string;
  protocol_version: number;
  server_version: string;
  reason: string;
  collected_at: string;
  context: {
    channel_id: string | null;
    call_state: string;
    participants: number;
    watching: number;
    sharing: boolean;
    connection_state: string;
    user_agent: string;
  };
  entries: ClientLogEntry[];
};

let connectionState = "unknown";
subscribe(event => {
  if (event.op === "connection.state" && typeof event.data?.state === "string") {
    connectionState = event.data.state;
  }
});

export function buildReport(reason: string): DiagnosticsReport {
  const info = serverInfo();
  const session = callSession.snapshot();
  return {
    client_version: info.serverVersion === "unknown" ? "unknown" : info.serverVersion,
    protocol_version: info.protocolVersion,
    server_version: info.serverVersion,
    reason,
    collected_at: new Date().toISOString(),
    context: {
      channel_id: session.channelId,
      call_state: session.state,
      participants: voiceState().session.participants.length,
      watching: getRemoteVideos().filter(v => v.source === "screen_share").length,
      sharing: screenPublisher.state() === "sharing",
      connection_state: connectionState,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    },
    entries: snapshotLogs(),
  };
}

/** Uploads via the native host (which holds the token). Resolves true on
 *  acceptance. */
export async function sendDiagnostics(reason: string): Promise<boolean> {
  const report = buildReport(reason);
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => {
      off();
      resolve(false);
    }, 10_000);
    const off = subscribe(event => {
      if (event.op === "diagnostics.uploaded") {
        clearTimeout(timer);
        off();
        resolve(true);
      } else if (event.op === "diagnostics.failed") {
        clearTimeout(timer);
        off();
        resolve(false);
      }
    });
    send("diagnostics.upload", { report });
  });
}

// ---- automatic triggers ----

export type AutoTrigger = "join_failed" | "version_gap" | "unexpected_disconnect" | "watch_stalled";
const AUTO_INTERVAL_MS = 10 * 60 * 1000;
let lastAutoSendAt = 0;

/** At most one automatic send per 10 minutes, so it never becomes continuous
 *  telemetry. */
export function maybeAutoSend(reason: AutoTrigger) {
  const now = Date.now();
  if (now - lastAutoSendAt < AUTO_INTERVAL_MS) return;
  lastAutoSendAt = now;
  void sendDiagnostics(`auto:${reason}`);
}
