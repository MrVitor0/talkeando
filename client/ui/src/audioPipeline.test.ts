import { beforeEach, describe, expect, it, vi } from "vitest";

const rnnoiseMock = vi.hoisted(() => ({ loadRnnoise: vi.fn(), destroy: vi.fn() }));
vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: rnnoiseMock.loadRnnoise,
  RnnoiseWorkletNode: class {
    connect = vi.fn().mockReturnThis();
    disconnect = vi.fn();
    destroy = rnnoiseMock.destroy;
    constructor(_: unknown, __: unknown) {}
  },
}));

import { AudioPipelineManager, constraintsForMode } from "./audioPipeline";

type FakeTrack = MediaStreamTrack & { stopped: boolean };
function track(settings: MediaTrackSettings = {}): FakeTrack {
  const fake = {
    kind: "audio", id: crypto.randomUUID(), label: "",
    enabled: true, muted: false, readyState: "live",
    stopped: false,
    getSettings: () => settings,
  } as unknown as FakeTrack;
  fake.stop = () => { fake.stopped = true; };
  return fake;
}
function stream(item: FakeTrack): MediaStream {
  return { getAudioTracks: () => [item], getTracks: () => [item] } as unknown as MediaStream;
}

describe("AudioPipelineManager", () => {
  let captures: MediaTrackConstraints[];

  beforeEach(() => {
    captures = [];
    rnnoiseMock.loadRnnoise.mockReset();
    rnnoiseMock.destroy.mockReset();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: vi.fn(async ({ audio }) => {
        captures.push(audio as MediaTrackConstraints);
        return stream(track({ sampleRate: 48_000, channelCount: 1 }));
      }) } },
    });
  });

  it("uses the exact native processing constraints for each mode", () => {
    expect(constraintsForMode("rnnoise")).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48_000 });
    expect(constraintsForMode("off", "mic-a")).toMatchObject({ deviceId: { exact: "mic-a" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48_000 });
  });

  it("publishes the raw track with processing disabled and cleans it up", async () => {
    const manager = new AudioPipelineManager();
    let installed: MediaStreamTrack | undefined;
    const pipeline = await manager.start({ mode: "off" }, async output => { installed = output; });
    expect(pipeline.isProcessed).toBe(false);
    expect(pipeline.outputTrack).toBe(pipeline.rawTrack);
    expect(installed).toBe(pipeline.rawTrack);
    expect(captures[0]).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    await manager.dispose();
    expect((pipeline.rawTrack as FakeTrack).stopped).toBe(true);
  });

  it("does not publish unprocessed audio when RNNoise cannot load", async () => {
    rnnoiseMock.loadRnnoise.mockRejectedValueOnce(new Error("wasm unavailable"));
    class FailingAudioContext {
      sampleRate = 48_000; state: AudioContextState = "running";
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamSource = () => ({ connect: vi.fn().mockReturnThis(), disconnect: vi.fn() });
      createMediaStreamDestination = () => ({ stream: stream(track()), disconnect: vi.fn() });
      close = vi.fn(async () => {});
    }
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FailingAudioContext });
    const manager = new AudioPipelineManager();
    const states: string[] = [];
    manager.onStatus(status => states.push(status.state));
    await expect(manager.start({ mode: "rnnoise" }, async () => {})).rejects.toThrow("wasm unavailable");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ noiseSuppression: false });
    expect(states).toContain("failed");
  });

  it("uses a distinct RNNoise output track when the worklet is ready", async () => {
    rnnoiseMock.loadRnnoise.mockResolvedValueOnce(new ArrayBuffer(16));
    const output = track({ sampleRate: 48_000, channelCount: 1 });
    class WorkingAudioContext {
      sampleRate = 48_000; state: AudioContextState = "running";
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamSource = () => ({ connect: vi.fn().mockReturnThis(), disconnect: vi.fn() });
      createMediaStreamDestination = () => ({ stream: stream(output), disconnect: vi.fn() });
      close = vi.fn(async () => {});
    }
    Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: WorkingAudioContext });
    const manager = new AudioPipelineManager();
    let installed: MediaStreamTrack | undefined;
    const pipeline = await manager.start({ mode: "rnnoise" }, async candidate => { installed = candidate; });
    expect(pipeline.isProcessed).toBe(true);
    expect(pipeline.outputTrack).toBe(output);
    expect(pipeline.outputTrack).not.toBe(pipeline.rawTrack);
    expect(installed).toBe(output);
    expect(rnnoiseMock.loadRnnoise).toHaveBeenCalledOnce();
  });

  it("serializes replacements so the old track is disposed only after install succeeds", async () => {
    const manager = new AudioPipelineManager();
    const first = await manager.start({ mode: "off" }, async () => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const change = manager.switchMode("off", async () => { await gate; });
    await Promise.resolve();
    expect((first.rawTrack as FakeTrack).stopped).toBe(false);
    release();
    await change;
    expect((first.rawTrack as FakeTrack).stopped).toBe(true);
  });
});
