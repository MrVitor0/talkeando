/**
 * Sole owner of the local screen share.
 *
 * INV-D2: start and stop are serialized. A new capture never begins before the
 * previous one has fully ended, and every capture carries its own generation —
 * in-flight frames from an old capture are dropped (see nativeScreen.ts).
 *
 * INV-D1: an active share is torn down with the call session.
 * RC-03: the only identifier is the LiveKit `trackSid`, never a UUID we invent.
 * RC-15: unpublish collects the publications before touching the collection,
 *        and never awaits inside a loop over a live Map.
 */
import { Track } from "livekit-client";

import * as callSession from "./callSession";
import { startNativeScreen, stopNativeScreen } from "./nativeScreen";
import { send } from "./ipc";
import { hasFeature } from "./serverInfo";
import { logClient } from "./clientLog";

export type ShareState = "idle" | "starting" | "sharing" | "stopping";

export type ActiveShare = {
  /** Native-capture generation; increments on every start. */
  generation: number;
  sourceId: string;
  height: number;
  fps: number;
  withAudio: boolean;
  /** LiveKit publication SIDs — the source of truth for identity. */
  videoTrackSid: string | null;
  audioTrackSid: string | null;
  /** The local MediaStream, for the user's own preview. */
  stream: MediaStream;
};

type Internal =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "stopping" }
  | { state: "sharing"; share: ActiveShare };

let current: Internal = { state: "idle" };
let nextGeneration = 1;
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

function emit() {
  listeners.forEach(listener => listener());
}

export function state(): ShareState {
  return current.state;
}

export function active(): ActiveShare | null {
  return current.state === "sharing" ? current.share : null;
}

export function onChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: reset module state. */
export function __resetForTest() {
  current = { state: "idle" };
  nextGeneration = 1;
  queue = Promise.resolve();
  listeners.clear();
}

function supersededError(): Error {
  const error = new Error("screen share superseded");
  error.name = "AbortError";
  return error;
}

/** Emits the track hint in the connection's dialect (SPEC-005 / SPEC-007). */
function sendTrackHint(trackSid: string, source: "screen_share" | "screen_share_audio", published: boolean) {
  const channel = callSession.snapshot().channelId;
  if (!channel) return;
  if (hasFeature("voice.hints")) {
    send("voice.track.hint", { channel_id: channel, track_sid: trackSid, source, state: published ? "published" : "unpublished" });
  } else {
    send(published ? "voice.track.published" : "voice.track.unpublished", { channel_id: channel, source, track_sid: trackSid });
  }
}

export async function start(options: {
  sourceId: string;
  height: number;
  fps: number;
  withAudio: boolean;
}): Promise<ActiveShare> {
  return serialize(async () => {
    // 1. Never start over a live share (INV-D2).
    await stopInternal("restart");

    const room = callSession.activeRoom();
    if (!room) throw new Error("não há call ativa");
    const sessionId = callSession.snapshot().id;

    current = { state: "starting" };
    emit();

    // 2. Native capture with a fresh generation.
    const generation = nextGeneration++;
    const stream = startNativeScreen({
      generation,
      sourceId: options.sourceId,
      maxHeight: options.height,
      fps: options.fps,
      withAudio: options.withAudio,
    });
    logClient("screen.publish.started", {
      capture_generation: generation,
      source_id: options.sourceId,
      with_audio: options.withAudio,
    });

    try {
      // 3. Publish VIDEO first, AUDIO second. Teardown undoes it in reverse.
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("a captura não produziu vídeo");
      const videoPublication = await room.localParticipant.publishTrack(videoTrack, {
        source: Track.Source.ScreenShare,
        simulcast: true,
      });
      if (!callSession.isCurrent(sessionId)) throw supersededError();

      let audioTrackSid: string | null = null;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const audioPublication = await room.localParticipant.publishTrack(audioTrack, {
          source: Track.Source.ScreenShareAudio,
          simulcast: false,
        });
        audioTrackSid = audioPublication?.trackSid ?? null;
        if (!callSession.isCurrent(sessionId)) throw supersededError();
      }

      const share: ActiveShare = {
        generation,
        sourceId: options.sourceId,
        height: options.height,
        fps: options.fps,
        withAudio: !!audioTrack,
        videoTrackSid: videoPublication?.trackSid ?? null,
        audioTrackSid,
        stream,
      };
      current = { state: "sharing", share };

      // 4. Only now tell the server, with the REAL SIDs (RC-03).
      if (share.videoTrackSid) sendTrackHint(share.videoTrackSid, "screen_share", true);
      if (share.audioTrackSid) sendTrackHint(share.audioTrackSid, "screen_share_audio", true);

      // 5. The share dies with the session (INV-D1).
      callSession.registerResource(sessionId, () => stopInternal("session_teardown"));

      logClient("screen.publish.published", {
        capture_generation: generation,
        track_sid: share.videoTrackSid,
      });
      emit();
      return share;
    } catch (error) {
      // Partial failure: undo everything, including an already-published track.
      logClient("screen.publish.failed", {
        capture_generation: generation,
        reason: error instanceof Error ? error.message : String(error),
      });
      await stopInternal("publish_failed");
      throw error;
    }
  });
}

