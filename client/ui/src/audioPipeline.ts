import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

export type NoiseSuppressionMode = "rnnoise" | "off";
export type AudioPipelineOrigin = "rnnoise" | "off";
export type AudioPipelineStatus = {
  state: "idle" | "loading" | "ready" | "failed";
  requestedMode: NoiseSuppressionMode;
  effectiveMode: NoiseSuppressionMode;
  origin?: AudioPipelineOrigin;
  generation: number;
  reason?: string;
};

export type AudioCapturePipeline = {
  mode: NoiseSuppressionMode;
  origin: AudioPipelineOrigin;
  rawStream: MediaStream;
  rawTrack: MediaStreamTrack;
  outputStream: MediaStream;
  outputTrack: MediaStreamTrack;
  isProcessed: boolean;
  sampleRate: number | undefined;
  channels: number | undefined;
  dispose(): Promise<void>;
};

type StartInput = { deviceId?: string; mode: NoiseSuppressionMode };
type StatusListener = (status: AudioPipelineStatus) => void;

const LOG = "[audio]";

function log(event: string, fields: Record<string, unknown> = {}) {
  // Deliberately no device label, audio content, bearer token, or room/user id.
  console.info(`${LOG} ${event}`, fields);
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function constraintsForMode(mode: NoiseSuppressionMode, deviceId?: string): MediaTrackConstraints {
  const device = deviceId ? { exact: deviceId } : undefined;
  if (mode === "rnnoise") return {
    deviceId: device,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
  };
  return {
    deviceId: device,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48_000,
  };
}

async function capture(mode: NoiseSuppressionMode, deviceId?: string): Promise<MediaStream> {
  log("audio.capture.requested", { mode, hasDeviceSelection: !!deviceId });
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraintsForMode(mode, deviceId) });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach(item => item.stop());
    throw new Error("A captura não retornou uma track de áudio");
  }
  const settings = track.getSettings();
  log("audio.capture.acquired", { mode, sampleRate: settings.sampleRate, channels: settings.channelCount });
  return stream;
}

function rawPipeline(stream: MediaStream, mode: "off"): AudioCapturePipeline {
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings();
  let disposed = false;
  return {
    mode,
    origin: mode,
    rawStream: stream,
    rawTrack: track,
    outputStream: stream,
    outputTrack: track,
    isProcessed: false,
    sampleRate: settings.sampleRate,
    channels: settings.channelCount,
    async dispose() {
      if (disposed) return;
      disposed = true;
      stream.getTracks().forEach(item => item.stop());
      log("audio.pipeline.disposed", { origin: mode });
    },
  };
}

async function rnnoisePipeline(stream: MediaStream): Promise<AudioCapturePipeline> {
  const rawTrack = stream.getAudioTracks()[0];
  const started = performance.now();
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: RnnoiseWorkletNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let disposed = false;
  try {
    log("audio.pipeline.initializing", { mode: "rnnoise" });
    context = new AudioContext({ sampleRate: 48_000 });
    if (context.sampleRate !== 48_000) throw new Error(`RNNoise requer 48000 Hz; contexto criou ${context.sampleRate} Hz`);
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
    log("audio.rnnoise.worklet.loaded");
    const wasmBinary = await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
    log("audio.rnnoise.wasm.loaded", { bytes: wasmBinary.byteLength });
    source = context.createMediaStreamSource(stream);
    node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary });
    destination = context.createMediaStreamDestination();
    source.connect(node).connect(destination);
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack || outputTrack === rawTrack) throw new Error("RNNoise não produziu uma track processada distinta");
    log("audio.rnnoise.processing.started", { elapsedMs: Math.round(performance.now() - started) });
    return {
      mode: "rnnoise",
      origin: "rnnoise",
      rawStream: stream,
      rawTrack,
      outputStream: destination.stream,
      outputTrack,
      isProcessed: true,
      sampleRate: context.sampleRate,
      channels: outputTrack.getSettings().channelCount ?? 1,
      async dispose() {
        if (disposed) return;
        disposed = true;
        try { source?.disconnect(); } catch {}
        try { node?.disconnect(); node?.destroy(); } catch {}
        try { destination?.disconnect(); } catch {}
        destination?.stream.getTracks().forEach(item => item.stop());
        stream.getTracks().forEach(item => item.stop());
        await context?.close().catch(() => {});
        log("audio.pipeline.disposed", { origin: "rnnoise" });
      },
    };
  } catch (error) {
    try { source?.disconnect(); } catch {}
    try { node?.disconnect(); node?.destroy(); } catch {}
    try { destination?.disconnect(); } catch {}
    destination?.stream.getTracks().forEach(item => item.stop());
    stream.getTracks().forEach(item => item.stop());
    await context?.close().catch(() => {});
    throw error;
  }
}

