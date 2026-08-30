/** SFU media adapter.  WebSocket remains control-plane only; media connects directly to LiveKit. */
import { Room, RoomEvent, Track } from "livekit-client";
import { startNativeScreen, stopNativeScreen, reconfigureNativeScreen } from "./nativeScreen";
import * as noiseSuppression from "./noiseSuppression";
import { send, subscribe } from "./ipc";
export type ConnQuality = "good" | "medium" | "poor";
type Remote = (id: string, stream: MediaStream | null, id2: string | null) => void;
let active: Room | null = null, current: string | null = null, screen: MediaStream | null = null, screenSource = "", screenAudioEnabled = false;
const remotes = new Set<Remote>(), cameras = new Set<(s: MediaStream | null) => void>(), speakers = new Set<(v:string[])=>void>(), qualities = new Set<(v:ConnQuality)=>void>();
const volumes = new Map<string, number>(Object.entries(stored("tk.peerVolumes"))), screenVolumes = new Map<string, number>(Object.entries(stored("tk.screenVolumes")));
const muted = new Map<string, boolean>(), screenMuted = new Map<string, boolean>(), audio = new Map<string, HTMLAudioElement[]>(), screenAudio = new Map<string, HTMLAudioElement[]>();
function stored(key:string): Record<string,number> { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; } }
function persist(key:string, values:Map<string,number>) { try { localStorage.setItem(key, JSON.stringify(Object.fromEntries(values))); } catch {} }
async function credentials(channel_id:string, mode="participant") { const request_id=crypto.randomUUID(); return new Promise<{url:string,token:string}>((resolve,reject)=>{ const timer=setTimeout(()=>{off();reject(new Error("LiveKit token timeout"));},10_000); const off=subscribe(event=>{if(event.op!=="livekit.token"||event.data.request_id!==request_id)return;clearTimeout(timer);off();resolve(event.data.token);}); send("livekit.token.request",{request_id,channel_id,mode}); }); }
function apply(id:string, isScreen=false) { for (const el of (isScreen ? screenAudio : audio).get(id) || []) { el.volume = (isScreen ? screenVolumes : volumes).get(id) ?? 1; el.muted = (isScreen ? screenMuted : muted).get(id) === true; } }
function bind(room:Room) {
 room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => { const el=track.attach() as HTMLMediaElement; el.autoplay=true; el.style.display="none"; document.body.appendChild(el); const isScreen=pub.source===Track.Source.ScreenShareAudio; const sinks=isScreen?screenAudio:audio; sinks.set(participant.identity,[...(sinks.get(participant.identity)||[]),el as HTMLAudioElement]); apply(participant.identity,isScreen); if(track.kind===Track.Kind.Video) remotes.forEach(f=>f(participant.identity,new MediaStream([track.mediaStreamTrack]),pub.trackSid)); });
 room.on(RoomEvent.TrackUnsubscribed, (track,pub,participant) => { track.detach().forEach(e=>e.remove()); if(track.kind===Track.Kind.Video) remotes.forEach(f=>f(participant.identity,null,pub.trackSid)); });
 room.on(RoomEvent.ActiveSpeakersChanged, list => speakers.forEach(f=>f(list.map(p=>p.identity))));
 room.on(RoomEvent.ConnectionQualityChanged, (_,q) => qualities.forEach(f=>f(q==="poor"?"poor":q==="good"?"good":"medium")));
 room.on(RoomEvent.Disconnected,()=>{active=null;current=null;});
}
export function init(_:string) {}
export async function joinCall(id:string, isMuted:boolean, _:boolean) { await leaveCall(); const c=await credentials(id); const room=new Room({adaptiveStream:true,dynacast:true}); bind(room); await room.connect(c.url,c.token); active=room;current=id; await room.localParticipant.setMicrophoneEnabled(!isMuted); }
export async function leaveCall() { active?.disconnect(); active=null;current=null; screen?.getTracks().forEach(t=>t.stop());screen=null; }
export async function setLocalAudioState(isMuted:boolean, _:boolean) { await active?.localParticipant.setMicrophoneEnabled(!isMuted); }
export async function startCamera(_:string,__:string,deviceId?:string) { if(!active)return; await active.localParticipant.setCameraEnabled(true,{deviceId,resolution:{width:1280,height:720}}); const pub=[...active.localParticipant.videoTrackPublications.values()].find(p=>p.source===Track.Source.Camera); cameras.forEach(f=>f(pub?.track?new MediaStream([pub.track.mediaStreamTrack]):null)); }
export async function stopCamera(_:string,__:string) { await active?.localParticipant.setCameraEnabled(false); cameras.forEach(f=>f(null)); }
export async function switchCamera(deviceId:string) { await stopCamera("",""); await startCamera("","",deviceId); }
export function onLocalCamera(f:(s:MediaStream|null)=>void) { cameras.add(f);return()=>cameras.delete(f); }
export async function publishScreen(_:string,__:string,source:string,height:number,fps:number,withAudio:boolean) { if(!active)return;screenSource=source;screenAudioEnabled=withAudio;screen=startNativeScreen(source,height,fps,withAudio); for(const t of screen.getTracks()) await active.localParticipant.publishTrack(t,{source:t.kind==="audio"?Track.Source.ScreenShareAudio:Track.Source.ScreenShare,simulcast:t.kind==="video"}); }
export async function unpublishScreen(_:string,__:string) { if(active) for(const p of active.localParticipant.trackPublications.values()) if(p.source===Track.Source.ScreenShare||p.source===Track.Source.ScreenShareAudio) await active.localParticipant.unpublishTrack(p.trackSid); stopNativeScreen();screen?.getTracks().forEach(t=>t.stop());screen=null; }
export function reconfigureScreen(h:number,f:number){reconfigureNativeScreen(screenSource,h,f,screenAudioEnabled)} export function switchScreenSource(source:string){screenSource=source} export function getLocalScreenStream(){return screen}
export function watchStream(_:string,sid:string,__:string){active?.remoteParticipants.forEach(p=>p.trackPublications.get(sid)?.setSubscribed(true))} export function stopWatchingStream(_:string,sid:string,__:string){active?.remoteParticipants.forEach(p=>p.trackPublications.get(sid)?.setSubscribed(false))}
export async function spectate(id:string,sid:string,owner:string){if(!active){const c=await credentials(id,"spectator");const r=new Room({adaptiveStream:true,dynacast:true});bind(r);await r.connect(c.url,c.token);active=r;current=id}watchStream(id,sid,owner)} export function stopSpectate(_:string){}
export function onRemoteStream(f:Remote){remotes.add(f);return()=>remotes.delete(f)} export function onSpeaking(f:(v:string[])=>void){speakers.add(f);return()=>speakers.delete(f)} export function onConnectionQuality(f:(v:ConnQuality)=>void){qualities.add(f);return()=>qualities.delete(f)}
export function setPeerVolume(id:string,v:number){volumes.set(id,v);persist("tk.peerVolumes",volumes);apply(id)} export function getPeerVolumes(){return Object.fromEntries(volumes)} export function setPeerAudioMuted(id:string,v:boolean){muted.set(id,v);apply(id)}
export function setScreenAudioVolume(id:string,v:number){screenVolumes.set(id,v);persist("tk.screenVolumes",screenVolumes);apply(id,true)} export function getScreenAudioVolumes(){return Object.fromEntries(screenVolumes)} export function setScreenAudioMuted(id:string,v:boolean){screenMuted.set(id,v);apply(id,true)}
export async function listCameras(){return (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput").map(d=>({deviceId:d.deviceId,label:d.label}))} export function setNoiseSuppression(v:boolean){noiseSuppression.setEnabled(v)} export function ensureChannel(_:string){}
