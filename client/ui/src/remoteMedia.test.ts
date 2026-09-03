import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./clientLog", () => ({ logClient: vi.fn(), maybeAutoSend: vi.fn(), sendDiagnostics: vi.fn() }));

import * as remoteMedia from "./remoteMedia";
import type { RemoteVideo } from "./remoteMedia";

// A RemoteVideoTrack double: enough for the registry + the stall monitor.
function fakeTrack() {
  return {
    getReceiverStats: async () => ({ framesDecoded: 0 }),
    mediaStreamTrack: { muted: false } as MediaStreamTrack,
  } as unknown as RemoteVideo["track"];
}
function entry(over: Partial<RemoteVideo> = {}): RemoteVideo {
  return {
    ownerId: "u1",
    trackSid: "TR_1",
    source: "camera",
    track: fakeTrack(),
    roomKey: "call",
    ...over,
  };
}

afterEach(() => {
  remoteMedia.clearRemoteVideos();
  vi.clearAllTimers();
});

describe("remoteMedia", () => {
  it("classifies by source, not by msid — camera and screen from one owner", () => {
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_cam", source: "camera" }));
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_scr", source: "screen_share" }));

    expect(remoteMedia.findRemoteVideo("u1", "camera")?.trackSid).toBe("TR_cam");
    expect(remoteMedia.findRemoteVideo("u1", "screen_share")?.trackSid).toBe("TR_scr");
  });

  it("find returns undefined when the owner is not subscribed", () => {
    expect(remoteMedia.findRemoteVideo("nobody", "camera")).toBeUndefined();
    remoteMedia.addRemoteVideo(entry({ source: "camera" }));
    expect(remoteMedia.findRemoteVideo("u1", "screen_share")).toBeUndefined();
  });

  it("clear removes everything and notifies subscribers", () => {
    const seen: number[] = [];
    const off = remoteMedia.subscribeRemoteVideos(v => seen.push(v.length));
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_1" }));
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_2" }));
    remoteMedia.clearRemoteVideos();
    expect(remoteMedia.getRemoteVideos()).toHaveLength(0);
    expect(seen[seen.length - 1]).toBe(0);
    off();
  });

  it("remove by sid leaves the other track", () => {
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_1" }));
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_2" }));
    remoteMedia.removeRemoteVideo("TR_1");
    expect(remoteMedia.getRemoteVideos().map(v => v.trackSid)).toEqual(["TR_2"]);
  });

  it("re-adding the same sid resets its watch-requested timestamp", () => {
    remoteMedia.addRemoteVideo(entry({ trackSid: "TR_1" }));
    const first = remoteMedia.watchRequestedAt.get("TR_1")!;
    remoteMedia.removeRemoteVideo("TR_1");
    expect(remoteMedia.watchRequestedAt.get("TR_1")).toBeUndefined();
  });
});
