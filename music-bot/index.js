// A real, headless WebRTC participant. Media stays on the VPS: yt-dlp pipes
// the source into ffmpeg, ffmpeg emits raw 48 kHz stereo PCM, and a paced
// 10 ms feeder hands that to node-webrtc's RTCAudioSource. That source owns a
// single long-lived track which every caller's PeerConnection carries, so
// changing songs never renegotiates and never stacks extra senders.
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

const log = (...args) => console.log(new Date().toISOString(), "[music-bot]", ...args);

// ---------------------------------------------------------------- audio math
// RTCAudioSource wants exactly one 10 ms frame per call, and `samples` must be
// a standalone Int16Array whose byteLength is frames * channels * 2 — 1920.
// Handing it a Buffer slice out of Node's 8 KiB pool is what used to throw
// "Expected a .byteLength of 1920, not 8192" and take the whole process down.
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_MS = 10;
const FRAME_SAMPLES = (SAMPLE_RATE / 1000) * FRAME_MS;       // 480 per channel
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;            // 1920
const BYTES_PER_MS = FRAME_BYTES / FRAME_MS;                 // 192

// How much decoded audio to bank before the first frame goes out, and the
// window the feeder keeps ffmpeg inside. Everything above the high mark
// back-pressures ffmpeg (and through it yt-dlp), which is what keeps memory
// flat no matter how fast YouTube serves the file.
const PREBUFFER_MS = Number(process.env.MUSIC_PREBUFFER_MS || 700);
const HIGH_WATER_MS = Number(process.env.MUSIC_HIGH_WATER_MS || 6000);
const LOW_WATER_MS = Number(process.env.MUSIC_LOW_WATER_MS || 2000);
const PREBUFFER_BYTES = PREBUFFER_MS * BYTES_PER_MS;
const HIGH_WATER_BYTES = HIGH_WATER_MS * BYTES_PER_MS;
const LOW_WATER_BYTES = LOW_WATER_MS * BYTES_PER_MS;
// If the event loop stalls we resync the clock instead of firing a burst of
// catch-up frames, which would arrive as a chipmunk blip.
const MAX_CATCHUP_MS = 500;

const MAX_QUEUE = Number(process.env.MUSIC_MAX_QUEUE || 500);
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let ws, voiceChannel = null;
// The server-side id of the `music` stream we currently have published, so we
// can retract it the moment playback ends instead of leaving a phantom
// "TOCANDO" in everyone's sidebar.
let publishedStreamId = null;
// When the bot went quiet (queue drained, or /pause). The watchdog uses this
// to leave the channel after IDLE_TIMEOUT_MS so it never sits there forever.
let idleSince = 0;
let paused = false;
const peers = new Map();

function send(op, data) { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: 1, op, data })); }

