// PCM bridge for the local DJ source. It intentionally shares the native
// audio ring with screen loopback, but owns a separate TrackGenerator.
import { send } from "./ipc";

const webview = (window as { chrome?: { webview?: any } }).chrome?.webview;
type SharedBufferEvent = { getBuffer: () => ArrayBuffer; additionalData?: unknown };
const win = window as any;
let buffer: ArrayBuffer | null = null, slotSize = 8 * 1024, writer: WritableStreamDefaultWriter<unknown> | null = null;
let generator: MediaStreamTrack | null = null, sampleOffset = 0;

webview?.addEventListener("sharedbufferreceived", (event: SharedBufferEvent) => {
  const meta = (typeof event.additionalData === "string" ? JSON.parse(event.additionalData) : event.additionalData) as Record<string, unknown> | null;
  if (meta?.kind === "screen-audio") { buffer = event.getBuffer(); if (typeof meta.slotSize === "number") slotSize = meta.slotSize; }
});
webview?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const envelope = event.data as { op?: string; data?: { slot: number; len: number } };
  if (envelope.op !== "music.pcm" || !buffer || !writer || !envelope.data || envelope.data.len <= 0) return;
  const frames = Math.floor(envelope.data.len / 4); if (!frames) return;
  try {
    const pcm = new Int16Array(frames * 2);
    pcm.set(new Int16Array(buffer, envelope.data.slot * slotSize, frames * 2));
    const data = new win.AudioData({ format: "s16", sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2, timestamp: Math.round(sampleOffset / 48000 * 1_000_000), data: pcm });
    sampleOffset += frames; void writer.write(data);
  } catch (error) { console.warn("[music] pcm write failed", error); }
});

export function startNativeMusic(query: string): MediaStreamTrack | null {
  if (!win.MediaStreamTrackGenerator || !win.AudioData) return null;
  stopNativeMusic();
  const track = new win.MediaStreamTrackGenerator({ kind: "audio" }) as MediaStreamTrack;
  writer = (track as any).writable.getWriter(); generator = track; sampleOffset = 0;
  send("music.play", { query });
  return track;
}
export function pauseNativeMusic(paused: boolean) { send("music.pause", { paused }); }
export function stopNativeMusic() { send("music.stop", {}); try { void writer?.close(); } catch { } writer = null; generator?.stop(); generator = null; }
