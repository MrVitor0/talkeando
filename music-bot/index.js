// A real, headless WebRTC participant. Media stays on the VPS: yt-dlp pipes
// the source into ffmpeg, ffmpeg emits raw 48 kHz stereo PCM, and a paced
// 10 ms feeder hands that to node-webrtc's RTCAudioSource. That source owns a
// single long-lived track which every caller's PeerConnection carries, so
// changing songs never renegotiates and never stacks extra senders.
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
const { HttpClient } = require("./src/infrastructure/http-client");
const { SpotifyClient } = require("./src/infrastructure/spotify-client");
const { YouTubeClient } = require("./src/infrastructure/youtube-client");
const { AudiusClient } = require("./src/infrastructure/audius-client");
const { YtDlpClient } = require("./src/infrastructure/yt-dlp-client");
const { IntentResolver } = require("./src/intents/intent-resolver");
const { SpotifyIntentResolver } = require("./src/intents/spotify-intent-resolver");
const { YouTubeIntentResolver } = require("./src/intents/youtube-intent-resolver");
const { TextIntentResolver } = require("./src/intents/text-intent-resolver");
const { TrackScorer } = require("./src/matching/track-scorer");
const { ProviderChain, parseProviderOrder } = require("./src/providers/provider-chain");
const { NullProvider } = require("./src/providers/null-provider");
const { SoundCloudProvider } = require("./src/providers/soundcloud-provider");
const { AudiusProvider } = require("./src/providers/audius-provider");
const { YouTubeProvider } = require("./src/providers/youtube-provider");
const { MusicStatusReporter } = require("./src/status/music-status-reporter");

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
let lastStatusChannelId = null;
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
const statusReporter = new MusicStatusReporter({ send, createId: () => crypto.randomUUID() });

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

// -------------------------------------------------------------------- yt-dlp
// yt-dlp is only used for SoundCloud search now (see YtDlpClient). YouTube is
// discovery-only — its Data API resolves a link/playlist to title + artist and
// SoundCloud/Audius do the playback — so there is no cookie jar, no Proof-of-
// Origin sidecar, and no datacenter-IP bot check to lose to. `ytArgs` and the
// client-set fallback stay here for the opt-in `PROVIDER_CHAIN=...,youtube`
// last-resort player; without cookies it will usually be blocked, which is the
// accepted trade-off for dropping the cookie treadmill.
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

function mediaArgs(provider, clients) {
  if (provider === "youtube") return ytArgs({ clients });
  return [
    "--ignore-config", "--no-progress", "--no-call-home", "--no-playlist",
    "--retries", "5", "--fragment-retries", "5", "--socket-timeout", "20",
  ];
}

// ------------------------------------------------------------------ sourcing
const sourceLog = (event, details) => log(`${event} ${JSON.stringify(details)}`);
const httpClient = new HttpClient();
const spotifyClient = new SpotifyClient({
  http: httpClient,
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
  maxTracks: MAX_QUEUE,
});
const youtubeClient = new YouTubeClient({ http: httpClient, apiKey: process.env.YOUTUBE_API_KEY, maxTracks: MAX_QUEUE });
const audiusClient = new AudiusClient({ http: httpClient, apiKey: process.env.AUDIUS_API_KEY || "" });
const intentResolver = new IntentResolver([
  new SpotifyIntentResolver({ client: spotifyClient }),
  new YouTubeIntentResolver({ client: youtubeClient, logger: sourceLog }),
  new TextIntentResolver(),
]);
const scorer = new TrackScorer();
const providers = [
  new NullProvider({ name: "cache" }),
  new NullProvider({ name: "library" }),
  new SoundCloudProvider({ client: new YtDlpClient({ run: runYtDlp }), scorer }),
  new AudiusProvider({ client: audiusClient, scorer }),
  new YouTubeProvider(),
];
const providerChain = new ProviderChain({ providers, order: providerOrder(), logger: sourceLog });

function providerOrder() {
  return parseProviderOrder(process.env.PROVIDER_CHAIN);
}

async function expandQuery(query) { return intentResolver.resolve(query); }

// ----------------------------------------------------------------- the queue
const queue = [];
// Resolving metadata takes seconds, so a second advance can land while the
// first is mid-await. `pendingAdvance` makes the in-flight call re-check the
// queue on the way out instead of leaving a just-queued song stranded.
let advancing = false, pendingAdvance = false;

/** The playable source is resolved lazily, and the next entry is warmed while this one
 *  plays so /skip lands in well under a second instead of ~8. */