// ------------------------------------------------------------- peer plumbing
function iceServers() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:${BOT_ID}`;
  const credential = crypto.createHmac("sha1", process.env.TURN_SHARED_SECRET || "").update(username).digest("base64");
  const turnUris = (process.env.TURN_URIS || "").split(",").map(s => s.trim()).filter(Boolean);
  const servers = [{ urls: "stun:stun.l.google.com:19302" }];
  if (turnUris.length) servers.push({ urls: turnUris, username, credential });
  return servers;
}

// One RTCAudioSource for the process lifetime. Songs come and go through it;
// the track never does. That is what makes song changes free: no addTrack, no
// second offer, and no SDP that grows by an audio m-line per song (which is
// what kept pushing the signalling payload towards the 64 KiB limit).
let audioSource = null, audioTrack = null;
function musicTrack() {
  if (!audioTrack) {
    audioSource = new wrtc.nonstandard.RTCAudioSource();
    audioTrack = audioSource.createTrack();
    log("created the persistent music track");
  }
  return audioTrack;
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
  pc.addTrack(musicTrack());
  return pc;
}
async function offer(userId) {
  const pc = await peer(userId); const description = await pc.createOffer(); await pc.setLocalDescription(description);
  send("rtc.offer", { channel_id: voiceChannel, to: userId, sdp: description.sdp });
}

// ------------------------------------------------------------------ PCM ring
// A chunk list rather than one growing Buffer: `Buffer.concat` on every ffmpeg
// read is O(buffered bytes) per chunk, so a few seconds of backlog turned into
// megabytes of copying per second.
class PcmQueue {
  constructor() { this.chunks = []; this.bytes = 0; this.offset = 0; }
  push(chunk) { this.chunks.push(chunk); this.bytes += chunk.length; }
  clear() { this.chunks = []; this.bytes = 0; this.offset = 0; }
  /** Fill `target` from the head of the queue; returns how many bytes it got. */
  read(target) {
    let filled = 0;
    while (filled < target.length && this.chunks.length) {
      const head = this.chunks[0];
      const take = Math.min(head.length - this.offset, target.length - filled);
      head.copy(target, filled, this.offset, this.offset + take);
      filled += take; this.offset += take; this.bytes -= take;
      if (this.offset >= head.length) { this.chunks.shift(); this.offset = 0; }
    }
    return filled;
  }
}

// -------------------------------------------------------------------- feeder
// Drift-corrected 10 ms clock. RTCAudioSource does no pacing of its own — it
// forwards whatever you hand it straight into the encoder — so dumping ffmpeg's
// bursty output in as it arrives is what made playback garble. We track an
// absolute deadline instead of `setInterval(fn, 10)`, which drifts by seconds
// an hour on a busy event loop.
let current = null;          // the track being decoded right now
let feederTimer = null, nextFrameAt = 0;

function startFeeder() {
  if (feederTimer) return;
  musicTrack();
  nextFrameAt = Date.now();
  feederTimer = setTimeout(tick, FRAME_MS);
}
function stopFeeder() {
  if (feederTimer) clearTimeout(feederTimer);
  feederTimer = null;
}
function tick() {
  feederTimer = null;
  if (Date.now() - nextFrameAt > MAX_CATCHUP_MS) nextFrameAt = Date.now();
  let emitted = 0;
  while (nextFrameAt <= Date.now() && emitted < 64) { emitFrame(); nextFrameAt += FRAME_MS; emitted++; }
  feederTimer = setTimeout(tick, Math.max(0, nextFrameAt - Date.now()));
}
/** A fresh, zero-filled 10 ms frame plus a Buffer view onto the same memory,
 *  so the PCM queue can be read straight into it with no second copy. The
 *  Int16Array is never reused: wrtc reads `samples` inside onData and a
 *  standalone 1920-byte allocation is the one shape it accepts. */
function newFrame() {
  const samples = new Int16Array(FRAME_SAMPLES * CHANNELS);
  return { samples, bytes: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength) };
}
function pushFrame(frame) {
  if (!audioSource) return;
  try {
    audioSource.onData({ samples: frame.samples, sampleRate: SAMPLE_RATE, bitsPerSample: 16, channelCount: CHANNELS, numberOfFrames: FRAME_SAMPLES });
  } catch (error) {
    // Never let a bad frame kill the process — that turned one hiccup into a
    // container restart loop that dropped everyone out of the call.
    log(`onData failed: ${error && error.message ? error.message : error}`);
  }
}
function emitSilence() { pushFrame(newFrame()); }

function emitFrame() {
  const track = current;
  // Silence while idle or paused keeps RTP flowing so browsers don't tear the
  // receiver down between songs, and makes /resume pick up exactly where it
  // stopped: the decoded audio just sits in the queue, back-pressuring ffmpeg.
  if (!track || paused) return emitSilence();

  if (!track.flowing) {
    if (track.pcm.bytes >= PREBUFFER_BYTES || (track.eof && track.pcm.bytes > 0)) track.flowing = true;
    else {
      if (track.eof && track.pcm.bytes === 0) finishTrack(track);
      return emitSilence();
    }
  }

  const frame = newFrame();
  const got = track.pcm.read(frame.bytes);
  if (got < FRAME_BYTES) {
    // The tail is already zeroed — a short read just fades into silence.
    if (track.eof) { pushFrame(frame); return finishTrack(track); }
    // Starved mid-song: go back to buffering rather than stuttering frame by
    // frame while the network catches up.
    track.flowing = false; track.underruns++;
  }
  pushFrame(frame);

  if (track.stdoutPaused && track.pcm.bytes <= LOW_WATER_BYTES) {
    track.stdoutPaused = false;
    track.ffmpeg.stdout.resume();
  }
}

// ------------------------------------------------------------------- cookies
// YouTube blocks datacenter IPs outright ("Sign in to confirm you're not a
// bot") — no player_client bypasses it any more, only real cookies. Drop a
// Netscape cookies.txt at YT_DLP_COOKIES (default /cookies/yt.txt, mounted
// read-only by docker-compose) and the bot uses it automatically.
const COOKIES_SRC = process.env.YT_DLP_COOKIES || "/cookies/yt.txt";
const COOKIES_WORK = "/tmp/yt-cookies.txt";
function cookiesFile() {
  try {
    const srcStat = fs.existsSync(COOKIES_SRC) ? fs.statSync(COOKIES_SRC) : null;
    const workStat = fs.existsSync(COOKIES_WORK) ? fs.statSync(COOKIES_WORK) : null;
    const haveSrc = srcStat && srcStat.size > 0;
    const haveWork = workStat && workStat.size > 0;
    // yt-dlp rotates __Secure-*PSIDTS / SIDCC and rewrites the jar on exit, so
    // it needs a writable copy — but that copy must not outrank a cookies.txt
    // you just dropped on the host, or refreshing cookies silently does
    // nothing. Newest mtime wins.
    if (haveSrc && (!haveWork || srcStat.mtimeMs > workStat.mtimeMs)) {
      let content = fs.readFileSync(COOKIES_SRC, "utf8");
      if (!content.startsWith("# Netscape HTTP Cookie File")) content = "# Netscape HTTP Cookie File\n" + content;
      fs.writeFileSync(COOKIES_WORK, content, "utf8");
      log(`refreshed the cookie jar from ${COOKIES_SRC}`);
      return COOKIES_WORK;
    }
    return haveWork ? COOKIES_WORK : null;
  } catch (error) { log(`cookie jar unusable: ${error.message}`); return null; }
}

// -------------------------------------------------------------------- yt-dlp
// Client sets tried in order. `visionos` only ever offers the muxed 360p
// format 18 and then 403s on the media URL, so it is excluded up front; the
// rest are fallbacks for when YouTube breaks the preferred one. (The old
// `player_skip=visionos` was a no-op — player_skip takes stages, not clients,
// and `--no-warnings` hid yt-dlp saying so.)
const CLIENT_SETS = [
  process.env.YT_PLAYER_CLIENTS || "default,-visionos",
  "tv,web_embedded",
  "web_safari,mweb",
];
const AUDIO_FORMAT = process.env.YT_AUDIO_FORMAT || "bestaudio[acodec=opus]/bestaudio/best";

function ytArgs({ clients, playlist = false }) {
  const args = [
    "--ignore-config", "--no-progress", "--no-call-home",
    // Deliberately NOT --geo-bypass: it injects a random spoofed
    // X-Forwarded-For, so YouTube hands back a player response bound to an IP
    // we then don't download from. That is the intermittent "HTTP Error 403:
    // Forbidden" right after "Downloading 1 format(s)".
    "--retries", "5", "--fragment-retries", "5",
    "--extractor-retries", "3", "--socket-timeout", "20",
    // Deno solves the signature / `n` challenges; the EJS solver is fetched
    // once and cached in the ytdlp_cache volume.
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    "--extractor-args", `youtube:player_client=${clients}`,
  ];
  if (!playlist) args.push("--no-playlist");
  const cookies = cookiesFile();
  if (cookies) args.push("--cookies", cookies);
  else log("no cookie jar available — YouTube will almost certainly block this");
  return args;
}

function runYtDlp(args, { timeoutMs = 45000 } = {}) {
  return new Promise(resolve => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", error => { clearTimeout(timer); resolve({ code: -1, out, err: String(error) }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** One metadata pass: resolves a search term or URL to a concrete video. */
async function resolveMeta(spec) {
  for (const clients of CLIENT_SETS) {
    const args = [
      ...ytArgs({ clients }),
      "--skip-download", "--playlist-items", "1",
      "--print", "%(id)s", "--print", "%(title)s", "--print", "%(duration)s",
      spec,
    ];
    const { code, out, err } = await runYtDlp(args, { timeoutMs: 30000 });
    const [id, title, duration] = out.trim().split("\n");
    if (code === 0 && id && !/\s/.test(id)) {
      return { id, url: `https://www.youtube.com/watch?v=${id}`, title: title || id, duration: Number(duration) || 0 };
    }
    const reason = (err || "").trim().split("\n").pop() || `exit ${code}`;
    log(`resolve failed for ${JSON.stringify(spec)} with clients=${clients}: ${reason}`);
  }
  return null;
}

