/** SFU media adapter. WebSocket remains control-plane only; media connects directly to LiveKit. */
import { Room, RoomEvent, Track } from "livekit-client";
import { startNativeScreen, stopNativeScreen, reconfigureNativeScreen } from "./nativeScreen";
import * as noiseSuppression from "./noiseSuppression";
import { send, subscribe } from "./ipc";

export type ConnQuality = "good" | "medium" | "poor";
type Remote = (id: string, stream: MediaStream | null, id2: string | null) => void;
type DeviceLists = { audioInputs: MediaDeviceInfo[]; audioOutputs: MediaDeviceInfo[]; videoInputs: MediaDeviceInfo[] };

let active: Room | null = null;
// The voice channel the server currently lists us in. Mirrors `active`, but
// outlives a `RoomEvent.Disconnected` long enough to send the matching
// `voice.presence.leave` — the server roster is driven by these signals, not
// by LiveKit's webhooks.
let presentChannelId: string | null = null;
let screen: MediaStream | null = null;
let screenSource = "";
let screenAudioEnabled = false;
let audioInputDeviceId = storedString("tk.audioInputDeviceId");
let audioOutputDeviceId = storedString("tk.audioOutputDeviceId");
let inputVolume = storedNumber("tk.inputVolume", 1);
let outputVolume = storedNumber("tk.outputVolume", 1);
const remotes = new Set<Remote>();
const cameras = new Set<(stream: MediaStream | null) => void>();
const speakers = new Set<(ids: Set<string>) => void>();
const qualities = new Set<(quality: ConnQuality) => void>();
const mediaErrors = new Set<(message: string) => void>();
const volumes = new Map<string, number>(Object.entries(stored("tk.peerVolumes")));
const screenVolumes = new Map<string, number>(Object.entries(stored("tk.screenVolumes")));
const muted = new Map<string, boolean>(), screenMuted = new Map<string, boolean>();
const audio = new Map<string, HTMLAudioElement[]>(), screenAudio = new Map<string, HTMLAudioElement[]>();

function stored(key: string): Record<string, number> { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; } }
function storedString(key: string): string | undefined { try { return localStorage.getItem(key) || undefined; } catch { return undefined; } }
function storedNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch { return fallback; }
}
function persist(key: string, values: Map<string, number>) { try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(values))); } catch {} }
function persistValue(key: string, value: string | number) { try { localStorage.setItem(key, String(value)); } catch {} }

async function credentials(channel_id: string, mode = "participant") {
  const request_id = crypto.randomUUID();
  return new Promise<{ url: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("LiveKit token timeout")); }, 10_000);
    const off = subscribe(event => {
      if (event.op !== "livekit.token" || event.data.request_id !== request_id) return;
      clearTimeout(timer); off();
      const url = typeof event.data.url === "string" ? event.data.url.trim() : "";
      const token = typeof event.data.access_token === "string" ? event.data.access_token : "";
      if (!url || !token) { reject(new Error("LiveKit retornou uma credencial incompleta")); return; }
      try { new URL(url); } catch { reject(new Error(`LiveKit retornou URL inválida: ${url}`)); return; }
      resolve({ url, token });
    });
    send("livekit.token.request", { request_id, channel_id, mode });
  });
}

