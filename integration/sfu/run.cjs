/*
 * Local SFU integration runner (protocol v2 — SPEC-017).
 *
 * The only test that drives a real LiveKit, a real tupi-server and a real
 * WebSocket at once. It has no framework and no package of its own: it borrows
 * the already pinned `ws` and `@livekit/rtc-node` from music-bot so this test
 * cannot drift onto a second dependency tree.
 *
 * It is a second, independent reference implementation of the v2 client state
 * machine (`05-protocol-spec.md` §2): it applies `voice.room.state` snapshots
 * and `voice.room.delta` deltas with the normative ordering, and counts every
 * version gap. A gap in a healthy scenario fails the run (INV-C2).
 *
 * Not in CI: needs a real LiveKit, real accounts and a couple of minutes. The
 * CI coverage of the same behaviour is `server/tests/voice_test.rs` (SPEC-006).
 */
const assert = require("assert/strict");
const { createRequire } = require("module");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const musicRequire = createRequire(path.join(root, "music-bot", "package.json"));
const WebSocket = musicRequire("ws");
const {
  Room,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
} = musicRequire("@livekit/rtc-node");

const apiUrl = (process.env.SFU_TEST_API_URL || "http://127.0.0.1:8090/api").replace(/\/$/, "");
const wsUrl = process.env.SFU_TEST_WS_URL || apiUrl.replace(/^http/, "ws").replace(/\/api$/, "/ws");
const protocolVersion = Number(process.env.SFU_TEST_PROTOCOL_VERSION || 2);
const interactive = process.env.SFU_TEST_INTERACTIVE === "1";
const timeoutMs = Number(process.env.SFU_TEST_TIMEOUT_MS || 20_000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const label = text => console.log(`\n[SFU] ${text}`);

// §6 item 4: a harness that wipes production voice state would be a disaster.
// Refuse anything that is not clearly a local target.
(function refuseRemoteTarget() {
  if (process.env.SFU_TEST_ALLOW_REMOTE === "1") return;
  let host;
  try { host = new URL(apiUrl).hostname; } catch { host = ""; }
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  assert.ok(
    local,
    `SFU_TEST_API_URL aponta para "${host}", que não é local. Rode contra um ` +
    `servidor local, ou defina SFU_TEST_ALLOW_REMOTE=1 se souber o que está fazendo.`,
  );
})();

function accountsFromEnv() {
  let accounts;
  try {
    accounts = JSON.parse(process.env.SFU_TEST_ACCOUNTS_JSON || "[]");
  } catch (error) {
    throw new Error(`SFU_TEST_ACCOUNTS_JSON inválido: ${error.message}`);
  }
  assert.ok(Array.isArray(accounts) && accounts.length >= 2, "Defina SFU_TEST_ACCOUNTS_JSON com ao menos duas contas.");
  for (const account of accounts) assert.ok(account.username && account.password, "Cada conta precisa de username e password.");
  return accounts;
}

async function api(pathname, { method = "GET", token, body } = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl}${pathname}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error(
      `Não consegui falar com o servidor em ${apiUrl} (${error.message}). ` +
      `O tupi-server está de pé? Rode "dev.cmd -NoClients" primeiro.`,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function login(credentials) {
  const result = await api("/auth/login", { method: "POST", body: credentials });
  return { ...credentials, token: result.token, id: result.user.id, name: result.user.display_name };
}

// ---------------------------------------------------------------------------
// Client-side state mirror. Deliberately a *second* implementation of the
// normative apply rule from 05-protocol-spec.md §2.2, independent of the React
// client's voiceStore. If both agree with the server the spec is unambiguous.
// ---------------------------------------------------------------------------

/** Applies a delta in the normative order: participants_removed, tracks_removed,
 *  participants_added, participants_updated, tracks_added. */
function applyDelta(local, delta) {
  const removedP = new Set(delta.participants_removed || []);
  local.participants = local.participants.filter(p => !removedP.has(p.user_id));

  const removedT = new Set(delta.tracks_removed || []);
  local.tracks = local.tracks.filter(t => !removedT.has(t.track_sid));

  for (const p of delta.participants_added || []) {
    if (!local.participants.some(x => x.user_id === p.user_id)) local.participants.push(p);
  }
  for (const p of delta.participants_updated || []) {
    const i = local.participants.findIndex(x => x.user_id === p.user_id);
    if (i >= 0) local.participants[i] = p; else local.participants.push(p);
  }
  for (const t of delta.tracks_added || []) {
    const i = local.tracks.findIndex(x => x.track_sid === t.track_sid);
    if (i >= 0) local.tracks[i] = t; else local.tracks.push(t);
  }
  local.version = delta.version;
}

class ControlClient {
  constructor(account, options = {}) {
    this.account = account;
    this.protocolVersion = options.protocolVersion ?? protocolVersion;
    this.negotiated = 1;
    this.features = new Set();
    this.ws = null;
    this.events = [];
    this.waiters = [];
    this.rooms = new Map();   // channel_id -> { version, participants, tracks }
    this.gaps = [];           // real version gaps — must stay empty in healthy runs
    this.resyncs = 0;         // "no local state yet" snapshots — informational
    this.errors = [];         // `error` ops received
  }

  async connect() {
    const socket = this.ws = new WebSocket(wsUrl);
    socket.on("message", raw => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      this.events.push(event);
      if (event.op === "error") this.errors.push(event.data);
      this.handleVoiceMessage(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.op === event.op && (!waiter.match || waiter.match(event.data))) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event.data);
        }
      }
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const hello = { token: this.account.token };
    // A v1 client is simulated by omitting protocol_version entirely (E-07).
    if (this.protocolVersion >= 2) {
      hello.protocol_version = this.protocolVersion;
      hello.client_version = "integration-harness";
      hello.client_platform = "test";
    }
    this.send("auth.hello", hello);
    const auth = await this.waitFor("auth.ok");
    assert.equal(auth.user_id, this.account.id, "WS autenticou como outro usuário");
    this.negotiated = auth.protocol_version ?? 1;
    this.features = new Set(auth.features ?? []);
    return this;
  }

  handleVoiceMessage(event) {
    if (event.op === "voice.room.state") {
      this.rooms.clear();
      for (const room of event.data.rooms ?? []) {
        this.rooms.set(room.channel_id, {
          version: room.version,
          participants: room.participants ?? [],
          tracks: room.tracks ?? [],
        });
      }
      return;
    }
    if (event.op === "voice.room.delta") {
      const d = event.data;
      const local = this.rooms.get(d.channel_id);
      if (!local) {
        // Normative rule: no local state for C -> ignore D and ask for a
        // snapshot. Expected on the first delta after joining a fresh channel,
        // so it is a resync, not an INV-C2 gap.
        this.resyncs++;
        if (this.negotiated >= 2) { try { this.send("voice.room.request", { channel_ids: [d.channel_id] }); } catch { /* socket gone */ } }
        return;
      }
      if (d.previous_version === local.version) {
        applyDelta(local, d);
        return;
      }
      if (d.version <= local.version) return;   // duplicate redelivery
      // A real gap: we had state and the chain broke. This is the INV-C2 check.
      this.gaps.push({ local: local.version, previous: d.previous_version, next: d.version, channel_id: d.channel_id, reason: d.reason });
      try { this.send("voice.room.request", { channel_ids: [d.channel_id] }); } catch { /* socket gone */ }
      return;
    }
    // v1 dialect (this client negotiated protocol 1, or the server has no
    // voice.room.v2 feature). Fold into the same {version, participants, tracks}
    // shape so scenario assertions do not care which dialect ran.
    if (event.op === "voice.rooms") {
      this.rooms.clear();
      for (const room of event.data.rooms ?? []) this.rooms.set(room.channel_id, fromV1Roster(room));
      return;
    }
    if (event.op === "voice.roster") {
      this.rooms.set(event.data.channel_id, fromV1Roster(event.data));
    }
  }

  send(op, data = {}) {
    assert.equal(this.ws?.readyState, WebSocket.OPEN, `WebSocket fechado ao enviar ${op}`);
    this.ws.send(JSON.stringify({ v: 1, op, data }));
  }

  /** v2 snapshot request, or its v1 equivalent, matching the negotiated dialect. */
  requestRooms(channelIds = []) {
    if (this.negotiated >= 2) this.send("voice.room.request", { channel_ids: channelIds });
    else this.send("voice.rooms.request", {});
  }

  presence(channelId, state, participantSid) {
    if (this.negotiated >= 2 && this.features.has("voice.hints")) {
      this.send("voice.presence.hint", { channel_id: channelId, state, participant_sid: participantSid ?? null });
    } else {
      this.send(state === "joining" ? "voice.presence.enter" : "voice.presence.leave", { channel_id: channelId });
    }
  }

  waitFor(op, match, ms = timeoutMs) {
    const existing = this.events.find(event => event.op === op && (!match || match(event.data)));
    if (existing) return Promise.resolve(existing.data);
    return new Promise((resolve, reject) => {
      const waiter = { op, match, resolve, timer: setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timeout esperando ${op}`));
      }, ms) };
      this.waiters.push(waiter);
    });
  }

  terminate() { this.ws?.terminate(); this.ws = null; }

  async close() {
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) return;
    await new Promise(resolve => { this.ws.once("close", resolve); this.ws.close(); setTimeout(resolve, 500); });
    this.ws = null;
  }
}

function fromV1Roster(room) {
  return {
    version: 0,
    participants: (room.participants || []).map(p => ({
      user_id: p.user_id,
      muted: !!p.muted,
      deafened: !!p.deafened,
      is_bot: !!p.is_bot,
      provisional: false,
    })),
    // v1 `streams` carry a stream_id, not a track_sid. Map kind -> source so the
    // "screen appeared / disappeared" checks still work; the SID-exact
    // assertions are guarded to v2 in scenarioScreenRepublish.
    tracks: (room.streams || []).map(s => ({
      track_sid: s.stream_id,
      owner: s.owner,
      source: s.kind === "screen" ? "screen_share" : s.kind === "camera" ? "camera" : s.kind,
      muted: false,
    })),
  };
}

// ---------------------------------------------------------------------------
// LiveKit media plumbing
// ---------------------------------------------------------------------------

async function mintAndConnectMedia(actor, channelId) {
  const credentials = await api("/livekit/token", { method: "POST", token: actor.account.token, body: { channel_id: channelId } });
  const room = new Room();
  try {
    await room.connect(credentials.url, credentials.token);
  } catch (error) {
    throw new Error(
      `Falha ao conectar no LiveKit (${credentials.url}): ${error.message}. ` +
      `O LiveKit local está de pé em 127.0.0.1:7880?`,
    );
  }
  actor.room = room;
}

async function disconnectMedia(actor) {
  if (!actor.room) return;
  try { await actor.room.disconnect(); } catch { /* best effort */ }
  actor.room = null;
}

/**
 * §4.3: publish a synthetic screen track. The video API of @livekit/rtc-node
 * 0.13.34 needs a raw frame buffer of the right VideoBufferType per capture,
 * which is fiddly and off the point — this harness tests the control plane, not
 * the encoder. The determined fallback is a screen-share *audio* track, which
 * goes through the identical publish / SID / roster path on the server.
 */
async function publishFakeScreen(actor) {
  const source = new AudioSource(48_000, 2);
  const track = LocalAudioTrack.createAudioTrack("screen-audio", source);
  const publication = await actor.room.localParticipant.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE_AUDIO }),
  );
  // A couple of silent 10 ms frames so the SFU keeps the track alive.
  const frame = new AudioFrame(new Int16Array(480 * 2), 48_000, 2, 480);
  for (let i = 0; i < 3; i++) { await source.captureFrame(frame); }
  return { track, publication, sid: publication.sid, source: "screen_share_audio" };
}

async function unpublishFakeScreen(actor, handle) {
  try { await actor.room.localParticipant.unpublishTrack(handle.sid, true); }
  catch { /* the disconnect path may have taken it already */ }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function eventually(description, predicate, ms = timeoutMs) {
  const end = Date.now() + ms;
  let lastError;
  while (Date.now() < end) {
    try { if (await predicate()) return; }
    catch (error) { lastError = error; }
    await sleep(120);
  }
  throw new Error(`Timeout: ${description}${lastError ? ` (${lastError.message})` : ""}`);
}

function roomOf(control, channelId) { return control.rooms.get(channelId); }

function participantsIn(control, channelId) {
  return new Set((roomOf(control, channelId)?.participants ?? []).map(p => p.user_id));
}

function sees(control, channelId, userId, state) {
  const p = (roomOf(control, channelId)?.participants ?? []).find(x => x.user_id === userId);
  if (!p) return false;
  if (!state) return true;
  return Object.entries(state).every(([k, v]) => p[k] === v);
}

async function voiceChannels(account, wanted = 1) {
  const structure = await api("/channels", { token: account.token });
  const discovered = [
    ...(structure.uncategorized_channels || []),
    ...(structure.categories || []).flatMap(category => category.channels || []),
  ].filter(item => item.kind === "voice").map(c => c.id);

  const pinned = process.env.SFU_TEST_CHANNEL_ID;
  const ordered = pinned ? [pinned, ...discovered.filter(id => id !== pinned)] : discovered;
  assert.ok(ordered.length >= 1, "Nenhum canal de voz encontrado para as contas de teste.");
  return ordered.slice(0, wanted);
}

/** Bring an actor fully into a channel: control WS + LiveKit media + presence. */
async function joinChannel(actor, channelId, options = {}) {
  actor.control = await new ControlClient(actor.account, options).connect();
  await mintAndConnectMedia(actor, channelId);
  actor.control.presence(channelId, "joining", actor.room?.localParticipant?.sid);
}

// ---------------------------------------------------------------------------
// scenarios (07-test-plan.md §4)
// ---------------------------------------------------------------------------

async function scenarioInitialPresence(actors, channelId) {
  label("E-01: três contas entram em sequência");
  for (const actor of actors) {
    await joinChannel(actor, channelId, { protocolVersion });
    actor.control.requestRooms([channelId]);
    await actor.control.waitFor(
      actor.control.negotiated >= 2 ? "voice.room.state" : "voice.rooms",
    );
  }
  const ids = actors.map(a => a.account.id);
  for (const actor of actors) {
    await eventually(`${actor.account.name} vê todos no estado de voz`, () =>
      ids.every(id => sees(actor.control, channelId, id)));
  }
  await eventually("cada Room LiveKit enxerga os outros participantes", () =>
    actors.every(a => a.room.remoteParticipants.size >= actors.length - 1));
  console.log("[SFU]   ok: todos convergiram para o mesmo conjunto");
}

/**
 * E-02: dropping the WebSocket must NOT remove anyone from voice.
 *
 * Before v2 the server evicted the participant a few seconds after the socket
 * died even though media kept flowing (the old handler.rs disconnect path). It
 * was the cause of "everyone vanished after the deploy" (RC-05 / symptom 1).
 * This scenario is the one that changes sign: it now asserts the participant
 * *stays*, so it fails if INV-A3 is reverted.
 */
async function scenarioAbruptWsDrop(actors, channelId) {
  label("E-02: queda abrupta do WebSocket com mídia viva (leva ~15 s por design)");
  const [observer, subject] = actors;
  assert.ok(subject.room, "o sujeito precisa estar com a mídia conectada");

  subject.control.terminate();               // no Close frame
  await sleep(15_000);                        // past the 8 s presence grace, plus slack

  assert.ok(roomOf(observer.control, channelId), "o canal sumiu do estado do observador");
  assert.ok(
    sees(observer.control, channelId, subject.account.id),
    "INV-A3 violado: a queda do WebSocket removeu alguém que continua no LiveKit",
  );

  // Reconnecting must not duplicate the row.
  subject.control = await new ControlClient(subject.account, { protocolVersion }).connect();
  subject.control.requestRooms([channelId]);
  await subject.control.waitFor(subject.control.negotiated >= 2 ? "voice.room.state" : "voice.rooms");
  const occurrences = (roomOf(subject.control, channelId)?.participants ?? [])
    .filter(p => p.user_id === subject.account.id).length;
  assert.equal(occurrences, 1, "participante duplicado após reconexão");
  subject.control.presence(channelId, "joining", subject.room?.localParticipant?.sid);
  console.log("[SFU]   ok: ninguém sumiu, e a reconexão não duplicou");
}

/**
 * E-03: the subject drops its LiveKit media but keeps the WebSocket. The
 * server learns from the `participant_left` webhook (or the reconcile within
 * 20 s) and the others stop seeing the subject.
 */
async function scenarioMediaDropWithoutWs(actors, channelId) {
  label("E-03: mídia do LiveKit cai sem aviso ao WS");
  const [observer, subject] = actors;
  await disconnectMedia(subject);
  await eventually("o observador deixa de ver o sujeito em até 20 s", () =>
    !sees(observer.control, channelId, subject.account.id), 22_000);

  // Put the subject back for the scenarios that follow.
  await mintAndConnectMedia(subject, channelId);
  subject.control.presence(channelId, "joining", subject.room?.localParticipant?.sid);
  await eventually("o sujeito volta ao roster", () =>
    sees(observer.control, channelId, subject.account.id));
  console.log("[SFU]   ok: a queda de mídia removeu o sujeito, e ele voltou");
}

/**
 * E-04: publish, unpublish and republish the screen five times. Every cycle
 * must end with exactly one screen track carrying the current SID. Fails if
 * SID addressing is reverted.
 */
async function scenarioScreenRepublish(actors, channelId) {
  label("E-04: republicação de tela (5 ciclos)");
  const [observer, sharer] = actors;
  const v2 = observer.control.negotiated >= 2;

  for (let cycle = 1; cycle <= 5; cycle++) {
    const handle = await publishFakeScreen(sharer);
    if (v2 && sharer.control.features.has("voice.hints")) {
      sharer.control.send("voice.track.hint", {
        channel_id: channelId, track_sid: handle.sid, source: handle.source, state: "published",
      });
    }
    await eventually(`ciclo ${cycle}: observador vê uma tela do sharer`, () => {
      const screens = (roomOf(observer.control, channelId)?.tracks ?? []).filter(
        t => t.owner === sharer.account.id && (t.source === "screen_share" || t.source === "screen_share_audio"));
      if (v2) return screens.length === 1 && screens[0].track_sid === handle.sid;
      return screens.length >= 1;
    });

    await unpublishFakeScreen(sharer, handle);
    if (v2 && sharer.control.features.has("voice.hints")) {
      sharer.control.send("voice.track.hint", {
        channel_id: channelId, track_sid: handle.sid, source: handle.source, state: "unpublished",
      });
    }
    await eventually(`ciclo ${cycle}: a tela some`, () =>
      !(roomOf(observer.control, channelId)?.tracks ?? []).some(
        t => t.owner === sharer.account.id && (t.source === "screen_share" || t.source === "screen_share_audio")));
  }
  console.log("[SFU]   ok: 5 ciclos, sempre uma única track com o SID atual");
}

/**
 * E-05: restart the tupi-server by hand when the runner asks. Only runs with
 * SFU_TEST_INTERACTIVE=1 — the runner cannot restart a process it did not
 * start.
 */
async function scenarioServerRestart(actors, channelId) {
  if (!interactive) {
    label("E-05: restart do servidor — pulado (defina SFU_TEST_INTERACTIVE=1)");
    return;
  }
  label("E-05: REINICIE O tupi-server AGORA — aguardando 60 s");
  await sleep(60_000);

  for (const actor of actors) {
    actor.control = await new ControlClient(actor.account, { protocolVersion }).connect();
    actor.control.requestRooms([channelId]);
    await actor.control.waitFor(actor.control.negotiated >= 2 ? "voice.room.state" : "voice.rooms");
  }
  const ids = actors.map(a => a.account.id);
  for (const actor of actors) {
    await eventually(`${actor.account.name} reconverge após o boot (<=20 s)`, () =>
      ids.every(id => sees(actor.control, channelId, id)), 22_000);
  }
  console.log("[SFU]   ok: todos voltaram ao roster após o restart, sem reenviar nada");
}

/**
 * E-06: switch channels 10 times in 5 seconds. Final state must be consistent,
 * no `error` emitted, and the actor present in exactly one channel.
 */
async function scenarioRapidChannelSwitch(actors, channelId, secondChannelId) {
  if (!secondChannelId) {
    label("E-06: troca rápida de canal — pulado (só um canal de voz disponível)");
    return;
  }
  label("E-06: troca de canal 10x em 5 s");
  const mover = actors[0];
  const observer = actors[1];
  const errorsBefore = mover.control.errors.length;

  for (let i = 0; i < 10; i++) {
    const target = i % 2 === 0 ? secondChannelId : channelId;
    mover.control.presence(target, "joining");
    await sleep(500);
  }
  // Settle on the original channel with real media so later cleanup is sane.
  mover.control.presence(channelId, "joining", mover.room?.localParticipant?.sid);

  assert.equal(mover.control.errors.length, errorsBefore, "a troca rápida emitiu erro");
  mover.control.requestRooms([channelId, secondChannelId]);
  await mover.control.waitFor(mover.control.negotiated >= 2 ? "voice.room.state" : "voice.rooms");
  await eventually("o mover aparece em exatamente um canal", () => {
    const here = participantsIn(mover.control, channelId).has(mover.account.id);
    const there = participantsIn(mover.control, secondChannelId).has(mover.account.id);
    return here !== there;   // exactly one
  });
  await eventually("o observador vê o mover de volta no canal original", () =>
    sees(observer.control, channelId, mover.account.id));
  console.log("[SFU]   ok: estado final consistente, sem erros, presença única");
}

/**
 * E-07: a simulated v1 client (no protocol_version in auth.hello) alongside two
 * v2 clients. All three must converge on the same participant set.
 */
async function scenarioMixedProtocolVersions(actors, channelId) {
  if (actors.length < 3) {
    label("E-07: versões mistas — pulado (exige três contas)");
    return;
  }
  label("E-07: um cliente v1 e dois v2 no mesmo canal");
  const [a, b, c] = actors;

  // Rebuild c's control as an explicit v1 client.
  await c.control?.close();
  c.control = await new ControlClient(c.account, { protocolVersion: 1 }).connect();
  assert.equal(c.control.negotiated, 1, "o cliente v1 negociou v2 sem querer");
  c.control.requestRooms([channelId]);
  await c.control.waitFor("voice.rooms");
  c.control.presence(channelId, "joining");

  const ids = actors.map(x => x.account.id);
  for (const actor of [a, b, c]) {
    await eventually(`${actor.account.name} (negociou v${actor.control.negotiated}) vê todos`, () =>
      ids.every(id => sees(actor.control, channelId, id)));
  }
  console.log("[SFU]   ok: v1 e v2 convergiram para o mesmo conjunto");
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const credentials = accountsFromEnv();
  const accounts = [];
  for (const entry of credentials) accounts.push(await login(entry));
  const channelIds = await voiceChannels(accounts[0], 2);
  const [channelId, secondChannelId] = channelIds;
  const actors = accounts.map(account => ({ account, control: null, room: null }));

  console.log(
    `[SFU] API ${apiUrl}; WS ${wsUrl}; protocolo alvo v${protocolVersion}; ` +
    `canal ${channelId}${secondChannelId ? ` (+${secondChannelId})` : ""}; ${actors.length} contas.`,
  );

  const ran = [];
  const step = async (name, fn) => { await fn(); ran.push(name); };

  try {
    await step("E-01", () => scenarioInitialPresence(actors, channelId));
    await step("E-02", () => scenarioAbruptWsDrop(actors, channelId));
    await step("E-03", () => scenarioMediaDropWithoutWs(actors, channelId));
    await step("E-04", () => scenarioScreenRepublish(actors, channelId));
    await step("E-05", () => scenarioServerRestart(actors, channelId));
    await step("E-06", () => scenarioRapidChannelSwitch(actors, channelId, secondChannelId));
    await step("E-07", () => scenarioMixedProtocolVersions(actors, channelId));
  } finally {
    await Promise.all(actors.map(async actor => {
      try {
        if (actor.control?.ws?.readyState === WebSocket.OPEN) actor.control.presence(channelId, "leaving");
      } catch { /* best effort */ }
      try { await disconnectMedia(actor); } catch { /* best effort */ }
      try { await actor.control?.close(); } catch { /* best effort */ }
    }));
  }

  const totalGaps = actors.reduce((sum, a) => sum + (a.control?.gaps.length ?? 0), 0);
  const totalResyncs = actors.reduce((sum, a) => sum + (a.control?.resyncs ?? 0), 0);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`
[SFU] Resumo
  cenários executados: ${ran.join(", ")}
  lacunas de versão detectadas: ${totalGaps}    (esperado: 0)
  ressyncs de snapshot (informativo): ${totalResyncs}
  tempo total: ${elapsed}s
`);
  if (totalGaps > 0) {
    for (const a of actors) for (const gap of a.control?.gaps ?? []) console.error("[SFU]   gap:", JSON.stringify(gap));
    console.error("[SFU] FAIL: houve lacuna de versão em cenário saudável (INV-C2)");
    process.exitCode = 1;
    return;
  }
  console.log("[SFU] PASS");
}

main().catch(error => {
  console.error(`\n[SFU] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