// ------------------------------------------------------------------ sourcing
/** Expand whatever the user typed into queue entries (spec + display label). */
async function expandQuery(query) {
  const spotify = query.match(/^https:\/\/open\.spotify\.com\/(track|playlist|album)\/([A-Za-z0-9]+)/);
  if (spotify) return expandSpotify(spotify[1], spotify[2]);

  if (/^https?:\/\//.test(query)) {
    // `watch?v=X&list=Y` means "play X"; a bare playlist/mix URL means "queue
    // the whole thing".
    const isPlaylist = /[?&]list=/.test(query) && !/[?&]v=/.test(query);
    if (!isPlaylist) return [{ spec: query, label: query }];
    const args = [
      ...ytArgs({ clients: CLIENT_SETS[0], playlist: true }),
      "--flat-playlist", "--skip-download", "--playlist-end", String(MAX_QUEUE),
      "--print", "%(id)s", "--print", "%(title)s",
      query,
    ];
    const { out } = await runYtDlp(args, { timeoutMs: 90000 });
    const lines = out.trim().split("\n").filter(Boolean);
    const entries = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      entries.push({ spec: `https://www.youtube.com/watch?v=${lines[i]}`, label: lines[i + 1] });
    }
    if (!entries.length) throw new Error("não consegui ler essa playlist do YouTube");
    return entries;
  }

  return [{ spec: `ytsearch1:${query}`, label: query }];
}