function apply(id: string, isScreen = false) {
  for (const element of (isScreen ? screenAudio : audio).get(id) || []) {
    element.volume = ((isScreen ? screenVolumes : volumes).get(id) ?? 1) * outputVolume;
    element.muted = (isScreen ? screenMuted : muted).get(id) === true;
    void setSink(element);
  }
}
async function setSink(element: HTMLMediaElement) {
  const sink = (element as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
  if (audioOutputDeviceId && sink) await sink.call(element, audioOutputDeviceId).catch(() => {});
}
function bind(room: Room) {
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const element = track.attach() as HTMLMediaElement;
    element.autoplay = true; element.style.display = "none"; document.body.appendChild(element);
    const isScreen = publication.source === Track.Source.ScreenShareAudio;
    const sinks = isScreen ? screenAudio : audio;
    sinks.set(participant.identity, [...(sinks.get(participant.identity) || []), element as HTMLAudioElement]);
    apply(participant.identity, isScreen);
    if (track.kind === Track.Kind.Video) remotes.forEach(listener => listener(participant.identity, new MediaStream([track.mediaStreamTrack]), publication.trackSid));
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    track.detach().forEach(element => element.remove());
    if (track.kind === Track.Kind.Video) remotes.forEach(listener => listener(participant.identity, null, publication.trackSid));
  });
  room.on(RoomEvent.ActiveSpeakersChanged, list => speakers.forEach(listener => listener(new Set(list.map(participant => participant.identity)))));
  room.on(RoomEvent.ConnectionQualityChanged, quality => qualities.forEach(listener => listener(quality === "poor" ? "poor" : quality === "good" ? "good" : "medium")));
  room.on(RoomEvent.MediaDevicesError, (error, kind) => {
    const device = kind === "audioinput" ? "microfone" : kind === "audiooutput" ? "saída de áudio" : "dispositivo de mídia";
    mediaErrors.forEach(listener => listener(`Não foi possível usar ${device}: ${error.message}`));
  });
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!room.canPlaybackAudio) mediaErrors.forEach(listener => listener("O aplicativo bloqueou a reprodução de áudio. Clique novamente no canal para ativá-la."));
  });
  room.on(RoomEvent.Disconnected, () => {
    active = null;
    if (presentChannelId) { send("voice.presence.leave", { channel_id: presentChannelId }); presentChannelId = null; }
  });
}

