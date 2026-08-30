#!/usr/bin/env node
// Exercises the real music providers before a deploy is allowed through.
// YouTube is discovery-only now — the Data API turns a link/playlist into a
// title + artist and playback comes from SoundCloud/Audius — so this no longer
// touches cookies, a Proof-of-Origin sidecar, or a datacenter-IP bot check.
//
// It is deliberately lenient about individual tracks: a DRM-protected /
// geo-blocked / preview-only result is skipped, not failed, and the audio
// checks only need ONE playable result across every probe. A hard failure
// therefore means a provider is actually broken (auth, search, or the whole
// catalogue unreachable), which is worth blocking a deploy on.
//   * Spotify: a public playlist expands to tracks (client_credentials, no
//     SPOTIFY_REFRESH_TOKEN needed);
//   * Spotify: an editorial "37i9…" playlist fails with the actionable message;
//   * YouTube Data API: video + playlist metadata resolve;
//   * SoundCloud: `yt-dlp` search works and at least one track streams;
//   * Audius: search works and at least one track streams.
const { spawn } = require("child_process");
const { HttpClient } = require("../src/infrastructure/http-client");
const { SpotifyClient } = require("../src/infrastructure/spotify-client");
const { YouTubeClient } = require("../src/infrastructure/youtube-client");
const { AudiusClient } = require("../src/infrastructure/audius-client");

const youtubeVideos = (process.env.SMOKE_YOUTUBE_VIDEOS || "7qw4iloZORQ,cBEEtp4AAAw").split(",").map(s => s.trim()).filter(Boolean);
const youtubePlaylists = (process.env.SMOKE_YOUTUBE_PLAYLISTS || "PL1qZUeYbFlKjNqTu--CN5tm3a0NWo8nwf").split(",").map(s => s.trim()).filter(Boolean);
const editorialPlaylistId = process.env.SMOKE_SPOTIFY_EDITORIAL || "37i9dQZEVXbjtrVpztYEcP";
const audioProbe = (process.env.SMOKE_AUDIO_QUERIES
  || "Odesza Say My Name,RÜFÜS DU SOL Innerbloom,ODESZA A Moment Apart,Bonobo Kerala,Flume Never Be Like You")
  .split(",").map(s => s.trim()).filter(Boolean);

// yt-dlp stderr fragments that mean "this particular track can't be streamed" —
// try the next candidate rather than failing the provider.
const SKIPPABLE = /\b(drm|not available|unavailable|geo|region|private|removed|deleted|requested format is not available|only available|sign in|login required|http error 4)\b/i;

const failures = [];
const warnings = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};
const warn = (name, detail = "") => { warnings.push(name); console.warn(`WARN ${name}${detail ? `: ${detail}` : ""}`); };
const lastLine = text => String(text || "").trim().split("\n").slice(-1)[0];

// `stopAfterBytes` lets an `-o -` stream be proven live without downloading the
// whole track: once that many bytes land on stdout the child is killed and the
// run counts as a success (`enough: true`).
function ytdlp(args, { timeoutMs = 60000, stopAfterBytes = 0 } = {}) {
  return new Promise(resolve => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let enough = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", chunk => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stopAfterBytes && stdout.length >= stopAfterBytes && !enough) { enough = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message, enough }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr, enough }); });
  });
}

const scsearchArgs = ["--ignore-config", "--no-progress", "--no-call-home", "--no-playlist", "--socket-timeout", "20"];

/// Follow redirects and pull at most `limit` bytes off the response body, then
/// abort — enough to prove the endpoint actually serves audio.
async function readFirstBytes(url, limit) {
  const controller = new AbortController();
  const response = await fetch(url, { redirect: "follow", signal: controller.signal });
  if (!response.ok || !response.body) { controller.abort(); return { ok: response.ok, status: response.status, length: 0 }; }
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length >= limit) break;
  }
  controller.abort();
  return { ok: true, status: response.status, length };
}