async function expandSpotify(kind, id) {
  const [clientId, clientSecret] = [process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET];
  if (!clientId || !clientSecret) throw new Error("Spotify ainda não está configurado; use uma busca, URL ou playlist do YouTube.");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenResponse = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const accessToken = (await tokenResponse.json()).access_token;
  if (!accessToken) throw new Error("não foi possível autenticar na API do Spotify");
  const headers = { authorization: `Bearer ${accessToken}` };
  const entry = track => {
    const artists = (track.artists || []).map(artist => artist.name).join(" ");
    return { spec: `ytsearch1:${track.name} ${artists}`, label: `${track.name} — ${artists}`.trim() };
  };

  if (kind === "track") {
    const track = await (await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers })).json();
    if (!track?.name) throw new Error("faixa do Spotify indisponível");
    return [entry(track)];
  }
  // Playlists and albums used to collapse to a single bogus search of the
  // Spotify URL itself; every track now lands in the queue.
  const entries = [];
  let next = kind === "album"
    ? `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`
    : `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`;
  while (next && entries.length < MAX_QUEUE) {
    const page = await (await fetch(next, { headers })).json();
    for (const item of page.items || []) {
      const track = kind === "album" ? item : item.track;
      if (track?.name) entries.push(entry(track));
    }
    next = page.next;
  }
  if (!entries.length) throw new Error("playlist Spotify vazia ou indisponível");
  return entries;
}

