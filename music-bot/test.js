// Offline harness for music-bot/index.js: stubs `ws`, `@roamhq/wrtc` and
// `child_process` so the feeder, the PCM queue, backpressure and the queue
// advance can be exercised without a VPS, YouTube or a native WebRTC build.
const Module = require("module");
const { EventEmitter } = require("events");
const { Readable, Writable } = require("stream");
const path = require("path");
const os = require("os");
const fs = require("fs");

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "test", "fixtures", name), "utf8"));

// ---------------------------------------------------------------- wrtc stub
const received = [];          // every Int16Array handed to onData, in order
let badFrames = 0;
class RTCAudioSourceStub {
  createTrack() { return { kind: "audio", stop() { } }; }
  onData({ samples, sampleRate, bitsPerSample, channelCount, numberOfFrames }) {
    if (samples.byteLength !== 1920 || sampleRate !== 48000 || bitsPerSample !== 16 || channelCount !== 2 || numberOfFrames !== 480) {
      badFrames++;
      throw new Error(`bad frame: byteLength=${samples.byteLength}`);
    }
    received.push({ at: Date.now(), samples });
  }
}
class RTCPeerConnectionStub extends EventEmitter {
  addTrack() { } close() { } getSenders() { return []; }
  async createOffer() { return { type: "offer", sdp: "" }; }
  async setLocalDescription() { } async setRemoteDescription() { }
  async createAnswer() { return { type: "answer", sdp: "" }; }
  async addIceCandidate() { }
}
const wrtcStub = { RTCPeerConnection: RTCPeerConnectionStub, nonstandard: { RTCAudioSource: RTCAudioSourceStub } };

// ------------------------------------------------------------------ ws stub
const sent = [];
let socket = null;
class WebSocketStub extends EventEmitter {
  constructor() { super(); this.readyState = 1; socket = this; setImmediate(() => this.emit("open")); }
  send(raw) { sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit("close"); }
}
WebSocketStub.OPEN = 1;
function deliver(op, data) { socket.emit("message", JSON.stringify({ v: 1, op, data })); }

// -------------------------------------------------------- child_process stub
// The "song": a ramp so any gap, reorder or duplication in the delivered PCM
// is detectable sample by sample.
const SONG_SAMPLES = 48000 * 2 * 2;           // 2 seconds, stereo
function makeSong(seed) {
  const pcm = new Int16Array(SONG_SAMPLES);
  for (let i = 0; i < pcm.length; i++) pcm[i] = ((i + seed * 7919) % 30000) - 15000;
  return Buffer.from(pcm.buffer);
}

const scenarios = new Map();   // videoId -> { title, song | null }
const spawned = [];

// Every HTTP integration is stubbed before index.js is loaded, keeping this
// harness independent of Spotify, Audius, YouTube and the host network.
global.fetch = async rawUrl => {
  const url = new URL(String(rawUrl));
  let body;
  if (url.hostname === "www.youtube.com" && url.pathname === "/oembed") {
    const videoUrl = url.searchParams.get("url") || "";
    const id = /v=([\w-]+)/.exec(videoUrl)?.[1];
    body = { title: scenarios.get(id)?.title || id || "YouTube playlist", author_name: null, thumbnail_url: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null };
  } else if (url.hostname === "api.audius.co" && url.pathname.endsWith("/tracks/search")) {
    body = { data: [] };
  } else {
    throw new Error(`unexpected fetch: ${url}`);
  }
  return { ok: true, status: 200, async json() { return body; } };
};

function fakeChild({ stdoutChunks, exitCode = 0, closeAfterStdout = true }) {
  const child = new EventEmitter();
  let i = 0;
  child.stdout = new Readable({
    read() {
      if (i >= stdoutChunks.length) { this.push(null); return; }
      this.push(stdoutChunks[i++]);
    },
  });
  child.stderr = new Readable({ read() { this.push(null); } });
  child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  child.kill = () => { child.killed = true; child.stdout.destroy(); };
  if (closeAfterStdout) child.stdout.on("end", () => setImmediate(() => child.emit("close", exitCode)));
  else setImmediate(() => child.emit("close", exitCode));
  return child;
}