/** One owner for microphone tracks and Web Audio resources. Operations are
 * serialized so a stale device/mode request cannot replace a newer track. */
export class AudioPipelineManager {
  private active: AudioCapturePipeline | null = null;
  private serial = Promise.resolve();
  private generation = 0;
  private desiredMode: NoiseSuppressionMode = "off";
  private listeners = new Set<StatusListener>();

  onStatus(listener: StatusListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get mode() { return this.desiredMode; }
  get current() { return this.active; }
  setDesiredMode(mode: NoiseSuppressionMode) {
    this.desiredMode = mode;
    this.status({ state: "idle", requestedMode: mode, effectiveMode: mode });
  }

  private status(partial: Omit<AudioPipelineStatus, "generation">) {
    const status = { ...partial, generation: this.generation };
    this.listeners.forEach(listener => listener(status));
  }

  async start(input: StartInput, install: (track: MediaStreamTrack, pipeline: AudioCapturePipeline) => Promise<void>) {
    return this.enqueue(() => this.replace(input, install));
  }
  async switchMode(mode: NoiseSuppressionMode, install: (track: MediaStreamTrack, pipeline: AudioCapturePipeline) => Promise<void>) {
    return this.start({ mode }, install);
  }
  async switchDevice(deviceId: string | undefined, install: (track: MediaStreamTrack, pipeline: AudioCapturePipeline) => Promise<void>) {
    return this.start({ mode: this.desiredMode, deviceId }, install);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }

  private async replace(input: StartInput, install: (track: MediaStreamTrack, pipeline: AudioCapturePipeline) => Promise<void>) {
    const generation = ++this.generation;
    this.desiredMode = input.mode;
    this.status({ state: "loading", requestedMode: input.mode, effectiveMode: input.mode });
    let next: AudioCapturePipeline | null = null;
    try {
      const stream = await capture(input.mode, input.deviceId);
      next = input.mode === "rnnoise" ? await rnnoisePipeline(stream) : rawPipeline(stream, input.mode);
    } catch (error) {
      const reason = safeError(error);
      log("audio.pipeline.failed", { requestedMode: input.mode, generation, reason });
      if (input.mode !== "rnnoise") {
        this.status({ state: "failed", requestedMode: input.mode, effectiveMode: input.mode, reason });
        throw error;
      }
      this.status({ state: "failed", requestedMode: "rnnoise", effectiveMode: this.active?.mode ?? "off", reason });
      throw error;
    }
    try {
      await install(next.outputTrack, next);
    } catch (error) {
      await next.dispose();
      const reason = safeError(error);
      log("audio.track.replacing.failed", { generation, reason });
      this.status({ state: "failed", requestedMode: input.mode, effectiveMode: this.active?.mode ?? "off", reason });
      throw error;
    }
    const previous = this.active;
    this.active = next;
    await previous?.dispose();
    this.status({ state: "ready", requestedMode: input.mode, effectiveMode: next.mode, origin: next.origin });
    log("audio.pipeline.ready", { generation, requestedMode: input.mode, effectiveMode: next.mode, origin: next.origin, processed: next.isProcessed, sampleRate: next.sampleRate, channels: next.channels });
    return next;
  }

  async dispose() {
    return this.enqueue(async () => {
      const previous = this.active;
      this.active = null;
      ++this.generation;
      await previous?.dispose();
      this.status({ state: "idle", requestedMode: this.desiredMode, effectiveMode: this.desiredMode });
    });
  }
}