// ----------------------------------------------------------------- the queue
const queue = [];
// Resolving metadata takes seconds, so a second advance can land while the
// first is mid-await. `pendingAdvance` makes the in-flight call re-check the
// queue on the way out instead of leaving a just-queued song stranded.
let advancing = false, pendingAdvance = false;

/** Metadata is resolved lazily, and the next entry is warmed while this one
 *  plays so /skip lands in well under a second instead of ~8. */
function resolveEntry(entry) {
  if (entry.meta !== undefined) return Promise.resolve(entry.meta);
  if (!entry.pending) entry.pending = resolveMeta(entry.spec).then(meta => { entry.meta = meta; return meta; });
  return entry.pending;
}
function prefetchNext() { if (queue[0]) void resolveEntry(queue[0]).catch(() => { }); }

function stopCurrent() {
  const track = current;
  current = null;
  if (!track) return;
  track.aborted = true;
  try { track.yt.kill("SIGKILL"); } catch { /* already gone */ }
  try { track.ffmpeg.kill("SIGKILL"); } catch { /* already gone */ }
  track.pcm.clear();
}

// Retract the published `music` stream (clears the "TOCANDO" badge) without
// leaving the voice channel — a quick next /play doesn't have to rejoin.
function unpublishCurrent() {
  if (publishedStreamId && voiceChannel) send("stream.unpublish", { channel_id: voiceChannel, stream_id: publishedStreamId });
  publishedStreamId = null;
}
function publishTrack(label) {
  unpublishCurrent();
  if (!voiceChannel) return;
  publishedStreamId = crypto.randomUUID();
  send("stream.publish", { channel_id: voiceChannel, stream_id: publishedStreamId, kind: "music", label, has_audio: true });
}

function finishTrack(track) {
  if (track.done) return;
  track.done = true;
  const seconds = ((Date.now() - track.startedAt) / 1000).toFixed(1);
  log(`finished "${track.title}" (${(track.bytes / 1e6).toFixed(1)} MB PCM in ${seconds}s, ${track.underruns} underruns)`);
  void playNext();
}

async function playNext() {
  if (advancing) { pendingAdvance = true; return; }
  advancing = true;
  pendingAdvance = false;
  try {
    stopCurrent();
    while (queue.length) {
      const entry = queue.shift();
      const meta = await resolveEntry(entry);
      if (!meta) { log(`skipping ${JSON.stringify(entry.label)} — could not resolve it`); continue; }
      if (beginStream(meta)) { prefetchNext(); return; }
    }
    unpublishCurrent();
    idleSince = Date.now();
    log("queue drained — idle");
  } catch (error) {
    log(`playNext failed: ${error && error.message ? error.message : error}`);
    unpublishCurrent();
    idleSince = Date.now();
  } finally {
    advancing = false;
    if (pendingAdvance && !current && queue.length) void playNext();
  }
}

/** Spawn yt-dlp | ffmpeg for one resolved video. Returns false only if the
 *  spawn itself was impossible; a stream that dies empty retries with the next
 *  client set and then moves on by itself. */
