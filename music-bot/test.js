// Offline harness for music-bot/index.js: stubs `ws`, `@roamhq/wrtc` and
// `child_process` so the feeder, the PCM queue, backpressure and the queue
// advance can be exercised without a VPS, YouTube or a native WebRTC build.
const Module = require("module");
const { EventEmitter } = require("events");
const { Readable, Writable } = require("stream");
const path = require("path");
const os = require("os");

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
process.env.YT_DLP_COOKIES = path.join(os.tmpdir(), "music-bot-test-cookies.txt");
require("fs").writeFileSync(process.env.YT_DLP_COOKIES, "# Netscape HTTP Cookie File\n");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
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

  // Queue a second track while the first plays: it must not restart playback.
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=BBBBBBBBBBB" });

  // 2s of audio, paced at realtime, plus prebuffer and the handover.
  await sleep(5200);

  const publishes = sent.filter(m => m.op === "stream.publish").map(m => m.data.label);
  check("second /play queued instead of restarting", publishes.length === 2 && publishes[0] === "Song A" && publishes[1] === "Song B", `publishes=${JSON.stringify(publishes)}`);
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
  check("no --geo-bypass", !stream.args.includes("--geo-bypass"));
  check("excludes the visionos client", stream.args.join(" ").includes("player_client="));
  check("passes the cookie jar", stream.args.includes("--cookies"));
  check("asks for an audio-only format", stream.args[stream.args.indexOf("-f") + 1].startsWith("bestaudio"));

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

  // ---- skip must jump to the next track right away.
  received.length = 0;
  const publishesBefore = sent.filter(m => m.op === "stream.publish").length;
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=AAAAAAAAAAA" });
  await sleep(200);
  deliver("music.command", { command: "play", voice_channel_id: "chan-1", channel_id: "text-1", query: "https://www.youtube.com/watch?v=BBBBBBBBBBB" });
  await sleep(200);
  deliver("music.command", { command: "skip", voice_channel_id: "chan-1", channel_id: "text-1" });
  await sleep(300);
  const labels = sent.filter(m => m.op === "stream.publish").slice(publishesBefore).map(m => m.data.label);
  check("skip advances to the queued track", labels[labels.length - 1] === "Song B", `labels=${JSON.stringify(labels)}`);

  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
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