function resolveEntry(entry) {
  if (entry.resolution !== undefined) return Promise.resolve(entry.resolution);
  if (!entry.pending) {
    entry.pending = providerChain.resolve(entry.intent, { afterIndex: entry.providerIndex })
      .then(resolution => {
        entry.resolution = resolution;
        if (resolution) entry.providerIndex = resolution.providerIndex;
        return resolution;
      });
  }
  return entry.pending;
}
function prefetchNext() { if (queue[0]) void resolveEntry(queue[0]).catch(() => { }); }

function resetEntryResolution(entry) {
  entry.pending = null;
  entry.resolution = undefined;
}

function entryTitle(entry, resolution) {
  const intent = entry.intent;
  if (intent.title && intent.artist) return `${intent.title} — ${intent.artist}`;
  return intent.title || intent.query || resolution.candidate.title || intent.raw;
}

function streamMeta(entry, resolution) {
  const intent = entry.intent;
  return {
    title: intent.title || resolution.candidate.title || intent.query || intent.raw,
    artist: intent.artist || resolution.candidate.artist || null,
    durationMs: intent.durationMs || resolution.candidate.durationMs || null,
    imageUrl: intent.imageUrl || resolution.candidate.imageUrl || null,
    sourceUrl: intent.sourceUrl || resolution.candidate.sourceUrl || null,
    album: intent.album || null,
    origin: intent.source || "text",
    url: resolution.playable,
    provider: resolution.provider,
    providerIndex: resolution.providerIndex,
    candidateScore: resolution.candidate.score,
    entry,
  };
}

function statusDetails(meta) {
  return {
    title: meta.title, artist: meta.artist, origin: meta.origin, provider: meta.provider,
    durationMs: meta.durationMs, imageUrl: meta.imageUrl, sourceUrl: meta.sourceUrl,
    collectionName: meta.album, collectionKind: meta.album ? "album" : null,
    requestedBy: meta.entry.requestedBy,
  };
}

function remainingTrackMs(track) {
  const duration = Number(track?.meta.durationMs);
  if (!(duration > 0)) return null;
  if (!track.playbackStartedAt) return duration;
  const pausedNow = track.pausedStartedAt ? Date.now() - track.pausedStartedAt : 0;
  const elapsed = Date.now() - track.playbackStartedAt - track.accumulatedPausedMs - pausedNow;
  return Math.max(0, duration - elapsed);
}

function estimatedWaitMs(entries) {
  const durations = [];
  if (current) durations.push(remainingTrackMs(current));
  durations.push(...entries.map(entry => Number(entry.intent.durationMs || entry.resolution?.candidate.durationMs) || null));
  return durations.some(value => value === null) ? null : durations.reduce((sum, value) => sum + value, 0);
}

function totalDurationMs(intents) {
  const durations = intents.map(intent => Number(intent.durationMs)).filter(value => value > 0);
  return durations.length ? durations.reduce((sum, value) => sum + value, 0) : null;
}

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
    const previous = current;
    stopCurrent();
    while (queue.length) {
      const entry = queue.shift();
      const resolution = await resolveEntry(entry);
      if (!resolution) { log(`skipping ${JSON.stringify(entryTitle(entry, { candidate: {} }))} — could not resolve it`); continue; }
      if (beginStream(streamMeta(entry, resolution))) { prefetchNext(); return; }
      resetEntryResolution(entry);
      queue.unshift(entry);
    }
    unpublishCurrent();
    idleSince = Date.now();
    if (previous?.done && previous.bytes > 0) {
      statusReporter.report(previous.meta.entry.channelId, "finished", statusDetails(previous.meta));
    }
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

/** Spawn yt-dlp | ffmpeg for one playable reference. Returns false only if the
 *  spawn itself was impossible. YouTube retains its client-set retries; other
 *  empty sources fail over to the next provider. */