export function init(_: string) {}
export async function joinCall(id: string, isMuted: boolean, _: boolean) {
  active?.disconnect(); active = null;
  screen?.getTracks().forEach(track => track.stop()); screen = null;
  const room = new Room({ adaptiveStream: true, dynacast: true });
  bind(room);
  // Invoke this while handling the channel click. Some WebViews require a user
  // gesture before they allow remote audio to play.
  void room.startAudio().catch(() => {});
  try {
    const credential = await credentials(id);
    await room.connect(credential.url, credential.token);
    active = room;
    // Tell the server we're a participant now. It evicts us from any channel we
    // were previously in, so switching channels never shows us in two at once.
    send("voice.presence.enter", { channel_id: id });
    presentChannelId = id;
    await room.localParticipant.setMicrophoneEnabled(!isMuted, audioInputDeviceId ? { deviceId: audioInputDeviceId } : undefined);
  } catch (error) {
    room.disconnect();
    throw error;
  }
}
export async function leaveCall() {
  if (presentChannelId) { send("voice.presence.leave", { channel_id: presentChannelId }); presentChannelId = null; }
  active?.disconnect(); active = null;
  screen?.getTracks().forEach(track => track.stop()); screen = null;
}
export async function setLocalAudioState(isMuted: boolean, _: boolean) { await active?.localParticipant.setMicrophoneEnabled(!isMuted); }
export async function startCamera(_: string, __: string, deviceId?: string) {
  if (!active) return;
  await active.localParticipant.setCameraEnabled(true, { deviceId, resolution: { width: 1280, height: 720 } });
  const publication = [...active.localParticipant.videoTrackPublications.values()].find(item => item.source === Track.Source.Camera);
  cameras.forEach(listener => listener(publication?.track ? new MediaStream([publication.track.mediaStreamTrack]) : null));
}
export async function stopCamera(_: string, __: string) { await active?.localParticipant.setCameraEnabled(false); cameras.forEach(listener => listener(null)); }
export async function switchCamera(deviceId: string) { await stopCamera("", ""); await startCamera("", "", deviceId); }
export function onLocalCamera(listener: (stream: MediaStream | null) => void) { cameras.add(listener); return () => { cameras.delete(listener); }; }
export async function publishScreen(_: string, __: string, source: string, height: number, fps: number, withAudio: boolean) {
  if (!active) return;
  screenSource = source; screenAudioEnabled = withAudio; screen = startNativeScreen(source, height, fps, withAudio);
  for (const track of screen.getTracks()) await active.localParticipant.publishTrack(track, { source: track.kind === "audio" ? Track.Source.ScreenShareAudio : Track.Source.ScreenShare, simulcast: track.kind === "video" });
}
export async function unpublishScreen(_: string, __: string) {
  if (active) for (const publication of active.localParticipant.trackPublications.values()) if ((publication.source === Track.Source.ScreenShare || publication.source === Track.Source.ScreenShareAudio) && publication.track) await active.localParticipant.unpublishTrack(publication.track);
  stopNativeScreen(); screen?.getTracks().forEach(track => track.stop()); screen = null;
}
export function reconfigureScreen(height: number, fps: number) { reconfigureNativeScreen(screenSource, height, fps, screenAudioEnabled); }
export function switchScreenSource(source: string) { screenSource = source; }
export function getLocalScreenStream() { return screen; }
export function watchStream(_: string, sid: string, __: string) { active?.remoteParticipants.forEach(participant => participant.trackPublications.get(sid)?.setSubscribed(true)); }
export function stopWatchingStream(_: string, sid: string, __: string) { active?.remoteParticipants.forEach(participant => participant.trackPublications.get(sid)?.setSubscribed(false)); }
export async function spectate(id: string, sid: string, owner: string) { if (!active) { const credential = await credentials(id, "spectator"); const room = new Room({ adaptiveStream: true, dynacast: true }); bind(room); await room.connect(credential.url, credential.token); active = room; } watchStream(id, sid, owner); }
export function stopSpectate(_: string) {}
export function onRemoteStream(listener: Remote) { remotes.add(listener); return () => { remotes.delete(listener); }; }
export function onSpeaking(listener: (ids: Set<string>) => void) { speakers.add(listener); return () => { speakers.delete(listener); }; }
export function onConnectionQuality(listener: (quality: ConnQuality) => void) { qualities.add(listener); return () => { qualities.delete(listener); }; }
export function onMediaError(listener: (message: string) => void) { mediaErrors.add(listener); return () => { mediaErrors.delete(listener); }; }
export function setPeerVolume(id: string, value: number) { volumes.set(id, value); persist("tk.peerVolumes", volumes); apply(id); }
export function getPeerVolumes() { return Object.fromEntries(volumes); }
export function setPeerAudioMuted(id: string, value: boolean) { muted.set(id, value); apply(id); }
export function setScreenAudioVolume(id: string, value: number) { screenVolumes.set(id, value); persist("tk.screenVolumes", screenVolumes); apply(id, true); }
export function getScreenAudioVolumes() { return Object.fromEntries(screenVolumes); }
export function setScreenAudioMuted(id: string, value: boolean) { screenMuted.set(id, value); apply(id, true); }
export async function listCameras(): Promise<MediaDeviceInfo[]> { return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput"); }
export async function listAllMediaDevices(): Promise<DeviceLists> { const devices = await navigator.mediaDevices.enumerateDevices(); return { audioInputs: devices.filter(device => device.kind === "audioinput"), audioOutputs: devices.filter(device => device.kind === "audiooutput"), videoInputs: devices.filter(device => device.kind === "videoinput") }; }
export function getAudioInputDeviceId() { return audioInputDeviceId; }
export function getAudioOutputDeviceId() { return audioOutputDeviceId; }
export async function setAudioInputDevice(deviceId: string) { audioInputDeviceId = deviceId || undefined; if (deviceId) persistValue("tk.audioInputDeviceId", deviceId); await active?.switchActiveDevice("audioinput", deviceId).catch(() => {}); }
export async function setAudioOutputDevice(deviceId: string) { audioOutputDeviceId = deviceId || undefined; if (deviceId) persistValue("tk.audioOutputDeviceId", deviceId); await active?.switchActiveDevice("audiooutput", deviceId).catch(() => {}); for (const items of [...audio.values(), ...screenAudio.values()]) for (const element of items) void setSink(element); }
export function getInputVolume() { return inputVolume; }
export function getOutputVolume() { return outputVolume; }
export function setInputVolumeLevel(value: number) { inputVolume = Math.max(0, Math.min(1, value)); persistValue("tk.inputVolume", inputVolume); }
export function setOutputVolumeLevel(value: number) { outputVolume = Math.max(0, Math.min(1, value)); persistValue("tk.outputVolume", outputVolume); for (const id of audio.keys()) apply(id); for (const id of screenAudio.keys()) apply(id, true); }
export function setNoiseSuppression(value: boolean) { noiseSuppression.setEnabled(value); }
export function ensureChannel(_: string) {}
