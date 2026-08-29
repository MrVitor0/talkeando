#!/usr/bin/env node
// Exercises the real music providers before a deploy is allowed through.
// YouTube is discovery-only now — the Data API turns a link/playlist into a
// title + artist and playback comes from SoundCloud/Audius — so this no longer
// touches cookies, a Proof-of-Origin sidecar, or a datacenter-IP bot check.
// What it proves, all against live services, without printing any secret:
//   * Spotify: a public user playlist expands to tracks (client_credentials,
//     no SPOTIFY_REFRESH_TOKEN needed);
//   * Spotify: an editorial "37i9…" playlist fails with the actionable message;
//   * YouTube Data API: video + playlist metadata resolve;
//   * SoundCloud: `yt-dlp` search returns entries and a real audio stream;
//   * Audius: search returns tracks and the stream endpoint serves bytes.
const { spawn } = require("child_process");
const { HttpClient } = require("../src/infrastructure/http-client");
const { SpotifyClient } = require("../src/infrastructure/spotify-client");
const { YouTubeClient } = require("../src/infrastructure/youtube-client");
const { AudiusClient } = require("../src/infrastructure/audius-client");

const youtubeVideos = (process.env.SMOKE_YOUTUBE_VIDEOS || "7qw4iloZORQ,cBEEtp4AAAw").split(",").map(s => s.trim()).filter(Boolean);
const youtubePlaylists = (process.env.SMOKE_YOUTUBE_PLAYLISTS || "PL1qZUeYbFlKjNqTu--CN5tm3a0NWo8nwf").split(",").map(s => s.trim()).filter(Boolean);
const editorialPlaylistId = process.env.SMOKE_SPOTIFY_EDITORIAL || "37i9dQZEVXbjtrVpztYEcP";
const audioProbe = ["Daft Punk Get Lucky", "Tame Impala The Less I Know The Better"];

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};

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
/// abort — enough to prove the endpoint actually serves audio without pulling
/// the whole file.
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

async function resolveSpotifyPlaylistIds(spotify) {
  const configured = (process.env.SMOKE_SPOTIFY_PLAYLIST_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  // No hardcoded ids: editorial "37i9…" playlists are API-blocked and a fixed
  // user playlist can be deleted. Search for public, user-owned playlists so
  // the smoke keeps working without maintenance.
  const seen = new Set();
  for (const query of ["top hits 2024", "rock classics", "lofi beats"]) {
    let found = [];
    try { found = await spotify.searchPlaylists(query, 20); } catch { continue; }
    for (const playlist of found) {
      if (playlist && playlist.id && playlist.owner && playlist.owner.id !== "spotify") seen.add(playlist.id);
    }
    if (seen.size >= 2) break;
  }
  return [...seen].slice(0, 2);
}

async function main() {
  const http = new HttpClient({ timeoutMs: 30000 });

  // ---- Spotify (discovery) --------------------------------------------------
  const spotify = new SpotifyClient({ http, clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken: process.env.SPOTIFY_REFRESH_TOKEN });
  check("Spotify app credentials configured", spotify.configured, "set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
  if (spotify.configured) {
    let playlistIds = [];
    try { playlistIds = await resolveSpotifyPlaylistIds(spotify); }
    catch (error) { check("Spotify playlist search", false, error.message); }
    check("Spotify playlist search returned candidates", playlistIds.length > 0, "no public user playlists found");
    for (const id of playlistIds) {
      try {
        const result = await spotify.getCollection("playlist", id);
        check(`Spotify public playlist ${id} expands to tracks`, result.tracks.length > 0, "returned no tracks");
      } catch (error) {
        check(`Spotify public playlist ${id} expands to tracks`, false, error.message);
      }
    }
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
    for (const id of youtubeVideos) {
      try { const intent = await youtube.video(id); check(`YouTube metadata ${id}`, Boolean(intent?.title && intent.durationMs), "missing title or duration"); }
      catch (error) { check(`YouTube metadata ${id}`, false, error.message); }
    }
    for (const id of youtubePlaylists) {
      try { const result = await youtube.playlist(id); check(`YouTube playlist ${id}`, result.intents.length > 0, "returned no playable videos"); }
      catch (error) { check(`YouTube playlist ${id}`, false, error.message); }
    }
  }

  // ---- SoundCloud (playback) --------------------------------------------------
  for (const query of audioProbe) {
    const listing = await ytdlp([...scsearchArgs, "--skip-download", "--dump-single-json", `scsearch3:${query}`], { timeoutMs: 45000 });
    let entries = [];
    try { entries = JSON.parse(listing.stdout.toString() || "{}").entries || []; } catch { /* handled by the check */ }
    check(`SoundCloud search "${query}"`, listing.code === 0 && entries.length > 0, listing.stderr.trim().split("\n").slice(-1)[0]);
    const url = entries[0]?.webpage_url || entries[0]?.url;
    if (!url) continue;
    const stream = await ytdlp([...scsearchArgs, "-f", "bestaudio/best", "-o", "-", url], { timeoutMs: 60000, stopAfterBytes: 65536 });
    check(`SoundCloud audio streams "${query}"`, stream.enough || stream.stdout.length > 32768, `${stream.stdout.length} bytes; ${stream.stderr.trim().split("\n").slice(-1)[0]}`);
  }

  // ---- Audius (playback) ----------------------------------------------------
  const audius = new AudiusClient({ http, apiKey: process.env.AUDIUS_API_KEY || "" });
  for (const query of audioProbe) {
    let tracks = [];
    try { tracks = await audius.search(query, 5); } catch (error) { check(`Audius search "${query}"`, false, error.message); continue; }
    check(`Audius search "${query}"`, tracks.length > 0, "no tracks");
    const id = tracks[0]?.id;
    if (!id) continue;
    try {
      const bytes = await readFirstBytes(audius.streamUrl(id), 65536);
      check(`Audius audio streams "${query}"`, bytes.ok && bytes.length > 32768, `HTTP ${bytes.status}, ${bytes.length} bytes`);
    } catch (error) {
      check(`Audius audio streams "${query}"`, false, error.message);
    }
  }

  if (failures.length) console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  else console.log("\nall provider checks passed");
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
