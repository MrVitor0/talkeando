// A real, headless WebRTC participant. Media stays on the VPS: ffmpeg emits
// PCM into node-webrtc's RTCAudioSource, then one PeerConnection per caller
// carries Opus directly across the existing mesh.
const WebSocket = require("ws");
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
const peers = new Map();

function send(op, data) { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, op, data })); }
function turnServers() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:${BOT_ID}`;
  const credential = crypto.createHmac("sha1", process.env.TURN_SHARED_SECRET || "").update(username).digest("base64");
  return [{ urls: (process.env.TURN_URIS || "").split(",").filter(Boolean), username, credential }];
}
async function peer(userId) {
  if (peers.has(userId)) return peers.get(userId);
  const pc = new wrtc.RTCPeerConnection({ iceServers: turnServers() }); peers.set(userId, pc);
  pc.onicecandidate = ({ candidate }) => candidate && send("rtc.ice", { channel_id: voiceChannel, to: userId, candidate: candidate.toJSON() });
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
async function startPlayback(query) {
  stopPlayback();
  const sources = await resolveSources(query);
  const yt = spawn("yt-dlp", ["--no-progress", "-f", "bestaudio", "-o", "-", ...sources], { stdio: ["ignore", "pipe", "pipe"] });
  const ffmpeg = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  yt.stdout.pipe(ffmpeg.stdin);
  const audio = new wrtc.nonstandard.RTCAudioSource(); const track = audio.createTrack();
  current = { yt, ffmpeg, track, audio };
  ffmpeg.stdout.on("data", chunk => {
    if (paused || !current) return;
    const frames = Math.floor(chunk.length / 4); if (!frames) return;
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, frames * 2);
    audio.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 2, numberOfFrames: frames });
  });
  ffmpeg.on("close", () => { if (current?.ffmpeg === ffmpeg) stopPlayback(); });
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
    if (data.command === "play") { await join(data.voice_channel_id); await startPlayback(data.query); send("stream.publish", { channel_id: data.voice_channel_id, stream_id: crypto.randomUUID(), kind: "music", label: data.query, has_audio: true }); }
    if (data.command === "pause") paused = true;
    if (data.command === "resume") paused = false;
    if (data.command === "stop") { stopPlayback(); if (voiceChannel) send("call.leave", { channel_id: voiceChannel }); voiceChannel = null; }
  }
}
function connect() { ws = new WebSocket(WS_URL); ws.on("open", () => send("auth.hello", { token })); ws.on("message", raw => { try { const e = JSON.parse(raw); void onEvent(e.op, e.data || {}); } catch (error) { console.error(error); } }); ws.on("close", () => setTimeout(connect, 2000)); ws.on("error", error => console.error(error.message)); }
connect();
