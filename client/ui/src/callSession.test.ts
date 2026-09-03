import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeRoom } from "./testing/fakeRoom";

// callSession only needs three RoomEvent names and the DisconnectReason enum.
vi.mock("livekit-client", () => ({
  Room: class {},
  RoomEvent: {
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  },
  DisconnectReason: {
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    SERVER_SHUTDOWN: 3,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5,
    SIGNAL_CLOSE: 9,
  },
}));

import * as callSession from "./callSession";

const noopOptions = (over: Partial<callSession.JoinOptions> = {}): callSession.JoinOptions => ({
  credentials: async () => ({ url: "ws://x", token: "t" }),
  afterConnect: async () => {},
  onUnexpectedEnd: () => {},
  ...over,
});

afterEach(() => callSession.__resetForTest());

/** Installs a fresh FakeRoom as the factory and returns a getter for the
 *  most recently created one. */
function useFakeRooms() {
  const rooms: FakeRoom[] = [];
  callSession.__setRoomFactory(() => {
    const room = new FakeRoom();
    rooms.push(room);
    return room as unknown as import("livekit-client").Room;
  });
  return {
    rooms,
    last: () => rooms[rooms.length - 1],
  };
}

describe("callSession", () => {
  it("join_serializes_and_last_one_wins", async () => {
    const fake = useFakeRooms();
    const results = await Promise.allSettled([
      callSession.join("ch-1", noopOptions()),
      callSession.join("ch-2", noopOptions()),
      callSession.join("ch-3", noopOptions()),
      callSession.join("ch-4", noopOptions()),
      callSession.join("ch-5", noopOptions()),
    ]);

    // Only the last settled fulfilled; the earlier ones were superseded.
    expect(results[4].status).toBe("fulfilled");
    for (const r of results.slice(0, 4)) {
      expect(r.status).toBe("rejected");
      if (r.status === "rejected") expect((r.reason as Error).name).toBe("AbortError");
    }
    expect(callSession.snapshot().channelId).toBe("ch-5");
    expect(callSession.snapshot().state).toBe("connected");
    // Every superseded room was disconnected.
    for (const room of fake.rooms.slice(0, -1)) expect(room.disconnectCalls).toBeGreaterThan(0);
  });

  it("teardown_runs_disposers_in_reverse_order", async () => {
    useFakeRooms();
    const order: number[] = [];
    await callSession.join(
      "ch",
      noopOptions({
        afterConnect: async (_room, sessionId) => {
          callSession.registerResource(sessionId, () => void order.push(1));
          callSession.registerResource(sessionId, () => void order.push(2));
          callSession.registerResource(sessionId, () => void order.push(3));
        },
      }),
    );
    await callSession.leave();
    // 3, 2, 1 — then the Room disposer (registered first) last.
    expect(order).toEqual([3, 2, 1]);
  });

  it("disposer_error_does_not_stop_the_others", async () => {
    useFakeRooms();
    const ran: string[] = [];
    await callSession.join(
      "ch",
      noopOptions({
        afterConnect: async (_room, sessionId) => {
          callSession.registerResource(sessionId, () => void ran.push("a"));
          callSession.registerResource(sessionId, () => {
            throw new Error("boom");
          });
          callSession.registerResource(sessionId, () => void ran.push("c"));
        },
      }),
    );
    await expect(callSession.leave()).resolves.toBeUndefined();
    expect(ran).toEqual(["c", "a"]);
  });

  it("late_disconnect_event_is_ignored", async () => {
    const fake = useFakeRooms();
    const onUnexpectedEnd = vi.fn();
    await callSession.join("ch", noopOptions({ onUnexpectedEnd }));
    const room = fake.last();
    await callSession.leave();
    // A Disconnected event arriving after teardown must do nothing.
    room.emit("disconnected", 3 /* SERVER_SHUTDOWN */);
    await Promise.resolve();
    expect(onUnexpectedEnd).not.toHaveBeenCalled();
    expect(callSession.snapshot().state).toBe("idle");
  });

  it("leave_is_idempotent", async () => {
    useFakeRooms();
    await callSession.join("ch", noopOptions());
    await callSession.leave();
    await expect(callSession.leave()).resolves.toBeUndefined();
    expect(callSession.snapshot().channelId).toBeNull();
  });

  it("superseded_join_rejects_with_AbortError_and_does_not_surface (U-24)", async () => {
    useFakeRooms();
    const first = callSession.join("a", noopOptions());
    const second = callSession.join("b", noopOptions());
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBeUndefined();
  });

  it("teardown releases every registered resource (U-25)", async () => {
    useFakeRooms();
    const dispose = vi.fn();
    await callSession.join(
      "ch",
      noopOptions({
        afterConnect: async (_r, id) => {
          callSession.registerResource(id, dispose);
          callSession.registerResource(id, dispose);
        },
      }),
    );
    await callSession.leave();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("join failure after connect still tears down and resets channel (U-26)", async () => {
    const fake = useFakeRooms();
    await expect(
      callSession.join(
        "ch",
        noopOptions({
          afterConnect: async () => {
            throw new Error("microphone acquisition failed");
          },
        }),
      ),
    ).rejects.toThrow(/microphone/);
    expect(callSession.snapshot().channelId).toBeNull();
    expect(callSession.snapshot().state).toBe("idle");
    expect(fake.last().disconnectCalls).toBeGreaterThan(0);
  });

  it("client initiated disconnect during connect never surfaces (U-27)", async () => {
    const fake = useFakeRooms();
    callSession.__setRoomFactory(() => {
      const room = new FakeRoom();
      room.connectBehavior = "reject"; // throws "Client initiated disconnect"
      fake.rooms.push(room);
      return room as unknown as import("livekit-client").Room;
    });
    await expect(callSession.join("ch", noopOptions())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("CLIENT_INITIATED disconnect does not call onUnexpectedEnd", async () => {
    const fake = useFakeRooms();
    const onUnexpectedEnd = vi.fn();
    await callSession.join("ch", noopOptions({ onUnexpectedEnd }));
    fake.last().emit("disconnected", 1 /* CLIENT_INITIATED */);
    await Promise.resolve();
    expect(onUnexpectedEnd).not.toHaveBeenCalled();
  });

  it("SERVER_SHUTDOWN disconnect calls onUnexpectedEnd once with the reason", async () => {
    const fake = useFakeRooms();
    const onUnexpectedEnd = vi.fn();
    await callSession.join("ch", noopOptions({ onUnexpectedEnd }));
    fake.last().emit("disconnected", 3 /* SERVER_SHUTDOWN */);
    // The handler serializes a teardown then calls onUnexpectedEnd.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onUnexpectedEnd).toHaveBeenCalledTimes(1);
    expect(onUnexpectedEnd).toHaveBeenCalledWith("server_shutdown");
  });
});
