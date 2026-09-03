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

import { send, subscribe } from "./ipc";

/**
 * Generation of the current capture. Frames that arrive with a different
 * generation are dropped: the native host can take up to ~800 ms to stop its
 * capture thread (ScreenCapture.cs Join(800)), and without this, frames from
 * the old capture get drawn onto the new canvas (RC-16).
 */
let captureGeneration = 0;

const webview =
  typeof window !== "undefined"
    ? (window as { chrome?: { webview?: any } }).chrome?.webview
    : undefined;

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
  const envelope = event.data as { op?: string; data?: { slot: number; len: number; generation?: number } };
  if (!envelope?.data) return;
  // Drop frames/packets from a previous capture (RC-16). A missing generation
  // (older native host) is accepted.
  if (envelope.data.generation !== undefined && envelope.data.generation !== captureGeneration) return;
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
const win: any = typeof window !== "undefined" ? window : {};

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
export function startNativeScreen(options: {
  generation: number;
  sourceId: string;
  maxHeight: number;
  fps: number;
  withAudio: boolean;
}): MediaStream {
  active = true;
  captureGeneration = options.generation;
  framesOk = 0;
  framesBad = 0;
  if (!videoBuffer) console.warn("[nativeScreen] no video shared buffer yet — frames drop until it arrives");

  canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  ctx = canvas.getContext("2d");
  if (ctx) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  const videoStream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(options.fps);
  const tracks: MediaStreamTrack[] = [videoStream.getVideoTracks()[0]];

  const audioTrack = options.withAudio ? makeAudioTrack() : null;
  if (audioTrack) tracks.push(audioTrack);

  send("screen.capture.start", {
    source_id: options.sourceId,
    max_height: options.maxHeight,
    max_fps: options.fps,
    audio: options.withAudio && !!audioTrack,
    generation: options.generation,
  });
  return new MediaStream(tracks);
}

/// Re-issues the capture for an already-running share at a new resolution /
/// frame-rate. The host's `ScreenCapture.Start()` stops and restarts its
/// capture thread, but our canvas + its `captureStream()` track are untouched —
/// `onVideoFrame` just starts drawing frames at the new size — so the WebRTC
/// sender needs no renegotiation. Audio target is left as-is.
export function reconfigureNativeScreen(sourceId: string, maxHeight: number, fps: number, withAudio: boolean) {
  if (!active) return;
  send("screen.capture.start", { source_id: sourceId, max_height: maxHeight, max_fps: fps, audio: withAudio });
}

/**
 * Now async: resolves only after the host confirms the stop
 * (`screen.capture.stopped`), or after a 1 s timeout. That confirmation means
 * "the capture threads ended" (the host's Join(800) completed) — the guarantee
 * INV-D2 needs before a new capture may start. Pass `generation` to make a
 * stale stop a no-op.
 */
export async function stopNativeScreen(generation?: number): Promise<void> {
  if (generation !== undefined && generation !== captureGeneration) return;
  if (!active && captureGeneration === 0) return;
  active = false;
  captureGeneration = 0;
  canvas = null;
  ctx = null;
  try { await audioWriter?.close(); } catch { /* already closed */ }
  audioWriter = null;
  audioGenerator?.stop();
  audioGenerator = null;
  audioFrameCount = 0;
  audioPackets = 0;
  await requestCaptureStop();
}

/** Sends `screen.capture.stop` and waits for `screen.capture.stopped`. */
function requestCaptureStop(): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { off(); resolve(); }, 1000);
    const off = subscribe(event => {
      if (event.op !== "screen.capture.stopped") return;
      clearTimeout(timer);
      off();
      resolve();
    });
    send("screen.capture.stop", {});
  });
}
