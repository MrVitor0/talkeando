import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  let listener: ((event: { op: string; data: any }) => void) | null = null;
  return {
    send: vi.fn(),
    subscribe: vi.fn((l: (e: { op: string; data: any }) => void) => {
      listener = l;
      return () => {};
    }),
    dispatch: (op: string, data?: unknown) => listener?.({ op, data }),
  };
});
vi.mock("./ipc", () => ({ send: ipc.send, subscribe: ipc.subscribe }));
vi.mock("./clientLog", () => ({ logClient: vi.fn(), maybeAutoSend: vi.fn(), sendDiagnostics: vi.fn() }));

const cs = vi.hoisted(() => ({ leave: vi.fn(async () => {}) }));
vi.mock("./callSession", () => ({ leave: cs.leave }));

const spec = vi.hoisted(() => ({ stop: vi.fn(async () => {}) }));
vi.mock("./spectator", () => spec);

const screen = vi.hoisted(() => ({ stop: vi.fn(async () => {}) }));
vi.mock("./screenPublisher", () => screen);

const store = vi.hoisted(() => ({ requestFullSnapshot: vi.fn() }));
vi.mock("./voiceStore", () => store);

import { installShutdownHandler } from "./shutdown";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // The module `installed` flag persists; each test that needs a fresh handler
  // relies on module isolation via vi.resetModules where required.
});

describe("shutdown", () => {
  it("teardown stops screen, spectator and the call, then replies ready", async () => {
    vi.useRealTimers();
    vi.resetModules();
    const { installShutdownHandler: install } = await import("./shutdown");
    install();

    ipc.dispatch("app.shutdown.request", { reason: "closing" });
    await new Promise(r => setTimeout(r, 0));

    expect(screen.stop).toHaveBeenCalled();
    expect(spec.stop).toHaveBeenCalled();
    expect(cs.leave).toHaveBeenCalled();
    expect(ipc.send).toHaveBeenCalledWith("app.shutdown.ready", {});
  });

  it("replies ready even when a teardown step throws", async () => {
    vi.useRealTimers();
    vi.resetModules();
    screen.stop.mockRejectedValueOnce(new Error("capture stuck"));
    cs.leave.mockRejectedValueOnce(new Error("room gone"));
    const { installShutdownHandler: install } = await import("./shutdown");
    install();

    ipc.dispatch("app.shutdown.request", {});
    await new Promise(r => setTimeout(r, 0));

    expect(ipc.send).toHaveBeenCalledWith("app.shutdown.ready", {});
  });

  it("installs the IPC handler only once", async () => {
    vi.useRealTimers();
    vi.resetModules();
    const { installShutdownHandler: install } = await import("./shutdown");
    install();
    install();
    install();
    expect(ipc.subscribe).toHaveBeenCalledTimes(1);
  });

  it("a large wall-clock jump triggers a full snapshot request", async () => {
    vi.resetModules();
    const nowSpy = vi.spyOn(Date, "now");
    let clock = 1_000_000;
    nowSpy.mockImplementation(() => clock);
    const { installShutdownHandler: install } = await import("./shutdown");
    install();

    clock += 120_000; // 2 minutes passed while "asleep"
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.requestFullSnapshot).toHaveBeenCalledWith("wake");
    nowSpy.mockRestore();
  });
});
