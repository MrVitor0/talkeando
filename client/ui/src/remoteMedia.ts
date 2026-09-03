/**
 * Registry of the live remote *video* tracks, so components can attach them to
 * their own visible `<video>`.
 *
 * Why not hand out a `MediaStream`: with `adaptiveStream`, LiveKit must observe
 * the element the user actually sees. Only `track.attach(element)` registers
 * that element (livekit-client). Wiring `srcObject` around the SDK makes it
 * report the track "invisible" and the SFU stops sending
 * (tupi-v2-refactor/02-root-cause-analysis.md RC-12).
 */
import type { RemoteVideoTrack } from "livekit-client";

import { logClient, maybeAutoSend } from "./clientLog";

export type RemoteVideoSource = "camera" | "screen_share";

export type RemoteVideo = {
  /** Tupi identity of the owner. */
  ownerId: string;
  trackSid: string;
  /** Derived from `publication.source`, always current — never `msid`. */
  source: RemoteVideoSource;
  track: RemoteVideoTrack;
  /** Which room this came from: `"call"` or `"spectator:<id>"`. Lets a
   *  spectator session tear down only its own videos (SPEC-011). */
  roomKey: string;
};

const videos = new Map<string, RemoteVideo>();
const stallStoppers = new Map<string, () => void>();
const listeners = new Set<(videos: RemoteVideo[]) => void>();
/** When each subscription was requested, for the `watch.first_frame` metric. */
export const watchRequestedAt = new Map<string, number>();

function emit() {
  const snapshot = [...videos.values()];
  listeners.forEach(listener => listener(snapshot));
}

export function addRemoteVideo(entry: RemoteVideo): void {
  videos.set(entry.trackSid, entry);
  watchRequestedAt.set(entry.trackSid, Date.now());
  stallStoppers.get(entry.trackSid)?.();
  stallStoppers.set(entry.trackSid, monitorStall(entry));
  emit();
}

export function removeRemoteVideo(trackSid: string): void {
  if (!videos.delete(trackSid)) return;
  stallStoppers.get(trackSid)?.();
  stallStoppers.delete(trackSid);
  watchRequestedAt.delete(trackSid);
  emit();
}

export function clearRemoteVideos(): void {
  if (!videos.size) return;
  for (const stop of stallStoppers.values()) stop();
  stallStoppers.clear();
  videos.clear();
  watchRequestedAt.clear();
  emit();
}

/** Removes only the videos that came from `roomKey` (a spectator session
 *  ending, say). Videos from the active call are left alone. */
export function removeVideosFromRoom(roomKey: string): void {
  let changed = false;
  for (const [sid, video] of [...videos]) {
    if (video.roomKey !== roomKey) continue;
    videos.delete(sid);
    stallStoppers.get(sid)?.();
    stallStoppers.delete(sid);
    watchRequestedAt.delete(sid);
    changed = true;
  }
  if (changed) emit();
}

export function getRemoteVideos(): RemoteVideo[] {
  return [...videos.values()];
}

export function subscribeRemoteVideos(listener: (videos: RemoteVideo[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The remote video of `ownerId` with the given source, if we are receiving
 *  it. Replaces the App's `pickRemoteVideo`, which matched by `msid` and got
 *  it wrong when the msid was stale (RC-03). */
export function findRemoteVideo(ownerId: string, source: RemoteVideoSource): RemoteVideo | undefined {
  for (const video of videos.values()) {
    if (video.ownerId === ownerId && video.source === source) return video;
  }
  return undefined;
}

/**
 * A subscribed video with no frames for >8 s is the RC-12 symptom (or a network
 * problem). Emitting `watch.stalled` lets us prove it in production
 * (06-observability.md §3). Uses `getReceiverStats().framesDecoded` when
 * available, and `mediaStreamTrack.muted` as a parallel proxy.
 */
function monitorStall(entry: RemoteVideo): () => void {
  let lastFrames = -1;
  const timer = setInterval(async () => {
    let frames: number | undefined;
    try {
      const stats = await entry.track.getReceiverStats?.();
      frames = (stats as { framesDecoded?: number } | undefined)?.framesDecoded;
    } catch {
      frames = undefined;
    }
    const framesStalled = typeof frames === "number" && frames === lastFrames;
    const mutedStalled = entry.track.mediaStreamTrack.muted;
    if (framesStalled || mutedStalled) {
      logClient("watch.stalled", {
        owner: entry.ownerId,
        track_sid: entry.trackSid,
        seconds_without_frames: 8,
      });
      maybeAutoSend("watch_stalled");
    }
    if (typeof frames === "number") lastFrames = frames;
  }, 8000);
  return () => clearInterval(timer);
}
