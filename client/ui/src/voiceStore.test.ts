import { afterEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => {
  let listener: ((event: { op: string; data: any }) => void) | null = null;
  return {
    send: vi.fn(),
    subscribe: vi.fn((l: (event: { op: string; data: any }) => void) => {
      listener = l;
      return () => {};
    }),
    dispatch: (op: string, data: unknown) => listener?.({ op, data }),
  };
});
vi.mock("./ipc", () => ({ send: ipc.send, subscribe: ipc.subscribe }));

const features = vi.hoisted(() => ({ set: new Set<string>(["voice.room.v2"]) }));
vi.mock("./serverInfo", () => ({ hasFeature: (name: string) => features.set.has(name) }));

import * as store from "./voiceStore";

function room(over: Partial<{ channel_id: string; version: number; participants: any[]; tracks: any[] }> = {}) {
  return { channel_id: "ch", version: 1, participants: [], tracks: [], ...over };
}
function delta(over: Partial<any> = {}) {
  return {
    channel_id: "ch",
    version: 2,
    previous_version: 1,
    participants_added: [],
    participants_updated: [],
    participants_removed: [],
    tracks_added: [],
    tracks_removed: [],
    reason: "webhook.participant_joined",
    ...over,
  };
}

afterEach(() => {
  store.__resetForTest();
  ipc.send.mockClear();
  features.set = new Set(["voice.room.v2"]);
});

describe("voiceStore", () => {
  it("applies delta in the fixed order (U-20)", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", {
      full: true,
      rooms: [room({ participants: [{ user_id: "a" }, { user_id: "b" }] })],
    });
    // Same delta: remove b, add b again with a sid → the add must win (order:
    // removed before added).
    ipc.dispatch(
      "voice.room.delta",
      delta({
        participants_removed: ["b"],
        participants_added: [{ user_id: "b", participant_sid: "PA_b" }],
      }),
    );
    const room2 = store.getState().rooms["ch"];
    expect(room2.version).toBe(2);
    expect(room2.participants.map(p => p.userId)).toEqual(["a", "b"]);
    expect(room2.participants.find(p => p.userId === "b")?.participantSid).toBe("PA_b");
  });

  it("requests a snapshot on a version gap and drops the delta (U-21)", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", { full: true, rooms: [room({ version: 1 })] });
    ipc.dispatch("voice.room.delta", delta({ previous_version: 5, version: 6 }));
    expect(store.getState().rooms["ch"].version).toBe(1); // not applied
    expect(ipc.send).toHaveBeenCalledWith("voice.room.request", { channel_ids: ["ch"] });
  });

  it("accepts a lower version as a server restart (U-22)", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", { full: true, rooms: [room({ version: 42, participants: [{ user_id: "a" }] })] });
    ipc.dispatch("voice.room.state", { full: true, rooms: [room({ version: 1, participants: [{ user_id: "b" }] })] });
    expect(store.getState().rooms["ch"].version).toBe(1);
    expect(store.getState().rooms["ch"].participants.map(p => p.userId)).toEqual(["b"]);
  });

  it("ignores a duplicate delta (U-23)", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", { full: true, rooms: [room({ version: 1 })] });
    ipc.dispatch("voice.room.delta", delta({ previous_version: 1, version: 2, participants_added: [{ user_id: "a" }] }));
    ipc.dispatch("voice.room.delta", delta({ previous_version: 1, version: 2, participants_added: [{ user_id: "a" }] }));
    expect(store.getState().rooms["ch"].participants).toHaveLength(1);
    expect(store.getState().rooms["ch"].version).toBe(2);
  });

  it("session participants come only from the live list", () => {
    store.initVoiceStore();
    // The server thinks X is in the channel...
    ipc.dispatch("voice.room.state", { full: true, rooms: [room({ channel_id: "c1", participants: [{ user_id: "x" }] })] });
    // ...but LiveKit only has me.
    store.setLiveParticipants("c1", [{ identity: "me", sid: "PA_me", isLocal: true }]);
    expect(store.getState().session.participants.map(p => p.userId)).toEqual(["me"]);
  });

  it("session overlay picks up mute from a delta (INV-C1 overlay)", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", {
      full: true,
      rooms: [room({ channel_id: "c1", version: 1, participants: [{ user_id: "a", muted: false }] })],
    });
    store.setLiveParticipants("c1", [
      { identity: "me", sid: "PA_me", isLocal: true },
      { identity: "a", sid: "PA_a", isLocal: false },
    ]);
    expect(store.getState().session.participants.find(p => p.userId === "a")?.muted).toBe(false);

    ipc.dispatch(
      "voice.room.delta",
      delta({ channel_id: "c1", participants_updated: [{ user_id: "a", muted: true }] }),
    );
    expect(store.getState().session.participants.find(p => p.userId === "a")?.muted).toBe(true);
  });

  it("v1 voice.roster converts to the same shape", () => {
    features.set = new Set(); // no voice.room.v2
    store.initVoiceStore();
    ipc.dispatch("voice.roster", {
      channel_id: "c1",
      participants: [{ user_id: "a", muted: true, deafened: false }],
      streams: [{ stream_id: "s1", owner: "a", kind: "screen", msid: "TR_1", has_audio: true }],
    });
    const proj = store.getState().rooms["c1"];
    expect(proj.version).toBe(0);
    expect(proj.participants[0]).toMatchObject({ userId: "a", muted: true, provisional: false });
    expect(proj.tracks.map(t => t.source).sort()).toEqual(["screen_share", "screen_share_audio"]);
    expect(store.roomStreams(proj).map(s => s.kind)).toEqual(["screen"]);
  });

  it("v1 voice.roster with an empty list removes the channel", () => {
    features.set = new Set();
    store.initVoiceStore();
    ipc.dispatch("voice.roster", { channel_id: "c1", participants: [{ user_id: "a" }], streams: [] });
    expect(store.getState().rooms["c1"]).toBeDefined();
    ipc.dispatch("voice.roster", { channel_id: "c1", participants: [], streams: [] });
    expect(store.getState().rooms["c1"]).toBeUndefined();
  });

  it("drops a track with an unknown source", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.state", {
      full: true,
      rooms: [room({ tracks: [{ track_sid: "TR_1", owner: "a", source: "wat" }, { track_sid: "TR_2", owner: "a", source: "camera" }] })],
    });
    expect(store.getState().rooms["ch"].tracks.map(t => t.trackSid)).toEqual(["TR_2"]);
  });

  it("a delta for an unknown channel requests that channel's snapshot", () => {
    store.initVoiceStore();
    ipc.dispatch("voice.room.delta", delta({ channel_id: "ghost" }));
    expect(ipc.send).toHaveBeenCalledWith("voice.room.request", { channel_ids: ["ghost"] });
    expect(store.getState().rooms["ghost"]).toBeUndefined();
  });
});