function beginStream(meta, attempt = 0) {
  stopCurrent();
  const clients = CLIENT_SETS[Math.min(attempt, CLIENT_SETS.length - 1)];
  log(`playing "${meta.title}" (${meta.url}) clients=${clients}${attempt ? ` attempt=${attempt + 1}` : ""}`);

  let yt, ffmpeg;
  try {
    yt = spawn("yt-dlp", [...ytArgs({ clients }), "-f", AUDIO_FORMAT, "-o", "-", meta.url], { stdio: ["ignore", "pipe", "pipe"] });
    ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "warning", "-nostdin",
      "-i", "pipe:0",
      "-vn",
      "-af", audioFilter(),
      "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS),
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    log(`spawn failed: ${error.message}`);
    return false;
  }

  const track = {
    meta, title: meta.title, yt, ffmpeg, attempt,
    pcm: new PcmQueue(), eof: false, flowing: false, done: false, aborted: false,
    stdoutPaused: false, bytes: 0, underruns: 0, startedAt: Date.now(),
  };
  current = track;
  idleSince = 0;

  yt.stdout.pipe(ffmpeg.stdin);
  // Killing yt-dlp mid-song EPIPEs ffmpeg's stdin; without these handlers the
  // unhandled 'error' event takes the process down.
  yt.stdout.on("error", () => { });
  ffmpeg.stdin.on("error", () => { });
  yt.on("error", error => log(`yt-dlp spawn error: ${error.message}`));
  ffmpeg.on("error", error => log(`ffmpeg spawn error: ${error.message}`));
  yt.stderr.on("data", d => process.stderr.write(`[yt-dlp] ${d}`));
  ffmpeg.stderr.on("data", d => process.stderr.write(`[ffmpeg] ${d}`));

  ffmpeg.stdout.on("data", chunk => {
    if (current !== track) return;
    if (track.bytes === 0) log(`first PCM from ffmpeg after ${Date.now() - track.startedAt}ms`);
    track.bytes += chunk.length;
    track.pcm.push(chunk);
    if (!track.stdoutPaused && track.pcm.bytes >= HIGH_WATER_BYTES) {
      track.stdoutPaused = true;
      ffmpeg.stdout.pause();
    }
  });

  ffmpeg.on("close", () => {
    if (track.aborted || current !== track) return;
    track.eof = true;
    if (track.bytes > 0) return;   // the feeder drains the tail, then advances
    if (attempt + 1 < CLIENT_SETS.length) {
      log(`"${meta.title}" produced no audio with clients=${clients} — retrying`);
      beginStream(meta, attempt + 1);
      return;
    }
    log(`"${meta.title}" produced no audio on any client — skipping (see [yt-dlp] above)`);
    track.done = true;
    void playNext();
  });

  publishTrack(meta.title);
  return true;
}

function audioFilter() {
  // async=1 stretches/pads on timestamp gaps instead of letting the frame
  // clock slip, which is what keeps a long set in sync with the feeder.
  const chain = ["aresample=async=1:min_hard_comp=0.100:first_pts=0"];
  // Optional single-pass loudness levelling so a quiet track doesn't make
  // everyone reach for the volume knob mid-set.
  if (process.env.MUSIC_LOUDNORM === "1") chain.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  const volume = Number(process.env.MUSIC_VOLUME || 1);
  if (volume > 0 && volume !== 1) chain.push(`volume=${volume}`);
  return chain.join(",");
}

// ------------------------------------------------------------------ commands
async function enqueue(query) {
  const entries = await expandQuery(query);
  const room = Math.max(0, MAX_QUEUE - queue.length);
  const accepted = entries.slice(0, room);
  queue.push(...accepted);
  if (accepted.length < entries.length) log(`queue full — dropped ${entries.length - accepted.length} entries`);
  log(`queued ${accepted.length} item(s); ${queue.length} waiting`);
  paused = false;
  if (!current) await playNext(); else prefetchNext();
}

async function join(channelId) {
  if (voiceChannel === channelId) return;
  if (voiceChannel) send("call.leave", { channel_id: voiceChannel });
  for (const pc of peers.values()) pc.close(); peers.clear();
  voiceChannel = channelId;
  send("call.join", { channel_id: channelId, muted: true, deafened: false });
  startFeeder();
}
function leaveVoice() {
  stopCurrent();
  queue.length = 0;
  unpublishCurrent();
  stopFeeder();
  if (voiceChannel) send("call.leave", { channel_id: voiceChannel });
  for (const pc of peers.values()) pc.close(); peers.clear();
  voiceChannel = null;
  paused = false;
  idleSince = 0;
}