/// Candidate playlist ids for the "expands to tracks" check. Editorial "37i9…"
/// playlists are API-blocked, and a fixed user playlist can be deleted, so
/// search a few genres and hand back everything found — the caller tries each
/// until one works.
async function spotifyPlaylistCandidates(spotify) {
  const configured = (process.env.SMOKE_SPOTIFY_PLAYLIST_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  const ids = new Set();
  for (const query of ["indie", "house music", "hip hop", "workout", "study"]) {
    try {
      for (const playlist of await spotify.searchPlaylists(query, 20)) {
        if (playlist && playlist.id) ids.add(playlist.id);
      }
    } catch (error) { warn(`Spotify playlist search "${query}"`, error.message); }
    if (ids.size >= 12) break;
  }
  return [...ids];
}

async function main() {
  const http = new HttpClient({ timeoutMs: 30000 });

  // ---- Spotify (discovery) --------------------------------------------------
  const spotify = new SpotifyClient({ http, clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken: process.env.SPOTIFY_REFRESH_TOKEN });
  check("Spotify app credentials configured", spotify.configured, "set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
  if (spotify.configured) {
    const candidates = await spotifyPlaylistCandidates(spotify);
    check("Spotify playlist search returned candidates", candidates.length > 0, "no playlists in search results");
    let expanded = 0;
    let lastError = "";
    for (const id of candidates) {
      if (expanded >= 2) break;
      try {
        const result = await spotify.getCollection("playlist", id);
        if (result.tracks.length > 0) { expanded++; console.log(`  ok  playlist ${id} → ${result.tracks.length} tracks`); }
      } catch (error) { lastError = error.message; }
    }
    check("Spotify public playlist expands to tracks", expanded > 0, `tried ${candidates.length} playlists; last error: ${lastError}`);

    try {
      await spotify.getCollection("playlist", editorialPlaylistId);
      check("Editorial Spotify playlist is rejected with a clear message", false, "expected a rejection, got tracks");
    } catch (error) {
      check("Editorial Spotify playlist is rejected with a clear message", /privada ou n[aã]o pode ser usada/i.test(error.message), error.message);
    }
  }

  // ---- YouTube Data API (discovery only, no yt-dlp) ------------------------
  const youtube = new YouTubeClient({ http, apiKey: process.env.YOUTUBE_API_KEY, maxTracks: 50 });
  check("YouTube API key configured", Boolean(process.env.YOUTUBE_API_KEY));
  if (process.env.YOUTUBE_API_KEY) {
    let videoOk = 0;
    for (const id of youtubeVideos) {
      try { const intent = await youtube.video(id); if (intent?.title && intent.durationMs) videoOk++; }
      catch (error) { warn(`YouTube metadata ${id}`, error.message); }
    }
    check("YouTube Data API resolves video metadata", videoOk > 0, `0/${youtubeVideos.length} videos resolved`);
    let playlistOk = 0;
    for (const id of youtubePlaylists) {
      try { const result = await youtube.playlist(id); if (result.intents.length > 0) playlistOk++; }
      catch (error) { warn(`YouTube playlist ${id}`, error.message); }
    }
    check("YouTube Data API expands a playlist", playlistOk > 0, `0/${youtubePlaylists.length} playlists expanded`);
  }

  // ---- SoundCloud (playback) ---------------------------------------------------
  let scSearchOk = 0;
  let scStreamed = null;
  for (const query of audioProbe) {
    if (scStreamed) break;
    const listing = await ytdlp([...scsearchArgs, "--skip-download", "--dump-single-json", `scsearch5:${query}`], { timeoutMs: 45000 });
    let entries = [];
    try { entries = JSON.parse(listing.stdout.toString() || "{}").entries || []; } catch { /* handled below */ }
    if (listing.code === 0 && entries.length > 0) scSearchOk++;
    else { warn(`SoundCloud search "${query}"`, lastLine(listing.stderr)); continue; }
    for (const entry of entries.slice(0, 4)) {
      const url = entry?.webpage_url || entry?.url;
      if (!url) continue;
      const stream = await ytdlp([...scsearchArgs, "-f", "bestaudio/best", "-o", "-", url], { timeoutMs: 60000, stopAfterBytes: 65536 });
      if (stream.enough || stream.stdout.length > 32768) { scStreamed = `${query} → ${url}`; break; }
      if (SKIPPABLE.test(stream.stderr)) { warn(`SoundCloud skip "${entry.title || url}"`, lastLine(stream.stderr)); continue; }
      warn(`SoundCloud stream "${entry.title || url}"`, `${stream.stdout.length} bytes; ${lastLine(stream.stderr)}`);
    }
  }
  check("SoundCloud search returns results", scSearchOk > 0, "every probe query failed");
  check("SoundCloud streams at least one track", Boolean(scStreamed), "no probe track produced audio (all DRM / unavailable?)");
  if (scStreamed) console.log(`  ok  streamed ${scStreamed}`);

  // ---- Audius (playback) ----------------------------------------------------
  const audius = new AudiusClient({ http, apiKey: process.env.AUDIUS_API_KEY || "" });
  let auSearchOk = 0;
  let auStreamed = null;
  for (const query of audioProbe) {
    if (auStreamed) break;
    let tracks = [];
    try { tracks = await audius.search(query, 8); } catch (error) { warn(`Audius search "${query}"`, error.message); continue; }
    if (tracks.length > 0) auSearchOk++; else continue;
    for (const track of tracks.slice(0, 4)) {
      if (!track?.id) continue;
      try {
        const bytes = await readFirstBytes(audius.streamUrl(track.id), 65536);
        if (bytes.ok && bytes.length > 32768) { auStreamed = `${query} → ${track.title || track.id}`; break; }
        warn(`Audius stream "${track.title || track.id}"`, `HTTP ${bytes.status}, ${bytes.length} bytes`);
      } catch (error) { warn(`Audius stream "${track.title || track.id}"`, error.message); }
    }
  }
  check("Audius search returns results", auSearchOk > 0, "every probe query failed");
  check("Audius streams at least one track", Boolean(auStreamed), "no probe track produced audio");
  if (auStreamed) console.log(`  ok  streamed ${auStreamed}`);

  if (warnings.length) console.warn(`\n${warnings.length} warning(s) (skipped tracks / degraded results) — not fatal`);
  if (failures.length) console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  else console.log("\nall provider checks passed");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