function beginStream(meta, attempt = 0) {
  stopCurrent();
  const clients = CLIENT_SETS[Math.min(attempt, CLIENT_SETS.length - 1)];
  const clientDetails = meta.provider === "youtube" ? ` clients=${clients}${attempt ? ` attempt=${attempt + 1}` : ""}` : "";
  log(`playing "${meta.title}" (${meta.url}) provider=${meta.provider}${clientDetails}`);

  let yt, ffmpeg;
  try {
    // SoundCloud (and other non-YouTube sources) serve the same track as both
    // progressive HTTP and HLS. Piping an HLS/m3u8 format to `-o -` produces an
    // empty file ("The downloaded file is empty"), and `bestaudio[acodec=opus]`
    // resolves to SoundCloud's HLS-only opus — so ask for a progressive stream
    // there and keep the opus-preferring selector for YouTube.
    const format = meta.provider === "youtube"
      ? AUDIO_FORMAT
      : "bestaudio[protocol^=http]/bestaudio[protocol^=https]/bestaudio/best";
    yt = spawn("yt-dlp", [...mediaArgs(meta.provider, clients), "-f", format, "-o", "-", meta.url], { stdio: ["ignore", "pipe", "pipe"] });
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
    stdoutPaused: false, bytes: 0, underruns: 0, startedAt: Date.now(), announced: false,
    playbackStartedAt: 0, pausedStartedAt: 0, accumulatedPausedMs: 0,
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
  yt.on("close", (code, signal) => log(`yt-dlp exited code=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""} for ${meta.provider}`));
  ffmpeg.on("close", (code, signal) => log(`ffmpeg exited code=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""} for ${meta.provider}`));
  yt.stderr.on("data", d => process.stderr.write(`[yt-dlp] ${d}`));
  ffmpeg.stderr.on("data", d => process.stderr.write(`[ffmpeg] ${d}`));

  ffmpeg.stdout.on("data", chunk => {
    if (current !== track) return;
    if (track.bytes === 0) {
      track.playbackStartedAt = Date.now();
      log(`first PCM from ffmpeg after ${Date.now() - track.startedAt}ms`);
      if (!track.announced) {
        track.announced = true;
        lastStatusChannelId = meta.entry.channelId || lastStatusChannelId;
        statusReporter.report(meta.entry.channelId, "playing", statusDetails(meta));
      }
    }
    track.bytes += chunk.length;
    track.pcm.push(chunk);
    if (!track.stdoutPaused && track.pcm.bytes >= HIGH_WATER_BYTES) {
      track.stdoutPaused = true;
      ffmpeg.stdout.pause();
    }
  });

  ffmpeg.on("close", () => {
    if (track.aborted || current !== track) return;
    if (track.bytes > 0) { track.eof = true; return; }   // the feeder drains the tail, then advances
    if (meta.provider === "youtube" && attempt + 1 < CLIENT_SETS.length) {
      log(`"${meta.title}" produced no audio with clients=${clients} — retrying`);
      beginStream(meta, attempt + 1);
      return;
    }
    log(`"${meta.title}" produced no audio with provider=${meta.provider} — trying the next provider`);
    sourceLog("source.failed", {
      intent: { title: meta.entry.intent.title, artist: meta.entry.intent.artist, raw: meta.entry.intent.raw },
      provider: meta.provider,
      score: meta.candidateScore,
      reason: "no_pcm",
    });
    void failoverSource(track);
  });

  publishTrack(meta.title);
  return true;
}

async function failoverSource(track) {
  const { entry, providerIndex } = track.meta;
  resetEntryResolution(entry);
  entry.providerIndex = providerIndex;
  const resolution = await resolveEntry(entry);
  if (track.aborted || current !== track) return;
  if (resolution) {
    beginStream(streamMeta(entry, resolution));
    prefetchNext();
    return;
  }
  log(`"${track.title}" exhausted the provider chain — skipping`);
  statusReporter.report(entry.channelId, "error", {
    title: entryTitle(entry, { candidate: {} }),
    origin: entry.intent.source,
    detail: "Não encontrei uma fonte reproduzível para esta faixa.",
  });
  track.done = true;
  current = null;
  void playNext();
}

function audioFilter() {
  // async=1 stretches/pads on timestamp gaps instead of letting the frame
  // clock slip, which is what keeps a long set in sync with the feeder.
  const chain = ["aresample=async=1:min_hard_comp=0.100:first_pts=0"];
  // Optional single-pass loudness levelling so a quiet track doesn't make
  // everyone reach for the volume knob mid-set.
  // Music masters are usually much hotter than speech captured by WebRTC.
  // Keep a conservative, normalized default so a listener's 100% slider is
  // usable; deployments may still set MUSIC_LOUDNORM=0 or tune MUSIC_VOLUME.
  if (process.env.MUSIC_LOUDNORM !== "0") chain.push("loudnorm=I=-18:TP=-2:LRA=11");
  const volume = Number(process.env.MUSIC_VOLUME || 0.15);
  if (volume > 0 && volume !== 1) chain.push(`volume=${volume}`);
  return chain.join(",");
}

// ------------------------------------------------------------------ commands
async function enqueue(query, { channelId, requestedBy } = {}) {
  const request = await expandQuery(query);
  const intents = request.intents;
  const collection = request.collection;
  const room = Math.max(0, MAX_QUEUE - queue.length);
  const wasPlaying = Boolean(current);
  const position = queue.length + 1;
  const etaMs = wasPlaying ? estimatedWaitMs(queue) : 0;
  const accepted = intents.slice(0, room).map(intent => ({
    intent, channelId, requestedBy, providerIndex: -1, resolution: undefined, pending: null,
  }));
  queue.push(...accepted);
  if (accepted.length < intents.length) log(`queue full — dropped ${intents.length - accepted.length} entries`);
  log(`queued ${accepted.length} item(s); ${queue.length} waiting`);
  lastStatusChannelId = channelId || lastStatusChannelId;
  if (accepted.length) {
    statusReporter.report(channelId, wasPlaying ? "queued" : "loading", {
      title: collection?.title || (intents.length === 1 ? entryTitle(accepted[0], { candidate: {} }) : query),
      artist: collection?.owner || (intents.length === 1 ? accepted[0].intent.artist : null),
      origin: intents.length === 1 ? intents[0].source : sourceFromQuery(query),
      count: accepted.length,
      position: wasPlaying ? position : 0,
      queueSize: queue.length,
      durationMs: accepted.length === 1 ? accepted[0].intent.durationMs : null,
      totalDurationMs: totalDurationMs(accepted.map(entry => entry.intent)),
      etaMs,
      imageUrl: collection?.imageUrl || accepted[0].intent.imageUrl,
      sourceUrl: collection?.sourceUrl || accepted[0].intent.sourceUrl,
      collectionName: collection?.title || accepted[0].intent.album,
      collectionKind: collection?.kind || (accepted[0].intent.album ? "album" : null),
      requestedBy,
      detail: collection?.description ? String(collection.description).replace(/<[^>]+>/g, "").trim().slice(0, 500) || null : null,
      items: accepted.map(entry => entry.intent),
    });
  } else {
    statusReporter.report(channelId, "error", { title: query, detail: "A fila está cheia." });
  }
  if (paused && current?.pausedStartedAt) {
    current.accumulatedPausedMs += Date.now() - current.pausedStartedAt;
    current.pausedStartedAt = 0;
  }
  paused = false;
  if (!current) await playNext(); else prefetchNext();
}

function sourceFromQuery(query) {
  if (/open\.spotify\.com/i.test(query)) return "spotify";
  if (/youtu(?:\.be|be\.com)/i.test(query)) return "youtube";
  return "text";
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
  lastStatusChannelId = null;
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
      if (data.command === "play") {
        await join(data.voice_channel_id);
        await enqueue(data.query, { channelId: data.channel_id, requestedBy: data.requested_by });
      } else if (data.command === "pause") {
        if (current && !paused) {
          paused = true;
          current.pausedStartedAt = Date.now();
          idleSince = Date.now();
          lastStatusChannelId = data.channel_id || lastStatusChannelId;
          statusReporter.report(data.channel_id, "paused", statusDetails(current.meta));
        }
      } else if (data.command === "resume") {
        if (current && paused) {
          if (current.pausedStartedAt) current.accumulatedPausedMs += Date.now() - current.pausedStartedAt;
          current.pausedStartedAt = 0;
          paused = false;
          idleSince = 0;
          lastStatusChannelId = data.channel_id || lastStatusChannelId;
          statusReporter.report(data.channel_id, "resumed", statusDetails(current.meta));
        }
      } else if (data.command === "skip") {
        if (current) statusReporter.report(data.channel_id, "skipped", statusDetails(current.meta));
        lastStatusChannelId = data.channel_id || lastStatusChannelId;
        paused = false;
        await playNext();
      } else if (data.command === "stop") {
        const statusChannelId = data.channel_id || current?.meta.entry.channelId || lastStatusChannelId;
        const kind = data.reason === "disconnected" || data.reason === "dj_left" ? "disconnected" : "stopped";
        statusReporter.report(statusChannelId, kind, current ? statusDetails(current.meta) : {});
        leaveVoice();
      } else if (data.command === "queue") {
        const upcoming = queue.slice(0, 5).map((entry, index) => `${index + 1}. ${entryTitle(entry, { candidate: {} })}`);
        statusReporter.report(data.channel_id, "queue", {
          title: current?.title || null,
          count: queue.length,
          totalDurationMs: totalDurationMs(queue.map(entry => ({ durationMs: entry.intent.durationMs || entry.resolution?.candidate.durationMs }))),
          imageUrl: current?.meta.imageUrl || queue[0]?.intent.imageUrl,
          sourceUrl: current?.meta.sourceUrl || queue[0]?.intent.sourceUrl,
          items: queue.map(entry => entry.intent),
          detail: upcoming.length ? null : "Nenhuma faixa aguardando.",
        });
      }
    } catch (error) {
      log(`${data.command} failed: ${error && error.message ? error.message : error}`);
      statusReporter.report(data.channel_id, "error", { title: data.query || null, detail: error && error.message ? error.message : String(error) });
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
    statusReporter.report(current?.meta.entry.channelId || lastStatusChannelId, "disconnected", current ? statusDetails(current.meta) : {});
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
log(`provider chain: ${providerOrder().join(" -> ")}`);
connect();
