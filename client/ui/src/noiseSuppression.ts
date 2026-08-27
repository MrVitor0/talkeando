// On-device noise suppression via RNNoise (Xiph, BSD) as a WASM AudioWorklet.
// This is the free, no-server, no-per-user-cost alternative to Krisp: the mic
// audio is denoised locally before it ever hits a peer connection.
//
// Krisp's SDK is a commercial B2B licence with no self-serve access, so it is
// not an option for a small deployment. RNNoise removes keyboard, fans, hum
// and background chatter well; not quite Krisp-tier on music/babble.

import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

let ctx: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let node: RnnoiseWorkletNode | null = null;
let destination: MediaStreamAudioDestinationNode | null = null;
let enabled = true;

/// Route `micStream` through RNNoise and return the cleaned stream to publish
/// to peers. Falls back to the raw stream if the worklet can't load, so a
/// failure here never costs you the mic.
export async function processMic(micStream: MediaStream, initiallyEnabled: boolean): Promise<MediaStream> {
  enabled = initiallyEnabled;
  try {
    // RNNoise assumes 48 kHz.
    ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
    const wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });

    source = ctx.createMediaStreamSource(micStream);
    node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    destination = ctx.createMediaStreamDestination();
    wireGraph();
    console.log(`[ns] RNNoise ready (enabled=${enabled})`);
    return destination.stream;
  } catch (error) {
    console.error("[ns] RNNoise setup failed — falling back to the raw mic", error);
    await teardown();
    return micStream;
  }
}

function wireGraph() {
  if (!source || !destination) return;
  try { source.disconnect(); } catch { /* not connected */ }
  try { node?.disconnect(); } catch { /* not connected */ }
  if (enabled && node) source.connect(node).connect(destination);
  else source.connect(destination);
}

export function setEnabled(value: boolean) {
  enabled = value;
  wireGraph();
}

export function isEnabled() {
  return enabled;
}

export async function teardown() {
  try { source?.disconnect(); } catch { /* noop */ }
  try { node?.disconnect(); node?.destroy(); } catch { /* noop */ }
  try { destination?.disconnect(); } catch { /* noop */ }
  try { await ctx?.close(); } catch { /* noop */ }
  ctx = null;
  source = null;
  node = null;
  destination = null;
}
