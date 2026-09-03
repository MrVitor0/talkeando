// Offline contract checks for the SFU adapter. Media integration is exercised
// against LiveKit in deployment; this test deliberately opens no network room.
const assert = require("assert");
const pkg = require("./package.json");
const { AudioSource, AudioFrame, LocalAudioTrack, Room } = require("@livekit/rtc-node");

assert.ok(pkg.dependencies["@livekit/rtc-node"], "music bot must use the LiveKit media SDK");
assert.ok(!pkg.dependencies["@roamhq/wrtc"], "mesh WebRTC binding must not return");
const source = new AudioSource(48_000, 2);
const track = LocalAudioTrack.createAudioTrack("music", source);
assert.ok(track, "one named music track can be created from the PCM source");
assert.ok(new Room(), "SDK can create a room before connecting");
void track.close(true);

// ---- SPEC-015: protocol v2 handshake + dialect ----
// The bot process connects a WebSocket on require, so it can't be imported
// here. These are static contract checks against the source, in the same
// offline spirit as the SDK checks above.
const fs = require("fs");
const src = fs.readFileSync(require.resolve("./index.js"), "utf8");

assert.ok(/const PROTOCOL_VERSION = 2\b/.test(src), "handshake declares protocol v2");
assert.ok(
  /auth\.hello[\s\S]{0,200}protocol_version:\s*PROTOCOL_VERSION[\s\S]{0,120}client_version:\s*BOT_VERSION/.test(src),
  "auth.hello carries protocol_version and client_version",
);
assert.ok(/client_platform:\s*"music-bot"/.test(src), "auth.hello identifies the platform");

assert.ok(/function sendPresenceHint\(/.test(src), "presence goes through a versioned helper");
assert.ok(
  /serverFeatures\.has\("voice\.hints"\)[\s\S]{0,120}voice\.presence\.hint/.test(src),
  "sendPresenceHint emits voice.presence.hint when the feature is present",
);
assert.ok(
  /voice\.presence\.enter[\s\S]{0,40}voice\.presence\.leave/.test(src),
  "sendPresenceHint falls back to the v1 ops without the feature",
);
assert.ok(/serverFeatures = new Set\(e\.data\?\.features \?\? \[\]\)/.test(src), "auth.ok populates serverFeatures");

assert.ok(/async function rejoinAfterReconnect\(/.test(src), "a reconnect path distinct from join exists");
const rejoinBody = src.slice(src.indexOf("async function rejoinAfterReconnect("), src.indexOf("async function join("));
assert.ok(!/\.disconnect\(/.test(rejoinBody), "rejoinAfterReconnect never disconnects the live room");
assert.ok(/void rejoinAfterReconnect\(voiceChannel\)/.test(src), "auth.ok re-announces via rejoinAfterReconnect");

const leaveBody = src.slice(src.indexOf("async function leaveVoice("), src.indexOf("async function onEvent("));
assert.ok(
  leaveBody.indexOf("localParticipant?.sid") < leaveBody.indexOf("disconnectLiveKit()"),
  "leaveVoice captures the sid before disconnecting",
);
assert.ok(/await disconnectLiveKit\(\)/.test(src), "joinLiveKit awaits the previous disconnect");

console.log("music-bot LiveKit adapter contract checks passed");
// rtc-node owns native worker handles even without a connection. This is an
// offline contract test, so terminate once every assertion has run.
process.exit(0);
