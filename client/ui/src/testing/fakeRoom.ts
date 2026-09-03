/** A minimal `Room` double for `callSession` tests — no WebRTC, no library. */
import { vi } from "vitest";

type Handler = (...args: unknown[]) => void;

export class FakeRoom {
  state: "new" | "connecting" | "connected" | "disconnected" = "new";
  localParticipant = {
    sid: "PA_fake",
    identity: "user_fake",
    audioTrackPublications: new Map(),
    videoTrackPublications: new Map(),
    trackPublications: new Map(),
    publishTrack: vi.fn(),
    unpublishTrack: vi.fn(),
  };
  remoteParticipants = new Map();

  /** The test controls when (and whether) `connect` resolves. */
  connectBehavior: "resolve" | "reject" | "hang" = "resolve";
  disconnectCalls = 0;
  removeAllListenersCalls = 0;

  private listeners = new Map<string, Set<Handler>>();
  private hangResolve: (() => void) | null = null;

  on(event: string, handler: Handler): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return this;
  }

  removeAllListeners(): void {
    this.removeAllListenersCalls += 1;
    this.listeners.clear();
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }

  async connect(_url: string, _token: string): Promise<void> {
    this.state = "connecting";
    if (this.connectBehavior === "reject") {
      throw new Error("Client initiated disconnect");
    }
    if (this.connectBehavior === "hang") {
      await new Promise<void>(resolve => {
        this.hangResolve = resolve;
      });
      return;
    }
    this.state = "connected";
  }

  /** Lets a `connectBehavior: "hang"` connect finally resolve. */
  releaseHang(): void {
    this.hangResolve?.();
    this.hangResolve = null;
    this.state = "connected";
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.state = "disconnected";
  }

  async startAudio(): Promise<void> {}
}
