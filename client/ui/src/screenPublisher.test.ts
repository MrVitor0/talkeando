import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => ({
  Track: { Source: { ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } },
}));
vi.mock("./clientLog", () => ({ logClient: vi.fn() }));
vi.mock("./serverInfo", () => ({ hasFeature: () => true }));

const ipc = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./ipc", () => ({ send: ipc.send, subscribe: () => () => {} }));

const nativeScreen = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => {}),
}));
vi.mock("./nativeScreen", () => ({
  startNativeScreen: nativeScreen.start,
  stopNativeScreen: nativeScreen.stop,
}));

const cs = vi.hoisted(() => ({
  room: null as any,
  sessionId: 1,
  current: true,
  resources: [] as Array<() => unknown>,
}));
vi.mock("./callSession", () => ({
  activeRoom: () => cs.room,
  snapshot: () => ({ id: cs.sessionId, channelId: "ch-1" }),
  isCurrent: () => cs.current,
  registerResource: (_id: number, dispose: () => unknown) => cs.resources.push(dispose),
}));

import * as screenPublisher from "./screenPublisher";

/** A fake Room whose `publishTrack` hands back the trackSid the test asks for,
 *  and whose `trackPublications` map reflects what has been published. */
function fakeRoom(opts: { audioPublishThrows?: boolean } = {}) {
  const publications = new Map<string, any>();
  return {
    publications,
    localParticipant: {
      publishTrack: vi.fn(async (track: MediaStreamTrack, o: { source: string }) => {
        if (o.source === "screen_share_audio" && opts.audioPublishThrows) throw new Error("audio publish failed");
        const sid = o.source === "screen_share" ? "TR_video" : "TR_audio";
        const pub = { trackSid: sid, source: o.source, track };
        publications.set(sid, pub);
        return pub;
      }),
      unpublishTrack: vi.fn(async (track: MediaStreamTrack) => {
        for (const [sid, pub] of publications) if (pub.track === track) publications.delete(sid);
      }),
      get trackPublications() {
        return publications;
      },
    },
  };
}
function fakeStream(withAudio: boolean) {
  const v = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
  const a = { kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
  return {
    getVideoTracks: () => [v],
    getAudioTracks: () => (withAudio ? [a] : []),
    getTracks: () => (withAudio ? [v, a] : [v]),
  } as unknown as MediaStream;
}

afterEach(() => {
  screenPublisher.__resetForTest();
  ipc.send.mockClear();
  nativeScreen.start.mockReset();
  nativeScreen.stop.mockClear();
  cs.resources = [];
  cs.current = true;
});

describe("screenPublisher", () => {
  it("hints use the real LiveKit track sids, never a UUID", async () => {
    cs.room = fakeRoom();
    nativeScreen.start.mockReturnValue(fakeStream(true));
    await screenPublisher.start({ sourceId: "screen:0", height: 720, fps: 30, withAudio: true });

    const hints = ipc.send.mock.calls.filter(([op]) => op === "voice.track.hint");
    const sids = hints.map(([, payload]) => (payload as any).track_sid).sort();
    expect(sids).toEqual(["TR_audio", "TR_video"]);
  });

  it("start over a live share stops the previous first and bumps the generation", async () => {
    cs.room = fakeRoom();
    nativeScreen.start.mockReturnValue(fakeStream(false));
    await screenPublisher.start({ sourceId: "a", height: 720, fps: 30, withAudio: false });
    const gen1 = screenPublisher.active()!.generation;

    nativeScreen.start.mockReturnValue(fakeStream(false));
    await screenPublisher.start({ sourceId: "b", height: 720, fps: 30, withAudio: false });
    const gen2 = screenPublisher.active()!.generation;

    expect(gen2).toBeGreaterThan(gen1);
    // The old capture was stopped before the new one published.
    expect(nativeScreen.stop).toHaveBeenCalledWith(gen1);
    expect(screenPublisher.active()!.sourceId).toBe("b");
  });

  it("unpublish removes audio before video, and both complete", async () => {
    cs.room = fakeRoom();
    nativeScreen.start.mockReturnValue(fakeStream(true));
    await screenPublisher.start({ sourceId: "a", height: 720, fps: 30, withAudio: true });

    const order: string[] = [];
    cs.room.localParticipant.unpublishTrack.mockImplementation(async (track: any) => {
      order.push(track.kind);
      for (const [sid, pub] of cs.room.publications) if (pub.track === track) cs.room.publications.delete(sid);
    });

    await screenPublisher.stop();
    expect(order).toEqual(["audio", "video"]);
    expect(cs.room.publications.size).toBe(0);
    expect(screenPublisher.state()).toBe("idle");
  });

  it("a failed audio publish unpublishes the already-published video", async () => {
    cs.room = fakeRoom({ audioPublishThrows: true });
    nativeScreen.start.mockReturnValue(fakeStream(true));

    await expect(
      screenPublisher.start({ sourceId: "a", height: 720, fps: 30, withAudio: true }),
    ).rejects.toThrow(/audio publish failed/);

    expect(cs.room.publications.size).toBe(0); // video was rolled back
    expect(screenPublisher.state()).toBe("idle");
    expect(nativeScreen.stop).toHaveBeenCalled();
  });

  it("the session-teardown resource stops the capture", async () => {
    cs.room = fakeRoom();
    nativeScreen.start.mockReturnValue(fakeStream(false));
    await screenPublisher.start({ sourceId: "a", height: 720, fps: 30, withAudio: false });
    expect(cs.resources).toHaveLength(1);

    await cs.resources[0]();
    expect(screenPublisher.state()).toBe("idle");
    expect(nativeScreen.stop).toHaveBeenCalled();
  });

  it("switchSource does not republish and keeps the same generation", async () => {
    cs.room = fakeRoom();
    nativeScreen.start.mockReturnValue(fakeStream(false));
    await screenPublisher.start({ sourceId: "a", height: 720, fps: 30, withAudio: false });
    const gen = screenPublisher.active()!.generation;
    const publishes = cs.room.localParticipant.publishTrack.mock.calls.length;

    await screenPublisher.switchSource("b");

    expect(screenPublisher.active()!.generation).toBe(gen);
    expect(screenPublisher.active()!.sourceId).toBe("b");
    expect(cs.room.localParticipant.publishTrack.mock.calls.length).toBe(publishes);
    expect(ipc.send).toHaveBeenCalledWith(
      "screen.capture.start",
      expect.objectContaining({ source_id: "b", generation: gen }),
    );
  });
});
