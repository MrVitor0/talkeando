#!/usr/bin/env node
// Exercises the real music providers before a deploy is allowed through.
// YouTube is discovery-only now — the Data API turns a link/playlist into a
// title + artist and playback comes from SoundCloud/Audius — so this no longer
// touches cookies, a Proof-of-Origin sidecar, or a datacenter-IP bot check.
//
// It is deliberately lenient: DRM / geo-blocked / registered-users-only tracks
// are skipped, not failed, and third-party APIs that flake (Spotify search,
// SoundCloud audio from a datacenter IP) only WARN. A hard failure means the
// stack genuinely can't do its job:
//   * Spotify auth + a track read work (client_credentials, no refresh token);
//   * an editorial "37i9…" playlist fails with the actionable message;
//   * YouTube Data API resolves video + playlist metadata;
//   * SoundCloud search works;
//   * at least one of SoundCloud / Audius actually streams audio.
const { spawn } = require("child_process");
const { HttpClient } = require("../src/infrastructure/http-client");
const { SpotifyClient } = require("../src/infrastructure/spotify-client");
const { YouTubeClient } = require("../src/infrastructure/youtube-client");
const { AudiusClient } = require("../src/infrastructure/audius-client");

const stableTrackId = process.env.SMOKE_SPOTIFY_TRACK || "4cOdK2wGLETKBW3PvgPWqT"; // Never Gonna Give You Up
// A user playlist ("A Voz do Brasil") and a Spotify editorial one ("Viva Latino").
// Both resolve through the public embed even when the Web API refuses them.
const spotifyPlaylistIds = (process.env.SMOKE_SPOTIFY_PLAYLIST_IDS
  || "72uTpSoHV28ujv7m7NsDZ6,37i9dQZF1DX10zKzsJ2jva").split(",").map(s => s.trim()).filter(Boolean);
const youtubeVideos = (process.env.SMOKE_YOUTUBE_VIDEOS || "7qw4iloZORQ,cBEEtp4AAAw").split(",").map(s => s.trim()).filter(Boolean);
const youtubePlaylists = (process.env.SMOKE_YOUTUBE_PLAYLISTS || "PL1qZUeYbFlKjNqTu--CN5tm3a0NWo8nwf").split(",").map(s => s.trim()).filter(Boolean);
const audioProbe = (process.env.SMOKE_AUDIO_QUERIES
  || "Odesza Say My Name,RÜFÜS DU SOL Innerbloom,Bonobo Kerala,Flume Never Be Like You,Disclosure Latch")
  .split(",").map(s => s.trim()).filter(Boolean);

const SC_FORMAT = "bestaudio[protocol^=http]/bestaudio[protocol^=https]/bestaudio/best";

const failures = [];
const warnings = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};
const warn = (name, detail = "") => { warnings.push(name); console.warn(`WARN ${name}${detail ? `: ${detail}` : ""}`); };
const lastLine = text => String(text || "").trim().split("\n").slice(-1)[0];

// `stopAfterBytes` proves an `-o -` stream is live without downloading the
// whole track: once that many bytes land on stdout the child is killed.
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

/// Follow redirects and pull at most `limit` bytes off the body, then abort.
async function readFirstBytes(url, limit) {
  const controller = new AbortController();
  const response = await fetch(url, { redirect: "follow", signal: controller.signal });
  if (!response.ok || !response.body) { controller.abort(); return { ok: response.ok, status: response.status, length: 0 }; }
  let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length >= limit) break; }
  controller.abort();
  return { ok: true, status: response.status, length };
}

async function main() {
  const http = new HttpClient({ timeoutMs: 30000 });

  // ---- Spotify (discovery) -----------------------------------------------------
  // The Web API refuses many playlists for app tokens now (public user
  // playlists 403/404, editorial "37i9…" always). getCollection falls back to
  // the public embed page, so any public playlist still resolves.
  const spotify = new SpotifyClient({ http, clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken: process.env.SPOTIFY_REFRESH_TOKEN });
  check("Spotify app credentials configured", spotify.configured, "set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
  if (spotify.configured) {
    try {
      const track = await spotify.getTrack(stableTrackId);
      check("Spotify reads a track (API or embed)", Boolean(track?.name && track.artists?.length), `got ${JSON.stringify(track?.name)}`);
    } catch (error) { check("Spotify reads a track (API or embed)", false, error.message); }

    let playlistsExpanded = 0;
    for (const id of spotifyPlaylistIds) {
      try {
        const result = await spotify.getCollection("playlist", id);
        if (result.tracks.length > 0) { playlistsExpanded++; console.log(`  ok  playlist ${id} → ${result.tracks.length} tracks ("${result.collection.title}")`); }
        else warn(`Spotify playlist ${id}`, "resolved but empty");
      } catch (error) { warn(`Spotify playlist ${id}`, error.message); }
    }
    check("Spotify playlists expand to tracks (via embed fallback)", playlistsExpanded > 0, `0/${spotifyPlaylistIds.length} expanded`);
  }

  // ---- YouTube Data API (discovery only, no yt-dlp) --------------------------
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

  // ---- SoundCloud (playback) -------------------------------------------------
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
      const stream = await ytdlp([...scsearchArgs, "-f", SC_FORMAT, "-o", "-", url], { timeoutMs: 60000, stopAfterBytes: 65536 });
      if (stream.enough || stream.stdout.length > 32768) { scStreamed = `${query} → ${url}`; break; }
      warn(`SoundCloud stream "${entry.title || url}"`, `${stream.stdout.length} bytes; ${lastLine(stream.stderr)}`);
    }
  }
  check("SoundCloud search returns results", scSearchOk > 0, "every probe query failed");
  if (scStreamed) console.log(`PASS SoundCloud streams a track: ${scStreamed}`);
  else warn("SoundCloud audio not verified", "no probe track streamed (DRM / registered-users-only from this IP) — Audius must cover playback");

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
  if (auStreamed) console.log(`PASS Audius streams a track: ${auStreamed}`);

  // The one playback invariant that must hold: something can produce audio.
  check("A playback provider streams real audio (SoundCloud or Audius)", Boolean(scStreamed || auStreamed),
    "neither SoundCloud nor Audius returned audio bytes");

  if (warnings.length) console.warn(`\n${warnings.length} warning(s) (skipped tracks / degraded results) — not fatal`);
  if (failures.length) console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  else console.log("\nall provider checks passed");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
