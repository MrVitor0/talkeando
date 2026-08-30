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
console.log("music-bot LiveKit adapter contract checks passed");
// rtc-node owns native worker handles even without a connection. This is an
// offline contract test, so terminate once every assertion has run.
process.exit(0);
