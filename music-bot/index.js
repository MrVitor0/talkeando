// A real, headless WebRTC participant. Media stays on the VPS: ffmpeg emits
// PCM into node-webrtc's RTCAudioSource, then one PeerConnection per caller
// carries Opus directly across the existing mesh.
const WebSocket = require("ws");
const fs = require("fs");
// `wrtc` (node-webrtc) has been unmaintained since 2020 and has no working
// prebuilt binaries for Node >= 16 — on node:18 it crashes the process the
// first time an RTCPeerConnection / RTCAudioSource is created, which showed
// up as the bot going offline mid-handshake ("target is not connected") and
// no audio ever arriving. `@roamhq/wrtc` is the maintained community fork
// with the same API surface (including `nonstandard.RTCAudioSource`).
const wrtc = require("@roamhq/wrtc");
const { spawn } = require("child_process");
const crypto = require("crypto");

const BOT_ID = "00000000-0000-0000-0000-000000000001";
const WS_URL = process.env.TUPI_WS_URL || "ws://tupi-server:8080/ws";
const token = process.env.MUSIC_BOT_TOKEN || process.env.TURN_SHARED_SECRET;
if (!token) throw new Error("MUSIC_BOT_TOKEN is required");
let ws, voiceChannel = null, current = null, paused = false;
// The server-side id of the `music` stream we currently have published, so we
// can retract it the moment playback ends instead of leaving a phantom
// "TOCANDO" in everyone's sidebar.
let publishedStreamId = null;
// When the bot went quiet (song finished, or /pause). The watchdog uses this
// to leave the channel after IDLE_TIMEOUT_MS so it never sits there forever.
let idleSince = 0;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const peers = new Map();

const log = (...args) => console.log(new Date().toISOString(), "[music-bot]", ...args);
function send(op, data) { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, op, data })); }
function iceServers() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:${BOT_ID}`;
  const credential = crypto.createHmac("sha1", process.env.TURN_SHARED_SECRET || "").update(username).digest("base64");
  const turnUris = (process.env.TURN_URIS || "").split(",").map(s => s.trim()).filter(Boolean);
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (turnUris.length) servers.push({ urls: turnUris, username, credential });
  return servers;
}
async function peer(userId) {
  if (peers.has(userId)) return peers.get(userId);
  const pc = new wrtc.RTCPeerConnection({ iceServers: iceServers() }); peers.set(userId, pc);
  pc.onicecandidate = ({ candidate }) => candidate && send("rtc.ice", { channel_id: voiceChannel, to: userId, candidate: candidate.toJSON() });
  pc.oniceconnectionstatechange = () => log(`peer ${userId}: iceConnectionState=${pc.iceConnectionState}`);
  pc.onconnectionstatechange = () => {
    log(`peer ${userId}: connectionState=${pc.connectionState}`);
    if (pc.connectionState === "failed") log(`peer ${userId}: ICE FAILED — check TURN reachability from the container`);
  };
  if (current?.track) pc.addTrack(current.track);
  return pc;
}
async function offer(userId) {
  const pc = await peer(userId); const description = await pc.createOffer(); await pc.setLocalDescription(description);
  send("rtc.offer", { channel_id: voiceChannel, to: userId, sdp: description.sdp });
}
async function addTrackToPeers() {
  for (const [id, pc] of peers) {
    if (current?.track && !pc.getSenders().some(sender => sender.track === current.track)) pc.addTrack(current.track);
    await offer(id);
  }
}
function stopPlayback() {
  if (current?.yt) current.yt.kill("SIGKILL"); if (current?.ffmpeg) current.ffmpeg.kill("SIGKILL");
  if (current?.track) current.track.stop(); current = null; paused = false;
}
// Retract the published `music` stream (clears the "TOCANDO" badge) without
// leaving the voice channel — used when a track finishes so a quick next
// /play doesn't have to rejoin.
function unpublishCurrent() {
  if (publishedStreamId && voiceChannel) send("stream.unpublish", { channel_id: voiceChannel, stream_id: publishedStreamId });
  publishedStreamId = null;
}
// Full teardown: stop audio, retract the stream, drop every peer and leave
// the call. `call.leave` alone also retracts the stream server-side, but
// unpublishing first keeps the sidebar in sync a beat earlier.
function leaveVoice() {
  stopPlayback();
  unpublishCurrent();
  if (voiceChannel) send("call.leave", { channel_id: voiceChannel });
  for (const pc of peers.values()) pc.close(); peers.clear();
  voiceChannel = null;
  idleSince = 0;
}
async function resolveSources(query) {
  const match = query.match(/^https:\/\/open\.spotify\.com\/(track|playlist)\/([A-Za-z0-9]+)/);
  if (!match) return [/^https?:\/\//.test(query) ? query : `ytsearch1:${query}`];
  const [clientId, clientSecret] = [process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET];
  if (!clientId || !clientSecret) throw new Error("Spotify ainda não está configurado; use uma busca, URL ou playlist do YouTube.");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const accessToken = (await tokenResponse.json()).access_token; if (!accessToken) throw new Error("não foi possível autenticar na API do Spotify");
  const headers = { authorization: `Bearer ${accessToken}` };
  if (match[1] === "track") {
    const track = await (await fetch(`https://api.spotify.com/v1/tracks/${match[2]}`, { headers })).json();
    return [`ytsearch1:${track.name} ${track.artists.map(artist => artist.name).join(" ")}`];
  }
  const sources = []; let next = `https://api.spotify.com/v1/playlists/${match[2]}/tracks?limit=100`;
  while (next) {
    const page = await (await fetch(next, { headers })).json();
    for (const item of page.items || []) if (item.track?.name) sources.push(`ytsearch1:${item.track.name} ${(item.track.artists || []).map(artist => artist.name).join(" ")}`);
    next = page.next;
  }
  if (!sources.length) throw new Error("playlist Spotify vazia ou indisponível");
  return sources;
}
// YouTube blocks datacenter IPs outright ("Sign in to confirm you're not a
// bot") — no player_client bypasses it any more, only real cookies. Drop a
// Netscape cookies.txt at YT_DLP_COOKIES (default /cookies/yt.txt, mounted
// read-only by docker-compose) and the bot uses it automatically. yt-dlp
// rewrites the cookie jar on exit, so it works from a /tmp copy (the mount is
const COOKIES_SRC = process.env.YT_DLP_COOKIES || "/cookies/yt.txt";
const COOKIES_WORK = "/tmp/yt-cookies.txt";
function cookiesFile() {
  try {
    let src = fs.existsSync(COOKIES_SRC) && fs.statSync(COOKIES_SRC).size > 0 ? COOKIES_SRC : COOKIES_WORK;
    if (!fs.existsSync(src) || fs.statSync(src).size === 0) return null;
    let content = fs.readFileSync(src, "utf8");
    if (!content.startsWith("# Netscape HTTP Cookie File")) {
      content = "# Netscape HTTP Cookie File\n" + content;
    }
    fs.writeFileSync(COOKIES_WORK, content, "utf8");
    return COOKIES_WORK;
  } catch { return null; }
}

