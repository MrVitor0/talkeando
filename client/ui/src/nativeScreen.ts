// Bridge for the native (borderless) screen-capture path.
//
// Video: the C# host (ScreenCapture.cs) captures the chosen monitor/window
// with GDI, JPEG-encodes each frame into a WebView2 shared buffer and posts a
// `screen.frame` envelope. We decode each onto an offscreen <canvas>;
// canvas.captureStream() gives a real video MediaStreamTrack — no
// getDisplayMedia, so no Chromium capture border.
//
// Audio: the host captures WASAPI process-loopback PCM (AudioCapture.cs) into
// a second shared buffer and posts `screen.audio`. We feed each packet to a
// MediaStreamTrackGenerator as an AudioData frame, yielding an audio track
// that rides on the same peer connection as the video.

import { send } from "./ipc";

const webview = (window as { chrome?: { webview?: any } }).chrome?.webview;

type SharedBufferEvent = { getBuffer: () => ArrayBuffer; additionalData?: unknown };

// ---- video ----------------------------------------------------------------
let videoBuffer: ArrayBuffer | null = null;
let videoSlotSize = 2 * 1024 * 1024;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let active = false;
let decoding = false;
let framesOk = 0;
let framesBad = 0;

// ---- audio ---------------------------------------------------------------
let audioBuffer: ArrayBuffer | null = null;
let audioSlotSize = 8 * 1024;
let audioSampleRate = 48000;
let audioChannels = 2;
let audioWriter: WritableStreamDefaultWriter<unknown> | null = null;
let audioGenerator: MediaStreamTrack | null = null;
let audioFrameCount = 0; // running sample offset for AudioData timestamps
let audioPackets = 0;

webview?.addEventListener("sharedbufferreceived", (event: SharedBufferEvent) => {
  try {
    const meta = (typeof event.additionalData === "string"
      ? JSON.parse(event.additionalData)
      : event.additionalData) as Record<string, number | string> | null;
    if (!meta) return;
    if (meta.kind === "screen-frames") {
      videoBuffer = event.getBuffer();
      if (typeof meta.slotSize === "number") videoSlotSize = meta.slotSize;
      console.log(`[nativeScreen] video buffer received (${videoBuffer.byteLength} bytes, slot ${videoSlotSize})`);
    } else if (meta.kind === "screen-audio") {
      audioBuffer = event.getBuffer();
      if (typeof meta.slotSize === "number") audioSlotSize = meta.slotSize;
      if (typeof meta.sampleRate === "number") audioSampleRate = meta.sampleRate;
      if (typeof meta.channels === "number") audioChannels = meta.channels;
      console.log(`[nativeScreen] audio buffer received (${audioBuffer.byteLength} bytes, ${audioSampleRate}Hz x${audioChannels})`);
    }
  } catch (error) {
    console.error("[nativeScreen] sharedbufferreceived failed", error);
  }
});

// A dedicated `message` listener alongside ipc.ts's — keeps the 30fps frame /
// 100Hz audio notifications out of the React subscribe loop.
webview?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const envelope = event.data as { op?: string; data?: { slot: number; len: number } };
  if (!envelope?.data) return;
  if (envelope.op === "screen.frame") void onVideoFrame(envelope.data.slot, envelope.data.len);
  else if (envelope.op === "screen.audio") onAudioPacket(envelope.data.slot, envelope.data.len);
});

async function onVideoFrame(slot: number, len: number) {
  if (!active || !videoBuffer || !ctx || !canvas || decoding || len <= 0) return;
  decoding = true;
  try {
    const bytes = new Uint8Array(videoBuffer, slot * videoSlotSize, len);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    if (framesOk++ === 0) console.log(`[nativeScreen] first video frame decoded (${canvas.width}x${canvas.height}, ${len} bytes)`);
  } catch (error) {
    if (framesBad++ % 30 === 0) console.warn(`[nativeScreen] frame decode failed (${framesBad} so far)`, error);
  } finally {
    decoding = false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win = window as any;

function onAudioPacket(slot: number, len: number) {
  if (!active || !audioBuffer || !audioWriter || len <= 0) return;
  const bytesPerFrame = audioChannels * 2;
  const frames = Math.floor(len / bytesPerFrame);
  if (frames <= 0) return;
  try {
    // Copy out of the shared buffer before the host overwrites the slot.
    const pcm = new Int16Array(frames * audioChannels);
    pcm.set(new Int16Array(audioBuffer, slot * audioSlotSize, frames * audioChannels));
    const audioData = new win.AudioData({
      format: "s16",
      sampleRate: audioSampleRate,
      numberOfFrames: frames,
      numberOfChannels: audioChannels,
      timestamp: Math.round((audioFrameCount / audioSampleRate) * 1_000_000),
      data: pcm,
    });
    audioFrameCount += frames;
    void audioWriter.write(audioData);
    if (audioPackets++ === 0) console.log(`[nativeScreen] first audio packet (${frames} frames)`);
  } catch (error) {
    if (audioPackets++ % 100 === 0) console.warn("[nativeScreen] audio write failed", error);
  }
}

function makeAudioTrack(): MediaStreamTrack | null {
  if (!win.MediaStreamTrackGenerator || !win.AudioData) {
    console.warn("[nativeScreen] MediaStreamTrackGenerator/AudioData unavailable — sharing without audio");
    return null;
  }
  const generator = new win.MediaStreamTrackGenerator({ kind: "audio" });
  audioWriter = generator.writable.getWriter();
  audioFrameCount = 0;
  audioPackets = 0;
  audioGenerator = generator;
  return generator;
}

/// Starts the host capturing `sourceId`. Returns a MediaStream with a live
/// video track (canvas) and, when `withAudio`, an audio track fed by the
/// process-loopback PCM. Caller owns stopping it.
export function startNativeScreen(sourceId: string, maxHeight: number, fps: number, withAudio: boolean): MediaStream {
  active = true;
  framesOk = 0;
  framesBad = 0;
  if (!videoBuffer) console.warn("[nativeScreen] no video shared buffer yet — frames drop until it arrives");

  canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  ctx = canvas.getContext("2d");
  if (ctx) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  const videoStream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(fps);
  const tracks: MediaStreamTrack[] = [videoStream.getVideoTracks()[0]];

  const audioTrack = withAudio ? makeAudioTrack() : null;
  if (audioTrack) tracks.push(audioTrack);

  send("screen.capture.start", { source_id: sourceId, max_height: maxHeight, max_fps: fps, audio: withAudio && !!audioTrack });
  return new MediaStream(tracks);
}

export function stopNativeScreen() {
  if (!active) return;
  active = false;
  send("screen.capture.stop", {});
  canvas = null;
  ctx = null;
  try { void audioWriter?.close(); } catch { /* already closed */ }
  audioWriter = null;
  audioGenerator?.stop();
  audioGenerator = null;
}
