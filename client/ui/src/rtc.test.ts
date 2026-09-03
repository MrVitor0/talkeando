import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => ({
  Room: class {},
  RoomEvent: {},
  Track: { Kind: { Video: "video", Audio: "audio" }, Source: { Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio", Microphone: "microphone" } },
}));
vi.mock("./clientLog", () => ({ logClient: vi.fn(), maybeAutoSend: vi.fn(), sendDiagnostics: vi.fn() }));
vi.mock("./ipc", () => ({ send: vi.fn(), subscribe: () => () => {} }));
vi.mock("./serverInfo", () => ({ hasFeature: () => true }));
vi.mock("./voiceStore", () => ({ setLiveParticipants: vi.fn(), clearSession: vi.fn(), initVoiceStore: vi.fn(), setSpeaking: vi.fn(), requestFullSnapshot: vi.fn() }));
vi.mock("./remoteMedia", () => ({
  addRemoteVideo: vi.fn(),
  removeRemoteVideo: vi.fn(),
  clearRemoteVideos: vi.fn(),
  subscribeRemoteVideos: vi.fn(),
  getRemoteVideos: vi.fn(() => []),
  findRemoteVideo: vi.fn(),
  watchRequestedAt: new Map(),
}));
vi.mock("./screenPublisher", () => ({
  start: vi.fn(),
  stop: vi.fn(),
  switchSource: vi.fn(),
  reconfigure: vi.fn(),
  active: () => null,
}));
vi.mock("./audioPipeline", () => ({
  AudioPipelineManager: class {
    onStatus() {}
    get current() {
      return null;
    }
  },
}));

const cs = vi.hoisted(() => ({ room: null as any }));
vi.mock("./callSession", () => ({
  activeRoom: () => cs.room,
  snapshot: () => ({ id: 1, channelId: "ch", participantSid: null, state: "connected" }),
  isCurrent: () => true,
  registerResource: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
}));

import * as rtc from "./rtc";

/** A room whose one screen publication records setSubscribed calls. */
function roomWithScreen(ownerId: string) {
  const calls: boolean[] = [];
  const publication = { source: "screen_share", setSubscribed: (v: boolean) => calls.push(v) };
  return {
    calls,
    remoteParticipants: new Map([[ownerId, { trackPublications: new Map([["TR_1", publication]]) }]]),
  };
}

beforeEach(() => {
  cs.room = null;
});
afterEach(() => {
  // Drain any lingering intent so cases don't bleed into each other.
  rtc.stopWatchingStream("A", "hover");
  rtc.stopWatchingStream("A", "stage");
});

describe("watch intent counter (RC-17)", () => {
  it("hover then stage: leaving the hover keeps the subscription", () => {
    const room = roomWithScreen("A");
    cs.room = room;

    rtc.watchStream("A", "hover"); // 1st reason → subscribe(true)
    rtc.watchStream("A", "stage"); // already subscribed → no extra call
    rtc.stopWatchingStream("A", "hover"); // "stage" remains → NO unsubscribe

    expect(room.calls).toEqual([true]);
  });

  it("stage only unsubscribes when no reason remains", () => {
    const room = roomWithScreen("A");
    cs.room = room;

    rtc.watchStream("A", "stage");
    rtc.stopWatchingStream("A", "stage");

    expect(room.calls).toEqual([true, false]);
  });

  it("adding the same reason twice does not re-subscribe", () => {
    const room = roomWithScreen("A");
    cs.room = room;

    rtc.watchStream("A", "hover");
    rtc.watchStream("A", "hover");

    expect(room.calls).toEqual([true]);
  });
});