async function startPlayback(query) {
  stopPlayback();
  const sources = await resolveSources(query);
  const cookies = cookiesFile();
  log(`startPlayback: ${JSON.stringify(sources)} (cookies: ${cookies ? "yes" : "NONE — YouTube will block this"})`);
  const ytArgs = [
    "--no-progress", "--no-warnings",
    "--geo-bypass",
    "--extractor-args", "youtube:player_skip=visionos",
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    "-f", "251/140/bestaudio/best",
    "-o", "-",
  ];
  if (cookies) ytArgs.push("--cookies", cookies);
  ytArgs.push(...sources);

  const yt = spawn("yt-dlp", ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-re",
    "-i", "pipe:0",
    "-f", "s16le", "-ar", "48000", "-ac", "2",
    "pipe:1"
  ], { stdio: ["pipe", "pipe", "pipe"] });

  yt.stdout.pipe(ffmpeg.stdin);
  yt.stderr.on("data", d => process.stderr.write(`[yt-dlp] ${d}`));
  ffmpeg.stderr.on("data", d => process.stderr.write(`[ffmpeg] ${d}`));
  yt.on("close", code => log(`yt-dlp exited (code ${code})`));

  const audio = new wrtc.nonstandard.RTCAudioSource();
  const track = audio.createTrack();
  current = { yt, ffmpeg, track, audio, label: query };
  idleSince = 0;
  let bytesOut = 0;
  let pcmBuffer = Buffer.alloc(0);
  const FRAME_SIZE_BYTES = 1920; // 10ms of 48kHz 16-bit stereo (480 frames * 2 channels * 2 bytes)
  const SAMPLES_PER_CHUNK = 960;  // 480 frames * 2 channels

  ffmpeg.stdout.on("data", chunk => {
    if (bytesOut === 0) log(`first PCM chunk from ffmpeg (${chunk.length} bytes) — audio pipeline is producing sound`);
    bytesOut += chunk.length;
    if (paused || !current) return;

    pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
    while (pcmBuffer.length >= FRAME_SIZE_BYTES) {
      const samples = new Int16Array(SAMPLES_PER_CHUNK);
      Buffer.from(samples.buffer).set(pcmBuffer.subarray(0, FRAME_SIZE_BYTES));
      pcmBuffer = pcmBuffer.subarray(FRAME_SIZE_BYTES);

      audio.onData({
        samples,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 2,
        numberOfFrames: 480,
      });
    }
  });
  // Track (or playlist) finished: drop the stream so "TOCANDO" clears, and
  // start the idle countdown — the watchdog leaves the channel if nothing
  // else is queued up.
  ffmpeg.on("close", () => {
    if (current?.ffmpeg !== ffmpeg) return;
    log(`playback ended (${bytesOut} bytes of PCM total)${bytesOut === 0 ? " — NOTHING was decoded; see [yt-dlp] output above" : ""}`);
    stopPlayback();
    unpublishCurrent();
    idleSince = Date.now();
  });
  return addTrackToPeers();
}
async function join(channelId) {
  if (voiceChannel === channelId) return;
  if (voiceChannel) send("call.leave", { channel_id: voiceChannel });
  for (const pc of peers.values()) pc.close(); peers.clear(); voiceChannel = channelId;
  send("call.join", { channel_id: channelId, muted: true, deafened: false });
}
async function onEvent(op, data) {
  if (op === "call.snapshot") {
    voiceChannel = data.channel_id;
    for (const participant of data.participants || []) if (participant.user_id !== BOT_ID && !participant.is_bot) await offer(participant.user_id);
  } else if (op === "call.peer_joined" && data.participant?.user_id !== BOT_ID && !data.participant?.is_bot) await offer(data.participant.user_id);
  else if (op === "call.peer_left") { peers.get(data.user_id)?.close(); peers.delete(data.user_id); }
  else if (op === "rtc.offer") { const pc = await peer(data.from); await pc.setRemoteDescription({ type: "offer", sdp: data.sdp }); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send("rtc.answer", { channel_id: voiceChannel, to: data.from, sdp: answer.sdp }); }
  else if (op === "rtc.answer") { const pc = peers.get(data.from); if (pc) await pc.setRemoteDescription({ type: "answer", sdp: data.sdp }); }
  else if (op === "rtc.ice") { const pc = await peer(data.from); await pc.addIceCandidate(data.candidate); }
  else if (op === "music.command") {
    log(`music.command: ${data.command} ${JSON.stringify(data.query ?? "")}`);
    if (data.command === "play") {
      try {
        await join(data.voice_channel_id);
        await startPlayback(data.query);
        publishedStreamId = crypto.randomUUID();
        send("stream.publish", { channel_id: data.voice_channel_id, stream_id: publishedStreamId, kind: "music", label: data.query, has_audio: true });
      } catch (error) {
        log(`play failed: ${error && error.message ? error.message : error}`);
        unpublishCurrent();
      }
    }
    if (data.command === "pause") { paused = true; idleSince = Date.now(); }
    if (data.command === "resume") { paused = false; idleSince = 0; }
    if (data.command === "stop") leaveVoice();
  }
  // An owner dragged the bot to another voice channel — follow it, carrying
  // the current track over to the new room.
  else if (op === "voice.moved" && data.channel_id && data.channel_id !== voiceChannel) {
    const stillPlaying = !!current;
    const label = current?.label ?? "música";
    await join(data.channel_id);
    if (stillPlaying) {
      publishedStreamId = crypto.randomUUID();
      send("stream.publish", { channel_id: data.channel_id, stream_id: publishedStreamId, kind: "music", label, has_audio: true });
    } else {
      publishedStreamId = null;
      idleSince = idleSince || Date.now();
    }
  }
}

