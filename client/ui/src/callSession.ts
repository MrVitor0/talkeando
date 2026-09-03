/**
 * Sole owner of a voice session's lifecycle.
 *
 * INV-C3: every async operation carries the `id` of the session that started
 * it. A result that arrives after the session was superseded is discarded with
 * no side effect — no global state written by a stale callback.
 *
 * INV-D1: everything created is registered on `session.resources`, and
 * `teardown` is the only place that destroys.
 *
 * INV-C4: a teardown we asked for (user leave / channel switch) never surfaces
 * an error and never calls `onUnexpectedEnd`.
 */
import { Room, RoomEvent, DisconnectReason } from "livekit-client";

import { logClient } from "./clientLog";

export type CallState = "idle" | "connecting" | "connected" | "reconnecting" | "tearing_down";

export type SessionSnapshot = {
  id: number;
  state: CallState;
  channelId: string | null;
  /** Our LiveKit session SID; known only after connecting. */
  participantSid: string | null;
};

export type EndReason =
  | "server_shutdown"
  | "duplicate_identity"
  | "participant_removed"
  | "room_deleted"
  | "signal_close"
  | "unknown";

type Disposer = () => void | Promise<void>;
type TeardownTrigger = "user_left" | "superseded" | "join_failed" | "livekit_disconnected";

export type JoinOptions = {
  /** Fetches credentials; injected so tests need no IPC. */
  credentials: (channelId: string) => Promise<{ url: string; token: string }>;
  /** Runs after connect, inside the session guard: publish mic, start the
   *  speech monitor, etc. */
  afterConnect: (room: Room, sessionId: number) => Promise<void>;
  /** Called when the session ends for a reason we did NOT ask for. A
   *  user-requested teardown never calls this (INV-C4). */
  onUnexpectedEnd: (reason: EndReason) => void;
};

type Session = {
  id: number;
  channelId: string;
  room: Room;
  state: CallState;
  participantSid: string | null;
  /** Disposers, run in reverse order of registration. */
  resources: Disposer[];
};

let current: Session | null = null;
let nextId = 1;
/** Bumped synchronously by every `join` call. A queued join that is no longer
 *  the latest request aborts before doing any work — so five fast channel
 *  clicks connect only the last one, and the earlier four reject with
 *  `AbortError` (which the caller swallows). */
let latestRequest = 0;
/** Unobserved: guarantees join/leave never run concurrently. */
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<(snapshot: SessionSnapshot) => void>();

let roomFactory: () => Room = () => new Room({ adaptiveStream: true, dynacast: true });
/** Test hook only. */
export function __setRoomFactory(factory: () => Room) {
  roomFactory = factory;
}
/** Test hook only: resets module state between cases. */
export function __resetForTest() {
  current = null;
  nextId = 1;
  latestRequest = 0;
  queue = Promise.resolve();
  listeners.clear();
  roomFactory = () => new Room({ adaptiveStream: true, dynacast: true });
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation, operation);
  queue = next.then(() => undefined, () => undefined);
  return next;
}

function snapshotOf(session: Session | null): SessionSnapshot {
  return {
    id: session?.id ?? 0,
    state: session?.state ?? "idle",
    channelId: session?.channelId ?? null,
    participantSid: session?.participantSid ?? null,
  };
}

function emit() {
  const snap = snapshotOf(current);
  listeners.forEach(listener => listener(snap));
}

export function snapshot(): SessionSnapshot {
  return snapshotOf(current);
}

export function onStateChange(listener: (snapshot: SessionSnapshot) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function activeRoom(): Room | null {
  return current?.room ?? null;
}

export function isCurrent(sessionId: number): boolean {
  return current?.id === sessionId && sessionId !== 0;
}

export function registerResource(sessionId: number, dispose: Disposer): void {
  if (!isCurrent(sessionId)) {
    // The session that would own this is already gone — dispose right now so
    // nothing leaks.
    void Promise.resolve(dispose()).catch(() => {});
    return;
  }
  current!.resources.push(dispose);
}

function superseded(): Error {
  const error = new Error("Voice connection superseded by a newer request");
  error.name = "AbortError";
  return error;
}

/**
 * Turns the SDK's rejection into something the UI can classify. A connection
 * cancelled by us becomes an AbortError and NEVER a banner (INV-C4). The SDK
 * rejects with a "Client initiated disconnect" message when `disconnect()`
 * lands during `connect()`.
 */
function normalizeJoinError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/client initiated disconnect/i.test(message) || /abort connection attempt/i.test(message)) {
    return superseded();
  }
  return error instanceof Error ? error : new Error(message);
}

