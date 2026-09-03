import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => ({
  Room: class {},
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    TrackPublished: "trackPublished",
    ParticipantConnected: "participantConnected",
    Disconnected: "disconnected",
  },
  Track: { Kind: { Video: "video" }, Source: { Camera: "camera", ScreenShare: "screen_share" } },
}));
vi.mock("./clientLog", () => ({ logClient: vi.fn(), maybeAutoSend: vi.fn(), sendDiagnostics: vi.fn() }));

const rtc = vi.hoisted(() => ({ mintCredentials: vi.fn(async () => ({ url: "ws://x", token: "t" })) }));
vi.mock("./rtc", () => ({ mintCredentials: rtc.mintCredentials }));

const remoteMedia = vi.hoisted(() => ({
  addRemoteVideo: vi.fn(),
  removeRemoteVideo: vi.fn(),
  removeVideosFromRoom: vi.fn(),
}));
vi.mock("./remoteMedia", () => remoteMedia);

import * as spectator from "./spectator";

class FakeRoom {
  connectCalls = 0;
  disconnectCalls = 0;
  remoteParticipants = new Map();
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  on(event: string, handler: (...a: unknown[]) => void) {
    (this.listeners.get(event) ?? this.listeners.set(event, []).get(event)!).push(handler);
    return this;
  }
  removeAllListeners() {
    this.listeners.clear();
  }
  async connect() {
    this.connectCalls += 1;
  }
  async disconnect() {
    this.disconnectCalls += 1;
  }
}

let rooms: FakeRoom[] = [];
function installFactory() {
  rooms = [];
  spectator.__setRoomFactory(() => {
    const r = new FakeRoom();
    rooms.push(r);
    return r as unknown as import("livekit-client").Room;
  });
}

afterEach(() => {
  spectator.__resetForTest();
  rtc.mintCredentials.mockClear();
  Object.values(remoteMedia).forEach(fn => fn.mockClear());
});

describe("spectator", () => {
  it("mints a spectator-mode credential and tracks the target (U-30 / INV-D3)", async () => {
    installFactory();
    await spectator.watch("ch-1", "owner-A");
    expect(rtc.mintCredentials).toHaveBeenCalledWith("ch-1", "spectator");
    expect(spectator.watching()).toEqual({ channelId: "ch-1", ownerId: "owner-A" });
    expect(rooms).toHaveLength(1);
  });

  it("watching the same owner twice does not reconnect", async () => {
    installFactory();
    await spectator.watch("ch-1", "owner-A");
    await spectator.watch("ch-1", "owner-A");
    expect(rooms).toHaveLength(1);
    expect(rooms[0].connectCalls).toBe(1);
  });

  it("watching another owner disconnects the previous room first", async () => {
    installFactory();
    await spectator.watch("ch-1", "owner-A");
    await spectator.watch("ch-1", "owner-B");
    expect(rooms).toHaveLength(2);
    expect(rooms[0].disconnectCalls).toBe(1);
    expect(spectator.watching()).toEqual({ channelId: "ch-1", ownerId: "owner-B" });
  });

  it("stop disconnects the room and removes only that room's videos (U-31)", async () => {
    installFactory();
    await spectator.watch("ch-1", "owner-A");
    await spectator.stop();
    expect(rooms[0].disconnectCalls).toBe(1);
    expect(remoteMedia.removeVideosFromRoom).toHaveBeenCalledWith("spectator:1");
    expect(spectator.watching()).toBeNull();
  });

  it("a failed credential mint is a silent no-op", async () => {
    installFactory();
    rtc.mintCredentials.mockRejectedValueOnce(new Error("timeout"));
    await spectator.watch("ch-1", "owner-A");
    expect(spectator.watching()).toBeNull();
    expect(rooms).toHaveLength(0);
  });
});
