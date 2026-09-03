import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  const listeners = new Set<(e: { op: string; data: any }) => void>();
  return {
    send: vi.fn(),
    subscribe: vi.fn((l: (e: { op: string; data: any }) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
    dispatch: (op: string, data?: unknown) => listeners.forEach(l => l({ op, data })),
  };
});
vi.mock("./ipc", () => ({ send: ipc.send, subscribe: ipc.subscribe }));
vi.mock("./serverInfo", () => ({ serverInfo: () => ({ protocolVersion: 2, serverVersion: "1.4.0", features: new Set() }) }));
vi.mock("./callSession", () => ({ snapshot: () => ({ id: 0, state: "idle", channelId: null, participantSid: null }) }));
vi.mock("./voiceStore", () => ({ getState: () => ({ rooms: {}, session: { channelId: null, participants: [] }, speaking: new Set() }) }));
vi.mock("./screenPublisher", () => ({ state: () => "idle" }));
vi.mock("./remoteMedia", () => ({ getRemoteVideos: () => [] }));

import * as clientLog from "./clientLog";

beforeEach(() => {
  clientLog.clearLogs();
  ipc.send.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("clientLog", () => {
  it("redacts forbidden keys", () => {
    clientLog.logClient("x", { access_token: "abc123", Authorization: "Bearer z", jwt: "y", channel_id: "ok" });
    const [entry] = clientLog.snapshotLogs();
    expect(entry.fields.access_token).toBe("[redacted]");
    expect(entry.fields.Authorization).toBe("[redacted]");
    expect(entry.fields.jwt).toBe("[redacted]");
    expect(entry.fields.channel_id).toBe("ok");
  });

  it("truncates long strings", () => {
    clientLog.logClient("x", { note: "a".repeat(500) });
    const value = clientLog.snapshotLogs()[0].fields.note as string;
    expect(value.length).toBe(201); // 200 chars + the ellipsis
    expect(value.endsWith("…")).toBe(true);
  });

  it("nested objects become truncated strings", () => {
    clientLog.logClient("x", { err: { message: "boom", url: "https://x/y" } });
    expect(typeof clientLog.snapshotLogs()[0].fields.err).toBe("string");
  });

  it("the ring buffer keeps the last 500 entries", () => {
    for (let i = 0; i < 600; i++) clientLog.logClient(`e${i}`);
    const logs = clientLog.snapshotLogs();
    expect(logs).toHaveLength(500);
    expect(logs[0].event).toBe("e100");
    expect(logs[499].event).toBe("e599");
  });

  it("auto-send respects the 10-minute interval", async () => {
    vi.useFakeTimers();
    clientLog.maybeAutoSend("join_failed");
    clientLog.maybeAutoSend("version_gap"); // < 10 min later
    expect(ipc.send).toHaveBeenCalledTimes(1);
    expect(ipc.send.mock.calls[0][0]).toBe("diagnostics.upload");

    vi.advanceTimersByTime(11 * 60 * 1000);
    clientLog.maybeAutoSend("watch_stalled");
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });

  it("sendDiagnostics resolves true on diagnostics.uploaded", async () => {
    const promise = clientLog.sendDiagnostics("manual");
    ipc.dispatch("diagnostics.uploaded", {});
    expect(await promise).toBe(true);
  });
});