async function onEvent(op, data) {
  if (op === "call.snapshot") {
    voiceChannel = data.channel_id;
    startFeeder();
    for (const participant of data.participants || []) if (participant.user_id !== BOT_ID && !participant.is_bot) await offer(participant.user_id);
  } else if (op === "call.peer_joined" && data.participant?.user_id !== BOT_ID && !data.participant?.is_bot) await offer(data.participant.user_id);
  else if (op === "call.peer_left") { peers.get(data.user_id)?.close(); peers.delete(data.user_id); }
  else if (op === "rtc.offer") { const pc = await peer(data.from); await pc.setRemoteDescription({ type: "offer", sdp: data.sdp }); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); send("rtc.answer", { channel_id: voiceChannel, to: data.from, sdp: answer.sdp }); }
  else if (op === "rtc.answer") { const pc = peers.get(data.from); if (pc) await pc.setRemoteDescription({ type: "answer", sdp: data.sdp }); }
  else if (op === "rtc.ice") { const pc = await peer(data.from); await pc.addIceCandidate(data.candidate); }
  else if (op === "music.command") {
    log(`music.command: ${data.command} ${JSON.stringify(data.query ?? "")}`);
    try {
      if (data.command === "play") { await join(data.voice_channel_id); await enqueue(data.query); }
      else if (data.command === "pause") { paused = true; idleSince = Date.now(); }
      else if (data.command === "resume") { paused = false; idleSince = 0; }
      else if (data.command === "skip") { paused = false; await playNext(); }
      else if (data.command === "stop") leaveVoice();
      else if (data.command === "queue") log(`queue: ${queue.length} waiting, now playing ${JSON.stringify(current?.title ?? null)}`);
    } catch (error) {
      log(`${data.command} failed: ${error && error.message ? error.message : error}`);
      if (!current) unpublishCurrent();
    }
  }
  // An owner dragged the bot to another voice channel — follow it, carrying
  // the current track over to the new room.
  else if (op === "voice.moved" && data.channel_id && data.channel_id !== voiceChannel) {
    const label = current?.title ?? null;
    await join(data.channel_id);
    if (label) publishTrack(label);
    else { publishedStreamId = null; idleSince = idleSince || Date.now(); }
  }
}

// Watchdog: never let the bot sit in a channel doing nothing. Leaves once it
// has been paused / silent for IDLE_TIMEOUT_MS.
setInterval(() => {
  if (!voiceChannel) return;
  if (current && !paused) {
    idleSince = 0;
    if (current.flowing) log(`playing "${current.title}" — buffer ${(current.pcm.bytes / BYTES_PER_MS / 1000).toFixed(1)}s, ${current.underruns} underruns, queue ${queue.length}`);
    return;
  }
  if (!idleSince) idleSince = Date.now();
  if (Date.now() - idleSince >= IDLE_TIMEOUT_MS) {
    log("idle timeout reached, leaving voice channel");
    leaveVoice();
  }
}, 30 * 1000);

// ---------------------------------------------------------------- signalling
let wsBackoff = 1000;
function connect() {
  log(`connecting to ${WS_URL}`);
  ws = new WebSocket(WS_URL);
  ws.on("open", () => { wsBackoff = 1000; log("ws open — sending auth.hello"); send("auth.hello", { token }); });
  ws.on("message", raw => {
    try {
      const e = JSON.parse(raw);
      if (e.op === "auth.ok") log("authenticated as the music bot");
      if (e.op === "auth.rejected") log(`AUTH REJECTED: ${JSON.stringify(e.data)} — check MUSIC_BOT_TOKEN matches the server`);
      if (e.op === "error") log(`server error: ${JSON.stringify(e.data)}`);
      void onEvent(e.op, e.data || {});
    } catch (error) { console.error(error); }
  });
  ws.on("close", () => {
    // Exponential backoff with jitter: the old flat 2s retry produced a wall of
    // ENOTFOUND every time the server container restarted.
    const delay = Math.min(wsBackoff, 30000) + Math.floor(Math.random() * 500);
    log(`ws closed — reconnecting in ${delay}ms`);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
    setTimeout(connect, delay);
  });
  ws.on("error", error => log(`ws error: ${error.message}`));
}
process.on("unhandledRejection", reason => log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`));
process.on("uncaughtException", error => log(`uncaughtException: ${error && error.stack ? error.stack : error}`));

void runYtDlp(["--version"], { timeoutMs: 10000 }).then(({ out }) => log(`yt-dlp ${out.trim() || "version unknown"}`));
connect();
