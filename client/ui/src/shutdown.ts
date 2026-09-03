/**
 * Ordered teardown before the process dies. Without this the server only finds
 * out via the heartbeat (up to 60 s) and everyone sees a ghost in the meantime
 * (tupi-v2-refactor/02-root-cause-analysis.md RC-18). Also a machine-wake
 * detector that forces a state reconcile.
 */
import { send, subscribe } from "./ipc";
import * as callSession from "./callSession";
import * as spectator from "./spectator";
import * as screenPublisher from "./screenPublisher";
import * as voiceStore from "./voiceStore";
import { logClient } from "./clientLog";

let installed = false;

export function installShutdownHandler() {
  if (installed) return;
  installed = true;

  subscribe(event => {
    if (event.op !== "app.shutdown.request") return;
    const reason = typeof event.data?.reason === "string" ? event.data.reason : "closing";
    void teardownEverything(reason).finally(() => {
      send("app.shutdown.ready", {});
    });
  });

  installWakeDetector();
}

async function teardownEverything(reason: string): Promise<void> {
  logClient("app.shutdown", { reason });
  // Screen first: its native capture runs on its own thread and is the slowest
  // to release. Then the spectator room, then the call.
  await Promise.allSettled([screenPublisher.stop(), spectator.stop()]);
  await callSession.leave().catch(() => {});
}

/**
 * Suspend detection with no system API: a 5 s timer that notices a big jump in
 * the wall clock. On wake we force a reconcile instead of waiting for the
 * heartbeat timeout.
 */
function installWakeDetector() {
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick;
    lastTick = now;
    if (drift > 30_000) {
      logClient("app.wake_detected", { drift_ms: drift });
      voiceStore.requestFullSnapshot("wake");
    }
  }, 5_000);
}
