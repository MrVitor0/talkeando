/*
 * Local SFU integration runner. It intentionally has no test framework or
 * package of its own: use the already pinned ws/LiveKit SDK from music-bot so
 * the local test cannot drift to a second dependency tree.
 */
const assert = require("assert/strict");
const { createRequire } = require("module");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const musicRequire = createRequire(path.join(root, "music-bot", "package.json"));
const WebSocket = musicRequire("ws");
const { Room } = musicRequire("@livekit/rtc-node");

const apiUrl = (process.env.SFU_TEST_API_URL || "http://127.0.0.1:8090/api").replace(/\/$/, "");
const wsUrl = process.env.SFU_TEST_WS_URL || apiUrl.replace(/^http/, "ws").replace(/\/api$/, "/ws");
const timeoutMs = Number(process.env.SFU_TEST_TIMEOUT_MS || 15_000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const label = text => console.log(`\n[SFU] ${text}`);

function accountsFromEnv() {
  try {
    const accounts = JSON.parse(process.env.SFU_TEST_ACCOUNTS_JSON || "[]");
    assert.ok(Array.isArray(accounts) && accounts.length >= 2, "Defina SFU_TEST_ACCOUNTS_JSON com ao menos duas contas.");
    for (const account of accounts) assert.ok(account.username && account.password, "Cada conta precisa de username e password.");
    return accounts;
  } catch (error) {
    throw new Error(`SFU_TEST_ACCOUNTS_JSON inválido: ${error.message}`);
  }
}

async function api(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function login(credentials) {
  const result = await api("/auth/login", { method: "POST", body: credentials });
  return { ...credentials, token: result.token, id: result.user.id, name: result.user.display_name };
}

class ControlClient {
  constructor(account) { this.account = account; this.ws = null; this.events = []; this.waiters = []; }

  async connect() {
    const socket = this.ws = new WebSocket(wsUrl);
    socket.on("message", raw => {
      let event;
      try { event = JSON.parse(String(raw)); } catch { return; }
      this.events.push(event);
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
    this.send("auth.hello", { token: this.account.token });
    const auth = await this.waitFor("auth.ok");
    assert.equal(auth.user_id, this.account.id, "WS autenticou como outro usuário");
    return this;
  }

  send(op, data = {}) {
    assert.equal(this.ws?.readyState, WebSocket.OPEN, `WebSocket fechado ao enviar ${op}`);
    this.ws.send(JSON.stringify({ v: 1, op, data }));
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

function rosterHas(data, channelId, ids, state = {}) {
  if (data.channel_id !== channelId) return false;
  return ids.every(id => {
    const participant = (data.participants || []).find(item => item.user_id === id);
    if (!participant) return false;
    return Object.entries(state).every(([key, value]) => participant[key] === value);
  });
}

function roomHas(data, channelId, ids) {
  return (data.rooms || []).some(room => room.channel_id === channelId && ids.every(id => room.participants?.some(p => p.user_id === id)));
}

async function eventually(description, predicate, ms = timeoutMs) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(80);
  }
  throw new Error(`Timeout: ${description}`);
}

async function mintAndConnectMedia(actor, channelId) {
  const credentials = await api("/livekit/token", { method: "POST", token: actor.account.token, body: { channel_id: channelId } });
  const room = new Room();
  await room.connect(credentials.url, credentials.token);
  actor.room = room;
}

async function disconnectMedia(actor) {
  if (!actor.room) return;
  await actor.room.disconnect();
  actor.room = null;
}

async function leave(actor, channelId) {
  if (actor.control?.ws?.readyState === WebSocket.OPEN) actor.control.send("voice.presence.leave", { channel_id: channelId });
  await disconnectMedia(actor);
}

async function voiceChannel(account) {
  if (process.env.SFU_TEST_CHANNEL_ID) return process.env.SFU_TEST_CHANNEL_ID;
  const structure = await api("/channels", { token: account.token });
  const channels = [...(structure.uncategorized_channels || []), ...(structure.categories || []).flatMap(category => category.channels || [])];
  const channel = channels.find(item => item.kind === "voice");
  assert.ok(channel, "Nenhum canal de voz encontrado para as contas de teste.");
  return channel.id;
}

async function main() {
  const credentials = accountsFromEnv();
  const accounts = [];
  for (const entry of credentials) accounts.push(await login(entry));
  const channelId = await voiceChannel(accounts[0]);
  const actors = accounts.map(account => ({ account, control: null, room: null }));
  console.log(`[SFU] API ${apiUrl}; LiveKit local via token; canal ${channelId}; ${actors.length} participantes.`);

  try {
    label("conexão inicial e presença");
    const first = actors[0];
    first.control = await new ControlClient(first.account).connect();
    await mintAndConnectMedia(first, channelId);
    first.control.send("voice.presence.enter", { channel_id: channelId });
    await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, [first.account.id]));

    for (const actor of actors.slice(1)) {
      actor.control = await new ControlClient(actor.account).connect();
      // A newly opened app must receive the already populated sidebar before
      // it joins media itself.
      await actor.control.waitFor("voice.rooms", data => roomHas(data, channelId, [first.account.id]));
      await mintAndConnectMedia(actor, channelId);
      actor.control.send("voice.presence.enter", { channel_id: channelId });
      await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, actors.slice(0, actors.indexOf(actor) + 1).map(item => item.account.id)));
    }
    await eventually("cada Room LiveKit enxerga os outros participantes", () => actors.every(actor => actor.room.remoteParticipants.size >= actors.length - 1));

    label("mute/deafen e projeção do compartilhamento");
    const subject = actors[1];
    subject.control.send("call.state.update", { channel_id: channelId, muted: true, deafened: true });
    await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, [subject.account.id], { muted: true, deafened: true }));
    subject.control.send("voice.track.published", { channel_id: channelId, source: "screen_share", track_sid: "sfu-integration-screen" });
    await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, [subject.account.id], { sharing: true }));
    subject.control.send("voice.track.unpublished", { channel_id: channelId, source: "screen_share", track_sid: "sfu-integration-screen" });
    await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, [subject.account.id], { sharing: false }));

    label("queda de controle, reabertura e reconexão da mídia");
    subject.control.terminate();
    await first.control.waitFor("voice.roster", data => data.channel_id === channelId && !(data.participants || []).some(p => p.user_id === subject.account.id));
    subject.control = await new ControlClient(subject.account).connect();
    subject.control.send("voice.rooms.request");
    await subject.control.waitFor("voice.rooms", data => roomHas(data, channelId, actors.filter(actor => actor !== subject).map(actor => actor.account.id)));
    subject.control.send("voice.presence.enter", { channel_id: channelId });
    await first.control.waitFor("voice.roster", data => rosterHas(data, channelId, actors.map(actor => actor.account.id)));
    await disconnectMedia(subject);
    await mintAndConnectMedia(subject, channelId);
    subject.control.send("voice.presence.enter", { channel_id: channelId });
    await eventually("mídia LiveKit reconectada volta a enxergar os pares", () => subject.room.remoteParticipants.size >= actors.length - 1);

    label("saídas e limpeza do roster");
    for (const actor of [...actors].reverse()) {
      await leave(actor, channelId);
      const remaining = actors.filter(item => item !== actor && item.room);
      if (remaining.length) await remaining[0].control.waitFor("voice.roster", data => data.channel_id === channelId && data.participants.length === remaining.length);
    }
    console.log("\n[SFU] PASS: presença, snapshot, mute/deafen, share, queda/reconexão e cleanup passaram.");
  } finally {
    await Promise.all(actors.map(async actor => {
      try { await leave(actor, channelId); } catch { /* best-effort cleanup */ }
      try { await actor.control?.close(); } catch { /* best-effort cleanup */ }
    }));
  }
}

main().catch(error => {
  console.error(`\n[SFU] FAIL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
