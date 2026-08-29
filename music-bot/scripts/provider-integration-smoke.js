#!/usr/bin/env node
// Runs inside the deployed music-bot container. It checks the real provider
// credentials, cookies and PoToken path without printing any secret.
const { spawn } = require("child_process");
const fs = require("fs");
const { HttpClient } = require("../src/infrastructure/http-client");
const { SpotifyClient } = require("../src/infrastructure/spotify-client");
const { YouTubeClient } = require("../src/infrastructure/youtube-client");

const spotifyPlaylists = ["37i9dQZEVXbjtrVpztYEcP", "37i9dQZEVXcUlZglgy67Fy", "37i9dQZF1E4zHX5arZmMz5"];
const youtubeVideos = ["7qw4iloZORQ", "cBEEtp4AAAw", "id7tL72Ebpo", "pxVWg9PB4G0"];
const youtubePlaylists = ["PL1qZUeYbFlKjNqTu--CN5tm3a0NWo8nwf", "PL_Q15fKxrBb5pckIW2RHwZbgf-FwRiCWr"];
const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`); }
};

function ytdlp(args, timeoutMs = 60000) {
  return new Promise(resolve => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); resolve({ code: -1, stderr: error.message }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

function youtubeArgs() {
  const args = ["--ignore-config", "--no-progress", "--no-call-home", "--no-playlist", "--skip-download", "--simulate", "--retries", "5", "--fragment-retries", "5", "--extractor-retries", "3", "--socket-timeout", "20", "--js-runtimes", "deno", "--remote-components", "ejs:github", "--extractor-args", `youtube:player_client=${process.env.YT_PLAYER_CLIENTS || "default,-visionos"}`];
  if (process.env.YT_POT_PROVIDER_URL) args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${process.env.YT_POT_PROVIDER_URL}`);
  args.push("--cookies", writableCookieJar());
  return args;
}

function writableCookieJar() {
  const source = process.env.YT_DLP_COOKIES || "/cookies/yt.txt";
  const destination = "/tmp/yt-integration-cookies.txt";
  // yt-dlp updates some cookie values while handling YouTube. The production
  // bot therefore never hands it the read-only Docker mount directly.
  fs.copyFileSync(source, destination);
  return destination;
}

async function main() {
  const http = new HttpClient({ timeoutMs: 30000 });
  const spotify = new SpotifyClient({ http, clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken: process.env.SPOTIFY_REFRESH_TOKEN });
  check("Spotify playlist authorization configured", spotify.hasUserAuthorization, "add SPOTIFY_REFRESH_TOKEN to GitHub Secrets");
  if (spotify.hasUserAuthorization) {
    for (const id of spotifyPlaylists) {
      try { const result = await spotify.getCollection("playlist", id); check(`Spotify playlist ${id}`, result.tracks.length > 0, "returned no tracks"); }
      catch (error) { check(`Spotify playlist ${id}`, false, error.message); }
    }
  }

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
  for (const id of youtubeVideos) {
    const result = await ytdlp([...youtubeArgs(), `https://www.youtube.com/watch?v=${id}`]);
    check(`YouTube extraction ${id}`, result.code === 0, result.stderr.trim().split("\n").slice(-1)[0]);
  }
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