function spawnStub(cmd, args) {
  spawned.push({ cmd, args });
  if (cmd === "yt-dlp") {
    if (args.includes("--version")) return fakeChild({ stdoutChunks: [Buffer.from("2026.08.01\n")] });
    const spec = args[args.length - 1];
    const id = /v=([\w-]+)/.exec(spec)?.[1] ?? spec.replace(/^ytsearch1:/, "");
    const scenario = scenarios.get(id);
    if (args.includes("--skip-download")) {
      if (!scenario) return fakeChild({ stdoutChunks: [], exitCode: 1 });
      return fakeChild({ stdoutChunks: [Buffer.from(`${id}\n${scenario.title}\n120\n`)] });
    }
    // The streaming call: yt-dlp's stdout is piped into ffmpeg's stdin, which
    // the ffmpeg stub ignores — it synthesises the decoded PCM itself.
    return fakeChild({ stdoutChunks: [Buffer.from("opus")], exitCode: scenario?.song ? 0 : 1 });
  }
  if (cmd === "ffmpeg") {
    const last = spawned.filter(s => s.cmd === "yt-dlp").pop();
    const id = /v=([\w-]+)/.exec(last.args[last.args.length - 1])?.[1];
    const song = scenarios.get(id)?.song;
    // Chunk it the way ffmpeg does — fast, bursty, far above realtime, which
    // is exactly the condition the high-water mark has to absorb.
    const chunks = [];
    if (song) for (let o = 0; o < song.length; o += 8192) chunks.push(song.subarray(o, Math.min(o + 8192, song.length)));
    return fakeChild({ stdoutChunks: chunks });
  }
  throw new Error(`unexpected spawn: ${cmd}`);
}

// ------------------------------------------------------------------- wiring
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "ws") return WebSocketStub;
  if (request === "@roamhq/wrtc") return wrtcStub;
  if (request === "child_process") return { spawn: spawnStub };
  return realLoad.apply(this, arguments);
};