async function stopInternal(trigger: string): Promise<void> {
  if (current.state === "idle") return;
  const share = current.state === "sharing" ? current.share : null;
  current = { state: "stopping" };
  emit();

  const room = callSession.activeRoom();

  // 1. Collect BEFORE mutating (RC-15).
  const publications = room
    ? [...room.localParticipant.trackPublications.values()].filter(
        publication =>
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio,
      )
    : [];

  // 2. Audio first, video second — the reverse of publish order.
  publications.sort(
    (a, b) =>
      Number(b.source === Track.Source.ScreenShareAudio) -
      Number(a.source === Track.Source.ScreenShareAudio),
  );

  for (const publication of publications) {
    const sid = publication.trackSid;
    const source = publication.source === Track.Source.ScreenShareAudio ? "screen_share_audio" : "screen_share";
    try {
      if (publication.track && room) await room.localParticipant.unpublishTrack(publication.track, false);
    } catch (error) {
      logClient("screen.unpublish.failed", { track_sid: sid, reason: String(error) });
    }
    // Tell the server even if the unpublish threw: the webhook is authority and
    // an extra hint is harmless.
    sendTrackHint(sid, source, false);
  }

  // 3. Stop the native capture, then release the local tracks.
  await stopNativeScreen(share?.generation);
  share?.stream.getTracks().forEach(track => track.stop());

  current = { state: "idle" };
  logClient("screen.unpublish.completed", { capture_generation: share?.generation ?? null, trigger });
  emit();
}

export async function stop(): Promise<void> {
  return serialize(() => stopInternal("user_stop"));
}

/** Changes the native capture target without republishing: the canvas and its
 *  captureStream track are untouched, so the WebRTC sender does not renegotiate
 *  and the spectator's subscription is preserved. */
export async function switchSource(sourceId: string): Promise<void> {
  return serialize(async () => {
    if (current.state !== "sharing") {
      logClient("screen.switch_source.ignored", { reason: "not_sharing" });
      return;
    }
    const share = current.share;
    send("screen.capture.start", {
      source_id: sourceId,
      max_height: share.height,
      max_fps: share.fps,
      audio: share.withAudio,
      generation: share.generation,
    });
    current = { state: "sharing", share: { ...share, sourceId } };
    emit();
  });
}

/** Changes resolution / fps of the live capture. */
export function reconfigure(height: number, fps: number): void {
  if (current.state !== "sharing") return;
  const share = current.share;
  send("screen.capture.start", {
    source_id: share.sourceId,
    max_height: height,
    max_fps: fps,
    audio: share.withAudio,
    generation: share.generation,
  });
  current = { state: "sharing", share: { ...share, height, fps } };
  emit();
}
