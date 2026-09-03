/**
 * Spectator room: a separate LiveKit connection, used only to see one person's
 * screen in a channel I am NOT in.
 *
 * INV-D3: this room is NEVER the call room. `callSession` and `spectator` hold
 * independent references, and nothing publishes here — the token comes with
 * `canPublish: false` and `hidden: true` (server/src/livekit.rs), so the
 * spectator never lands in any roster (INV-B3).
 */
import { Room, RoomEvent, Track } from "livekit-client";
import type { RemoteVideoTrack } from "livekit-client";

import { mintCredentials } from "./rtc";
import * as remoteMedia from "./remoteMedia";
import { logClient } from "./clientLog";

type SpectatorSession = {
  id: number;
  channelId: string;
  ownerId: string;
  room: Room;
};

let current: SpectatorSession | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(() => undefined, () => undefined);
  return next;
}
function isCurrent(id: number): boolean {
  return current?.id === id;
}
function roomKeyOf(id: number): string {
  return `spectator:${id}`;
}

/** Test hook: reset module state. */
export function __resetForTest() {
  current = null;
  nextId = 1;
  queue = Promise.resolve();
}
/** Test hook: swap the Room constructor. */
let roomFactory: () => Room = () => new Room({ adaptiveStream: true, dynacast: true });
export function __setRoomFactory(factory: () => Room) {
  roomFactory = factory;
}

export function watching(): { channelId: string; ownerId: string } | null {
  return current ? { channelId: current.channelId, ownerId: current.ownerId } : null;
}

/** Peeks `ownerId`'s screen in `channelId`. One session at a time. */
export async function watch(channelId: string, ownerId: string): Promise<void> {
  return serialize(async () => {
    // Already peeking this same person: nothing to do. Without this, moving the
    // mouse within one row would reconnect the room (RC-17).
    if (current && current.channelId === channelId && current.ownerId === ownerId) return;

    await stopInternal();

    const id = nextId++;
    let credential: { url: string; token: string };
    try {
      credential = await mintCredentials(channelId, "spectator");
    } catch (error) {
      logClient("spectate.credentials_failed", { channel_id: channelId, reason: String(error) });
      return;
    }
    if (!isCurrent(id) && current !== null) return;

    const room = roomFactory();
    const session: SpectatorSession = { id, channelId, ownerId, room };
    current = session;

    bindSpectatorRoom(session);
    try {
      await room.connect(credential.url, credential.token);
    } catch (error) {
      if (isCurrent(id)) current = null;
      logClient("spectate.connect_failed", { channel_id: channelId, reason: String(error) });
      void room.disconnect().catch(() => {});
      return;
    }
    if (!isCurrent(id)) {
      await room.disconnect();
      return;
    }

    subscribeScreenOf(session, ownerId);
    logClient("spectate.started", { channel_id: channelId, owner: ownerId });
  });
}

/** Ends the spectator session. Idempotent. */
export async function stop(): Promise<void> {
  return serialize(stopInternal);
}

async function stopInternal(): Promise<void> {
  const session = current;
  if (!session) return;
  current = null;
  try {
    session.room.removeAllListeners();
    remoteMedia.removeVideosFromRoom(roomKeyOf(session.id));
    await session.room.disconnect();
  } catch (error) {
    logClient("spectate.stop_failed", { reason: String(error) });
  }
  logClient("spectate.stopped", { channel_id: session.channelId, owner: session.ownerId });
}

function bindSpectatorRoom(session: SpectatorSession) {
  const { room, id } = session;
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (!isCurrent(id) || track.kind !== Track.Kind.Video) return;
    if (participant.identity !== session.ownerId) return;
    remoteMedia.addRemoteVideo({
      ownerId: participant.identity,
      trackSid: publication.trackSid,
      source: publication.source === Track.Source.Camera ? "camera" : "screen_share",
      track: track as RemoteVideoTrack,
      roomKey: roomKeyOf(id),
    });
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
    if (track.kind !== Track.Kind.Video) return;
    remoteMedia.removeRemoteVideo(publication.trackSid);
  });
  room.on(RoomEvent.Disconnected, () => {
    if (!isCurrent(id)) return;
    current = null;
    remoteMedia.removeVideosFromRoom(roomKeyOf(id));
  });
}

/** Subscribes to the target's screen; covers the publication not having
 *  arrived yet. */
function subscribeScreenOf(session: SpectatorSession, ownerId: string) {
  const apply = () => {
    const participant = session.room.remoteParticipants.get(ownerId);
    if (!participant) return;
    for (const publication of participant.trackPublications.values()) {
      if (publication.source === Track.Source.ScreenShare) void publication.setSubscribed(true);
    }
  };
  session.room.on(RoomEvent.TrackPublished, (_publication, participant) => {
    if (participant.identity === ownerId) apply();
  });
  session.room.on(RoomEvent.ParticipantConnected, participant => {
    if (participant.identity === ownerId) apply();
  });
  apply();
}