/** `null` = a disconnect we asked for; not an error (INV-C4). */
function mapDisconnectReason(reason?: DisconnectReason): EndReason | null {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return null;
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate_identity";
    case DisconnectReason.SERVER_SHUTDOWN:
      return "server_shutdown";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "participant_removed";
    case DisconnectReason.ROOM_DELETED:
      return "room_deleted";
    case DisconnectReason.SIGNAL_CLOSE:
      return "signal_close";
    default:
      return "unknown";
  }
}

function bindLifecycle(session: Session, options: JoinOptions) {
  const { room, id } = session;

  room.on(RoomEvent.Reconnecting, () => {
    if (!isCurrent(id)) return;
    session.state = "reconnecting";
    emit();
    logClient("livekit.reconnecting", { channel_id: session.channelId });
  });

  room.on(RoomEvent.Reconnected, () => {
    if (!isCurrent(id)) return;
    session.state = "connected";
    session.participantSid = room.localParticipant.sid ?? session.participantSid;
    emit();
    logClient("livekit.reconnected", { channel_id: session.channelId });
  });

  room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    if (!isCurrent(id)) return;
    const mapped = mapDisconnectReason(reason);
    logClient("livekit.disconnected", {
      channel_id: session.channelId,
      reason: mapped ?? "client_initiated",
    });
    if (mapped === null) {
      // We asked for this. Teardown is already running or about to.
      return;
    }
    void serialize(async () => {
      if (!isCurrent(id)) return;
      await teardownInternal("livekit_disconnected");
      options.onUnexpectedEnd(mapped);
    });
  });
}

async function teardownInternal(trigger: TeardownTrigger): Promise<void> {
  const session = current;
  if (!session) return;
  current = null; // nobody is "current" from here on
  session.state = "tearing_down";
  emit();

  // Reverse registration order (INV-D1). A failing disposer must not stop the
  // others.
  for (const dispose of [...session.resources].reverse()) {
    try {
      await dispose();
    } catch (error) {
      logClient("call.teardown.resource_failed", { trigger, reason: String(error) });
    }
  }
  session.resources.length = 0;
  logClient("call.teardown", {
    channel_id: session.channelId,
    session_id: session.id,
    trigger,
  });
  emit();
}

/**
 * Joins a channel. Always tears the previous session down completely first.
 * Rejects with an `AbortError` when this attempt was superseded by another —
 * the caller must swallow that silently.
 */
export async function join(channelId: string, options: JoinOptions): Promise<void> {
  const myRequest = ++latestRequest;
  return serialize(async () => {
    // A newer join was queued behind us while we waited our turn — do nothing.
    if (myRequest !== latestRequest) throw superseded();

    await teardownInternal("superseded");

    const id = nextId++;
    const room = roomFactory();
    const session: Session = {
      id,
      channelId,
      room,
      state: "connecting",
      participantSid: null,
      resources: [],
    };
    current = session;
    emit();
    logClient("call.join.requested", { channel_id: channelId, session_id: id });

    // The Room is the first resource registered, so it is the last destroyed —
    // after the tracks that depend on it.
    session.resources.push(async () => {
      room.removeAllListeners();
      await room.disconnect();
    });

    bindLifecycle(session, options);

    const startedAt = Date.now();
    try {
      const credential = await options.credentials(channelId);
      if (!isCurrent(id)) throw superseded();
      await room.connect(credential.url, credential.token);
      if (!isCurrent(id)) throw superseded();

      session.state = "connected";
      session.participantSid = room.localParticipant.sid ?? null;
      emit();
      logClient("call.join.connected", {
        channel_id: channelId,
        session_id: id,
        duration_ms: Date.now() - startedAt,
        participant_sid: session.participantSid,
      });

      await options.afterConnect(room, id);
      if (!isCurrent(id)) throw superseded();
    } catch (error) {
      const normalized = normalizeJoinError(error);
      // If we are no longer current, another `join` already tore this down.
      if (isCurrent(id)) {
        logClient("call.join.failed", {
          channel_id: channelId,
          session_id: id,
          stage: session.state,
          reason: normalized.name === "AbortError" ? "superseded" : normalized.message,
        });
        await teardownInternal("join_failed");
      }
      throw normalized;
    }
  });
}

/** Leaves the current call. Idempotent. */
export async function leave(): Promise<void> {
  // Supersede any join still queued behind us.
  latestRequest += 1;
  return serialize(() => teardownInternal("user_left"));
}