// Watchdog: never let the bot sit in a channel doing nothing. Leaves once it
// has been paused / silent for IDLE_TIMEOUT_MS.
setInterval(() => {
  if (!voiceChannel) return;
  if (current && !paused) { idleSince = 0; return; }
  if (!idleSince) idleSince = Date.now();
  if (Date.now() - idleSince >= IDLE_TIMEOUT_MS) {
    console.log("music-bot: idle timeout reached, leaving voice channel");
    leaveVoice();
  }
}, 30 * 1000);
function connect() {
  log(`connecting to ${WS_URL}`);
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { log("ws open — sending auth.hello"); send("auth.hello", { token }); });
  ws.on("message", raw => {
    try {
      const e = JSON.parse(raw);
      if (e.op === "auth.ok") log("authenticated as the music bot");
      if (e.op === "auth.rejected") log(`AUTH REJECTED: ${JSON.stringify(e.data)} — check MUSIC_BOT_TOKEN matches the server`);
      if (e.op === "error") log(`server error: ${JSON.stringify(e.data)}`);
      void onEvent(e.op, e.data || {});
    } catch (error) { console.error(error); }
  });
  ws.on("close", () => { log("ws closed — reconnecting in 2s"); setTimeout(connect, 2000); });
  ws.on("error", error => log(`ws error: ${error.message}`));
}
process.on("unhandledRejection", reason => log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`));
connect();