process.env.MUSIC_BOT_TOKEN = "test";
// The streaming / pause / skip / stop harness below exercises the opt-in
// YouTube last-resort player. Production defaults to discovery-only
// (cache,library,soundcloud,audius) — see the parseProviderOrder regression
// check in sourceResolutionChecks().
process.env.PROVIDER_CHAIN = "cache,library,soundcloud,audius,youtube";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  await sourceResolutionChecks();
  require(path.join(__dirname, "index.js"));
  await sleep(50);

  const songA = makeSong(1), songB = makeSong(2);
  scenarios.set("AAAAAAAAAAA", { title: "Song A", song: songA });
  scenarios.set("BBBBBBBBBBB", { title: "Song B", song: songB });
  scenarios.set("CCCCCCCCCCC", { title: "Dead Song", song: null });   // the 403 case

  deliver("auth.ok", {});
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(300);

  check("published a music stream", sent.some(m => m.op === "stream.publish" && m.data.kind === "music"));
  const publish = sent.find(m => m.op === "stream.publish");
  check("stream label is the resolved title", publish?.data.label === "Song A", `got ${JSON.stringify(publish?.data.label)}`);
  check("joined the voice channel", sent.some(m => m.op === "call.join" && m.data.channel_id === "chan-1"));
  check("playing status waits for PCM and targets the invoking channel", sent.some(m => m.op === "music.status" && m.data.kind === "playing" && m.data.channel_id === "text-1" && m.data.title === "Song A"));

  // Reconnect / server-restart desync: a fresh auth.ok while we still believe
  // we're in a call must re-announce, and the reconciled snapshot must offer
  // music to a listener we have no connection to (otherwise they hear silence).
  const afterFirstPlay = sent.length;
  deliver("auth.ok", {});
  await sleep(30);
  check("re-announces call membership after a reconnect", sent.slice(afterFirstPlay).some(m => m.op === "call.join" && m.data.channel_id === "chan-1"));
  deliver("call.snapshot", { channel_id: "chan-1", participants: [{ user_id: "listener-9" }] });
  await sleep(30);
  check("offers music to a listener from the reconciled snapshot", sent.slice(afterFirstPlay).some(m => m.op === "rtc.offer" && m.data.to === "listener-9"));
  check("YouTube status carries the provider brand", sent.some(m => m.op === "music.status" && m.data.kind === "playing" && m.data.origin === "youtube"));

  // Queue a second track while the first plays: it must not restart playback.
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-2", query: "https://www.youtube.com/watch?v=BBBBBBBBBBB" });
  await sleep(100);
  check("queued status follows the channel of the second request", sent.some(m => m.op === "music.status" && m.data.kind === "queued" && m.data.channel_id === "text-2"));

  // 2s of audio, paced at realtime, plus prebuffer and the handover.
  await sleep(5200);

  const publishes = sent.filter(m => m.op === "stream.publish").map(m => m.data.label);
  check("second /play queued instead of restarting", publishes.length === 2 && publishes[0] === "Song A" && publishes[1] === "Song B", `publishes=${JSON.stringify(publishes)}`);
  check("next track posts playing status in its own request channel", sent.some(m => m.op === "music.status" && m.data.kind === "playing" && m.data.channel_id === "text-2" && m.data.title === "Song B"));
  check("no malformed frames reached onData", badFrames === 0, `${badFrames} bad`);

  // Frame pacing: 5.2s of feeder should be ~520 frames, never a burst.
  check("frames are paced near 100/s", received.length > 420 && received.length < 620, `${received.length} frames in 5.2s`);

  // Reassemble everything delivered and look for the two songs, contiguous.
  const all = new Int16Array(received.length * 960);
  received.forEach((f, i) => all.set(f.samples, i * 960));
  check("both songs arrived intact and in order", findSong(all, songA) >= 0 && findSong(all, songB) > findSong(all, songA),
    `A@${findSong(all, songA)} B@${findSong(all, songB)}`);

  // A source that yields no audio must burn through the client sets and skip
  // on without wedging the queue.
  const before = spawned.filter(s => s.cmd === "yt-dlp" && !s.args.includes("--skip-download") && !s.args.includes("--version")).length;
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=CCCCCCCCCCC" });
  await sleep(600);
  const attempts = spawned.filter(s => s.cmd === "yt-dlp" && !s.args.includes("--skip-download") && !s.args.includes("--version")).length - before;
  check("an empty stream retries every client set", attempts === 3, `${attempts} attempts`);
  check("recovered and went idle rather than wedging", sent.filter(m => m.op === "stream.unpublish").length >= 2);

  // yt-dlp invocation shape — the flags the 403 hunt actually turned on.
  const stream = spawned.filter(s => s.cmd === "yt-dlp" && s.args.includes("-o")).pop();
  const streamArgs = stream.args.join(" ");
  check("YouTube stream args: no --geo-bypass, has player_client, audio-only format",
    !stream.args.includes("--geo-bypass")
    && streamArgs.includes("player_client=")
    && stream.args[stream.args.indexOf("-f") + 1].startsWith("bestaudio"));
  check("YouTube runs cookieless (discovery-only, no PoToken)",
    !stream.args.includes("--cookies") && !streamArgs.includes("youtubepot"));

  // ---- pause/resume must hold the audio, not drop it on the floor.
  received.length = 0;
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(400);
  deliver("music.command", { command: "pause", voice_channel_id: "chan-1", channel_id: "text-1" });
  const atPause = received.length;
  await sleep(700);
  const duringPause = received.length - atPause;
  deliver("music.command", { command: "resume", voice_channel_id: "chan-1", channel_id: "text-1" });
  await sleep(2200);

  // The pause deliberately splices silence into the middle, so compare the
  // audible frames only: they must still spell out the whole song, in order.
  const audible = received.filter(f => f.samples.some(v => v !== 0));
  const heard = new Int16Array(audible.length * 960);
  audible.forEach((f, i) => heard.set(f.samples, i * 960));
  check("pause keeps emitting silence (RTP stays alive)", duringPause > 50, `${duringPause} frames during a 700ms pause`);
  check("resume continues the song with nothing dropped", findSong(heard, songA) >= 0, `A@${findSong(heard, songA)}`);
  check("pause and resume emit channel-scoped statuses", ["paused", "resumed"].every(kind => sent.some(m => m.op === "music.status" && m.data.kind === kind && m.data.channel_id === "text-1")));

  // ---- skip must jump to the next track right away.
  received.length = 0;
  const publishesBefore = sent.filter(m => m.op === "stream.publish").length;
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(200);
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-queue", query: "https://www.youtube.com/watch?v=BBBBBBBBBBB" });
  await sleep(200);
  deliver("music.command", { command: "queue", voice_channel_id: "chan-1", channel_id: "text-control" });
  await sleep(50);
  check("queue command reports the actual pending count", sent.some(m => m.op === "music.status" && m.data.kind === "queue" && m.data.channel_id === "text-control" && m.data.count === 1));
  deliver("music.command", { command: "skip", voice_channel_id: "chan-1", channel_id: "text-1" });
  await sleep(300);
  const labels = sent.filter(m => m.op === "stream.publish").slice(publishesBefore).map(m => m.data.label);
  check("skip advances to the queued track", labels[labels.length - 1] === "Song B", `labels=${JSON.stringify(labels)}`);
  check("skip emits an explicit status", sent.some(m => m.op === "music.status" && m.data.kind === "skipped" && m.data.channel_id === "text-1"));

  // ---- stop cancels both the current stream and every queued item.
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-stop", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(100);
  const publishesAtStop = sent.filter(m => m.op === "stream.publish").length;
  deliver("music.command", { command: "stop", voice_channel_id: "chan-1", channel_id: "text-stop" });
  await sleep(350);
  check("stop publishes a stopped status in the control channel", sent.some(m => m.op === "music.status" && m.data.kind === "stopped" && m.data.channel_id === "text-stop"));
  check("stop leaves voice and cancels queued playback", sent.some(m => m.op === "call.leave" && m.data.channel_id === "chan-1") && sent.filter(m => m.op === "stream.publish").length === publishesAtStop);

  // ---- a server-side disconnect has no text channel in the command; the bot
  // must remember the active track's originating channel for the final card.
  deliver("music.command", { command: "play", voice_channel_id: "chan-2", channel_id: "text-disconnect", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(300);
  deliver("music.command", { command: "stop", voice_channel_id: "chan-2", reason: "disconnected" });
  await sleep(100);
  check("disconnect reports back to the active track channel", sent.some(m => m.op === "music.status" && m.data.kind === "disconnected" && m.data.channel_id === "text-disconnect"));
  check("disconnect fully leaves the bot voice session", sent.some(m => m.op === "call.leave" && m.data.channel_id === "chan-2"));

  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
}

async function sourceResolutionChecks() {
  const { TrackScorer } = require("./src/matching/track-scorer");
  const { SoundCloudProvider } = require("./src/providers/soundcloud-provider");
  const { AudiusProvider } = require("./src/providers/audius-provider");
  const { ProviderChain } = require("./src/providers/provider-chain");
  const { SpotifyIntentResolver } = require("./src/intents/spotify-intent-resolver");
  const { YouTubeIntentResolver } = require("./src/intents/youtube-intent-resolver");
  const { YouTubeClient } = require("./src/infrastructure/youtube-client");
  const { MusicStatusReporter } = require("./src/status/music-status-reporter");
  const scorer = new TrackScorer();
  const intent = { title: "Heresia", artist: "Djonga", durationMs: 170900, raw: "spotify:track:test" };
  const soundcloudFixture = fixture("soundcloud-search.json");
  const soundcloud = new SoundCloudProvider({ client: { async searchSoundCloud() { return soundcloudFixture.entries; } }, scorer });
  const soundcloudResult = await soundcloud.resolve(intent);
  check("Djonga selects a 170.9s SoundCloud candidate", Math.abs(soundcloudResult.candidate.durationMs - 170900) <= 100);
  check("rejects the 30s licensed SNIP", soundcloudResult.rejected.some(value => value.reason === "policy_snip"));
  check("rejects the 1996s full album", soundcloudResult.rejected.some(value => value.reason === "duration_delta"));

  const audiusFixture = fixture("audius-search.json");
  const audius = new AudiusProvider({
    client: { async search() { return audiusFixture.data; }, streamUrl(id) { return `https://api.audius.co/v1/tracks/${id}/stream`; } },
    scorer,
  });
  const audiusResult = await audius.resolve(intent);
  check("Audius prefers the original over a nightcore variant", audiusResult.candidate.ref === "audius-heresy");

  const attempts = [];
  const fakeProvider = name => ({
    name,
    async resolve() { attempts.push(name); return { candidate: { provider: name, ref: name, title: name, score: 1 }, rejected: [] }; },
    open(ref) { return ref; },
  });
  const chain = new ProviderChain({ providers: [fakeProvider("soundcloud"), fakeProvider("audius"), fakeProvider("youtube")], order: ["soundcloud", "audius", "youtube"] });
  const first = await chain.resolve(intent);
  const second = await chain.resolve(intent, { afterIndex: first.providerIndex });
  const third = await chain.resolve(intent, { afterIndex: second.providerIndex });
  check("failover advances soundcloud -> audius -> youtube", [first.provider, second.provider, third.provider].join(",") === "soundcloud,audius,youtube");

  const { parseProviderOrder } = require("./src/providers/provider-chain");
  check("default provider chain is discovery-only (no YouTube playback)",
    !parseProviderOrder(undefined).includes("youtube")
    && parseProviderOrder("cache,library,soundcloud,audius").join(",") === "cache,library,soundcloud,audius"
    && parseProviderOrder("soundcloud,audius,youtube").includes("youtube")
    && parseProviderOrder('["soundcloud","youtube"]').join(",") === "soundcloud,youtube");

  const spotifyFixture = fixture("spotify-playlist.json");
  const spotify = new SpotifyIntentResolver({ client: { async getCollection() { return spotifyFixture.items.map(value => value.item); } } });
  const spotifyRequest = await spotify.resolve("https://open.spotify.com/playlist/playlist123");
  check("Spotify playlist expands to N intents", spotifyRequest.intents.length === spotifyFixture.items.length);
  check("Spotify intents preserve ISRC", spotifyRequest.intents.every(value => value.isrc));
  const spotifyRich = new SpotifyIntentResolver({ client: { async getCollection() {
    return {
      tracks: [{ ...spotifyFixture.items[0].item, album: { name: "Album A", images: [{ url: "https://img.test/album-a.jpg" }] }, external_urls: { spotify: "https://open.spotify.com/track/a" } }],
      collection: { kind: "playlist", title: "Playlist A", imageUrl: "https://img.test/playlist-a.jpg", itemCount: 1 },
    };
  } } });
  const spotifyRichRequest = await spotifyRich.resolve("https://open.spotify.com/playlist/playlist123");
  check("Spotify preserves collection and album artwork", spotifyRichRequest.collection.title === "Playlist A" && spotifyRichRequest.intents[0].imageUrl === "https://img.test/album-a.jpg");

  // When the Web API refuses a playlist (public user playlists 403/404 now,
  // editorial "37i9…" always), the public embed page still resolves it.
  const { SpotifyClient } = require("./src/infrastructure/spotify-client");
  const apiThrows404 = async url => {
    if (url.includes("accounts.spotify.com/api/token")) return { access_token: "t", expires_in: 3600 };
    const error = new Error("HTTP 404 for api.spotify.com"); error.status = 404; throw error;
  };
  const embedEntity = {
    type: "playlist", name: "A Voz do Brasil", subtitle: "Vitor Hugo",
    coverArt: { sources: [{ url: "https://img.test/small.jpg" }, { url: "https://img.test/cover.jpg" }] },
    trackList: [
      { uri: "spotify:track:aaaaaaaaaaaaaaaaaaaaaa", title: "Apesar De Você", subtitle: "Clara Nunes", duration: 224000 },
      { uri: "spotify:track:bbbbbbbbbbbbbbbbbbbbbb", title: "Azul", subtitle: "Gal Costa", duration: 224000 },
    ],
  };
  const embedNext = JSON.stringify({ props: { pageProps: { state: { data: { entity: embedEntity } } } } });
  const embedHtml = `<html><body><script id="__NEXT_DATA__" type="application/json">${embedNext}</script></body></html>`;
  const embedSpotify = new SpotifyClient({ clientId: "id", clientSecret: "secret", http: { json: apiThrows404, async text() { return embedHtml; } } });
  const embedResult = await embedSpotify.getCollection("playlist", "72uTpSoHV28ujv7m7NsDZ6");
  check("a playlist the Web API blocks still resolves via the public embed",
    embedResult.tracks.length === 2
    && embedResult.tracks[0].name === "Apesar De Você"
    && embedResult.tracks[0].artists[0].name === "Clara Nunes"
    && embedResult.tracks[0].duration_ms === 224000
    && embedResult.tracks[0].external_urls.spotify === "https://open.spotify.com/track/aaaaaaaaaaaaaaaaaaaaaa"
    && embedResult.collection.title === "A Voz do Brasil"
    && embedResult.collection.imageUrl === "https://img.test/cover.jpg",
    JSON.stringify(embedResult.collection));

  const deadSpotify = new SpotifyClient({ clientId: "id", clientSecret: "secret", http: { json: apiThrows404, async text() { return "<html></html>"; } } });
  let deadMessage = null;
  try { await deadSpotify.getCollection("playlist", "private123"); } catch (error) { deadMessage = error.message; }
  check("a playlist neither the API nor the embed can read yields an actionable message", /p[uú]blica/i.test(deadMessage || ""), deadMessage);

  const youtube = new YouTubeIntentResolver({ client: { apiKey: "", async oEmbed() { throw new Error("offline"); } } });
  const degraded = await youtube.resolve("https://www.youtube.com/playlist?list=PL123");
  check("YouTube playlist degrades without YOUTUBE_API_KEY", degraded.intents.length === 1 && degraded.intents[0].query.includes("youtube.com"));

  const oEmbedFixture = fixture("youtube-oembed.json");
  const youtubeVideo = new YouTubeIntentResolver({ client: { async oEmbed() { return oEmbedFixture; } } });
  const videoIntents = await youtubeVideo.resolve("https://www.youtube.com/watch?v=AAAAAAAAAAA");
  check("YouTube oEmbed becomes a metadata-only intent", videoIntents.intents[0].title === oEmbedFixture.title && videoIntents.intents[0].durationMs === null);

  let playlistIdFromWatchUrl = null;
  const youtubeWatchPlaylist = new YouTubeIntentResolver({ client: {
    apiKey: "test-key",
    async playlist(id) { playlistIdFromWatchUrl = id; return { intents: [{ title: "Track in playlist" }], collection: { kind: "playlist" } }; },
  } });
  await youtubeWatchPlaylist.resolve("https://www.youtube.com/watch?v=AAAAAAAAAAA&list=PL123");
  check("YouTube watch URLs with a list expand the playlist", playlistIdFromWatchUrl === "PL123");

  const youtubePlaylistFixture = fixture("youtube-playlist.json");
  const youtubeClient = new YouTubeClient({
    apiKey: "test-key",
    maxTracks: 10,
    http: { async json(url) {
      if (url.includes("/playlists?")) return {
        items: [{ snippet: { title: "Playlist A", channelTitle: "Channel A", thumbnails: { high: { url: "https://img.test/playlist.jpg" } } }, contentDetails: { itemCount: 2 } }],
      };
      if (url.includes("/videos?")) return {
        items: youtubePlaylistFixture.items.map(item => ({
          id: item.contentDetails.videoId,
          snippet: { ...item.snippet, thumbnails: { high: { url: `https://img.test/${item.contentDetails.videoId}.jpg` } } },
          contentDetails: { duration: item.contentDetails.videoId === "AAAAAAAAAAA" ? "PT2M50S" : "PT3M1S" },
        })),
      };
      return youtubePlaylistFixture;
    } },
  });
  const playlistRequest = await youtubeClient.playlist("PL123");
  check("YouTube Data API playlist expands to N intents", playlistRequest.intents.length === youtubePlaylistFixture.items.length);
  check("YouTube playlist includes real duration and thumbnail metadata", playlistRequest.intents.every(value => value.durationMs > 0 && value.imageUrl) && playlistRequest.collection.imageUrl);

  const reported = [];
  const reporter = new MusicStatusReporter({ send(op, data) { reported.push({ op, data }); }, createId() { return "status-1"; } });
  reporter.report("text-a", "playing", {
    origin: "spotify", title: "Song A", artist: "Artist A", durationMs: 170900,
    imageUrl: "https://img.test/cover.jpg", requestedBy: "user-a",
    totalDurationMs: 351900, etaMs: 120000, items: spotifyRichRequest.intents,
  });
  check("status reporter preserves channel and Spotify brand", reported[0]?.op === "music.status" && reported[0]?.data.channel_id === "text-a" && reported[0]?.data.origin === "spotify");
  check("status reporter carries rich queue metadata", reported[0]?.data.duration_ms === 170900 && reported[0]?.data.image_url === "https://img.test/cover.jpg" && reported[0]?.data.requested_by === "user-a");
  check("status reporter carries playlist duration and item previews", reported[0]?.data.total_duration_ms === 351900 && reported[0]?.data.eta_ms === 120000 && reported[0]?.data.items.length === 1);
}

/** Index of `song` inside `haystack`, or -1. Compares a distinctive run. */
function findSong(haystack, song) {
  const full = new Int16Array(song.buffer, song.byteOffset, song.byteLength / 2);
  outer: for (let i = 0; i + full.length <= haystack.length; i++) {
    // Cheap 64-sample probe, then confirm the whole thing so an
    // underrun-shredded copy can't pass. The two test songs deliberately share
    // a short run, so a probe miss must keep scanning rather than give up.
    for (let j = 0; j < 64; j++) if (haystack[i + j] !== full[j]) continue outer;
    for (let j = 64; j < full.length; j++) if (haystack[i + j] !== full[j]) continue outer;
    return i;
  }
  return -1;
}

main().catch(error => { console.error(error); process.exit(1); });
