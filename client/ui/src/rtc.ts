// Mesh WebRTC engine — moved here from client/native/Tupi.Client/RtcEngine.cs
// (see SDD/27-decisions.md ADR-009). Runs on the real browser RTCPeerConnection
// inside WebView2's Chromium engine instead of a thin hand-rolled C#/libvpx
// wrapper: real congestion control (GCC), real bitrate/rate control, real
// NACK/PLI/FEC, real screen-content coding — all of it verified broken or
// absent in the pinned SIPSorceryMedia.Encoders 0.0.13 package (ADR-008).
//
// Topology is unchanged: still one RTCPeerConnection per remote participant
// (mesh), still P2P with TURN only as an ICE fallback — nothing here talks to
// a media server. Only the implementation of the peer connection moved.
//
// The native host (IpcBridge.cs) no longer understands any of this — it is a
// pure relay: `rtc.offer`/`rtc.answer`/`rtc.ice`/`stream.publish`/
// `stream.unpublish`/`stream.subscribe`/`stream.unsubscribe`/`call.join`/
// `call.leave`/`call.state.update` all pass straight through to the
// authenticated WebSocket, and every WS event is forwarded here unchanged via
// the existing `Publish(op, data)` catch-all IpcBridge already had.
import { send, subscribe, Envelope } from "./ipc";
import { startNativeScreen, stopNativeScreen } from "./nativeScreen";
import { pauseNativeMusic, startNativeMusic, stopNativeMusic } from "./nativeMusic";
import * as noiseSuppression from "./noiseSuppression";

type TurnCredentials = { username: string; credential: string; uris: string[] };
type RemoteStreamListener = (peerUserId: string, stream: MediaStream | null) => void;

const peers = new Map<string, RTCPeerConnection>();
const pendingPeers = new Map<string, Promise<RTCPeerConnection>>();
const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
const remoteDescriptionSet = new Set<string>();
const iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteAudioEls = new Map<string, HTMLAudioElement>();
// One <audio> per peer, fed by a persistent MediaStream that accumulates
// every audio track that peer sends (mic + screen-share loopback), so a
// second track doesn't replace the first.
const remoteAudioStreams = new Map<string, MediaStream>();
// Per-participant local mute (the "Silenciar" control on a tile). Kept
// separate from deafen so unmuting a peer doesn't un-deafen everything.
const peerAudioMuted = new Map<string, boolean>();
const pendingTurnRequests = new Map<string, (creds: TurnCredentials) => void>();
const remoteVideoListeners = new Set<RemoteStreamListener>();

// Realtime call-connection quality (signal-bars in the voice panel). Sampled
// from RTCPeerConnection.getStats() across the whole mesh — worst RTT + worst
// outbound packet loss over every peer — and mapped to good/medium/poor.
export type ConnQuality = "good" | "medium" | "poor";
type ConnQualityListener = (quality: ConnQuality) => void;
const connQualityListeners = new Set<ConnQualityListener>();
let connQualityTimer: ReturnType<typeof setInterval> | null = null;
let lastConnQuality: ConnQuality = "good";

let selfUserId: string | null = null;
let currentChannelId: string | null = null;
// True only when we are a full call participant (joinCall). A client can also
// hold peer connections purely as a *spectator* of someone's screen share in a
// channel it never joined — see spectate()/stopSpectate().
let joinedCall = false;
// channelId + streamId for each owner we are spectating (hover preview from
// the sidebar), so stopSpectate can unsubscribe and tear the peer down.
const spectatedStreams = new Map<string, { channelId: string; streamId: string }>();
// (Owner side) peers we only connected to because they asked to spectate our
// screen — closed again as soon as they unsubscribe.
const spectatorPeers = new Set<string>();
// `localStream` is what peers receive — the RNNoise-denoised mic. `rawMic`
// is the untouched getUserMedia stream, kept only so it can be stopped on
// leave.
let localStream: MediaStream | null = null;
let rawMic: MediaStream | null = null;
let noiseSuppressionOn = true;
let localMuted = false;
let localDeafened = false;

// Screen share (send side): at most one active local publish at a time (v1
// simplification also documented on the old RtcEngine.cs). `subscribers` is
// the set of peer user ids the server has told us are watching — nothing is
// sent to a peer until it appears here, mirroring the old send-side gate
// that avoided a renegotiation storm on every subscribe/unsubscribe.
let localScreenTrack: MediaStreamTrack | null = null;
let localScreenStream: MediaStream | null = null;
const screenSubscribers = new Set<string>();
// Per-peer transceivers for our outgoing screen tracks (one video, and one
// audio when the source carries process-loopback audio). Created ONCE per peer
// the first time we send it our screen, then reused for every later
// subscribe/unsubscribe via replaceTrack + direction — never removeTrack.
// removeTrack keeps the transceiver but re-emits its m-line on the next offer,
// so a fresh addTrack each subscribe accumulated dead m-lines until the SDP
// blew past the server's 64 KiB relay cap during repeated hover-previews.
type ScreenSlots = { video: RTCRtpTransceiver; audio: RTCRtpTransceiver | null; active: boolean };
const screenSlots = new Map<string, ScreenSlots>();
// Peers whose screen m-lines were changed while signalling was mid-negotiation
// (can't createOffer yet). Retried from handleIncomingOffer/Answer once stable.
const screenNeedsOffer = new Set<string>();
let localMusicTrack: MediaStreamTrack | null = null;
const musicSlots = new Map<string, RTCRtpTransceiver>();

// Offers/answers we relay carry no value in their inline ICE candidates — we
// trickle every candidate over rtc.ice anyway — and a full candidate list can
// add tens of KiB to a renegotiation. Strip them before send() so the payload
// stays well under the server's 64 KiB guard.
function stripSdpCandidates(sdp: string | undefined): string {
  if (!sdp) return "";
  return sdp
    .replace(/^a=candidate:.*(\r\n|\n)/gm, "")
    .replace(/^a=end-of-candidates.*(\r\n|\n)/gm, "");
}

function sendSdp(op: "rtc.offer" | "rtc.answer", channelId: string, to: string, sdp: string | undefined) {
  send(op, { channel_id: channelId, to, sdp: stripSdpCandidates(sdp) });
}

function requestTurnCredentials(): Promise<TurnCredentials> {
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    pendingTurnRequests.set(requestId, resolve);
    send("rtc.turn_credentials.request", { request_id: requestId });
  });
}

function emitRemoteStream(peerUserId: string, stream: MediaStream | null) {
  console.log(`[rtc] emitRemoteStream(${peerUserId}, ${stream ? "stream" : "null"}) to ${remoteVideoListeners.size} listener(s)`);
  remoteVideoListeners.forEach(listener => listener(peerUserId, stream));
}

function getOrCreatePeer(peerUserId: string): Promise<RTCPeerConnection> {
  const existing = peers.get(peerUserId);
  if (existing) return Promise.resolve(existing);
  // Memoize the in-flight creation itself, not just the finished
  // RTCPeerConnection: this function awaits TURN credentials before the
  // connection is registered in `peers`, so two calls for the same peer
  // arriving before that resolves would otherwise create two separate
  // RTCPeerConnections (and two video transceivers) for one peer.
  const pending = pendingPeers.get(peerUserId);
  if (pending) return pending;

  const creation = createPeer(peerUserId).finally(() => pendingPeers.delete(peerUserId));
  pendingPeers.set(peerUserId, creation);
  return creation;
}

async function createPeer(peerUserId: string): Promise<RTCPeerConnection> {
  const turn = await requestTurnCredentials();
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: turn.uris, username: turn.username, credential: turn.credential }],
  });
  peers.set(peerUserId, pc);
  console.log(`[rtc] peer connection created for ${peerUserId}`);

  if (localStream) for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  // No microphone on this machine — still negotiate an audio m-line so we
  // can HEAR the other side (without this the offer has no audio section
  // and the peer never sends us any).
  else pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = event => {
    console.log(`[rtc] ontrack from ${peerUserId}: kind=${event.track.kind} streams=${event.streams.length} readyState=${event.track.readyState}`);
    if (event.track.kind === "audio") {
      let audioStream = remoteAudioStreams.get(peerUserId);
      if (!audioStream) { audioStream = new MediaStream(); remoteAudioStreams.set(peerUserId, audioStream); }
      audioStream.addTrack(event.track);
      event.track.onended = () => { try { audioStream!.removeTrack(event.track); } catch { /* gone */ } };
      let audioEl = remoteAudioEls.get(peerUserId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        audioEl.srcObject = audioStream;
        remoteAudioEls.set(peerUserId, audioEl);
      }
      // A pure spectator (previewing a screen share without joining the call)
      // should never hear the call — mute every remote audio track while not
      // an actual participant.
      audioEl.muted = !joinedCall || localDeafened || (peerAudioMuted.get(peerUserId) ?? false);
      void audioEl.play().catch(error => console.error("[rtc] remote audio play() failed", error));
    } else if (event.track.kind === "video") {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      emitRemoteStream(peerUserId, stream);
      event.track.onended = () => { console.log(`[rtc] remote video track ended for ${peerUserId}`); emitRemoteStream(peerUserId, null); };
    }
  };

  pc.onicecandidate = event => {
    if (!event.candidate || !currentChannelId) return;
    send("rtc.ice", {
      channel_id: currentChannelId,
      to: peerUserId,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      },
    });
  };

  // RTC-FR (reconexão): only the deterministically "lower id" side restarts
  // ICE — same convention used to decide who offers first — so both ends of
  // a degraded link do not restart at the same time and race each other (a
  // scoped simplification, not full Perfect Negotiation collision recovery;
  // see SDD/27-decisions.md).
  pc.onconnectionstatechange = () => {
    const timer = iceRestartTimers.get(peerUserId);
    if (timer) { clearTimeout(timer); iceRestartTimers.delete(peerUserId); }
    if (!selfUserId || selfUserId >= peerUserId) return;

    if (pc.connectionState === "disconnected") {
      // Transient packet-loss bursts are common; give it a grace period
      // before treating this as a real network failure.
      const timeout = setTimeout(() => { void restartIce(peerUserId, pc); }, 5000);
      iceRestartTimers.set(peerUserId, timeout);
    } else if (pc.connectionState === "failed") {
      void restartIce(peerUserId, pc);
    }
  };

  return pc;
}

async function restartIce(peerUserId: string, pc: RTCPeerConnection) {
  if (!currentChannelId) return;
  try {
    pc.restartIce();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSdp("rtc.offer", currentChannelId, peerUserId, offer.sdp);
  } catch (error) {
    console.error("ICE restart failed", peerUserId, error);
  }
}

function logTransceivers(label: string, peerUserId: string, pc: RTCPeerConnection) {
  for (const transceiver of pc.getTransceivers()) {
    console.log(`[rtc] ${label} peer=${peerUserId} kind=${transceiver.receiver.track?.kind ?? transceiver.sender.track?.kind ?? "?"} mid=${transceiver.mid} direction=${transceiver.direction} currentDirection=${transceiver.currentDirection}`);
  }
}

// The native host can deliver the same WS event more than once (observed:
// duplicate rtc.offer/rtc.answer -> "setRemoteDescription ... wrong state:
// stable"). Serialise every SDP operation per peer and dedupe stale ones so
// a repeat delivery is a harmless no-op instead of a desync.
const sdpLocks = new Map<string, Promise<unknown>>();
const lastRemoteSdp = new Map<string, string>();

function withSdpLock(peerUserId: string, task: () => Promise<void>): Promise<void> {
  const previous = sdpLocks.get(peerUserId) ?? Promise.resolve();
  const next = previous.then(task, task).catch(error => console.error(`[rtc] SDP op failed for ${peerUserId}`, error));
  sdpLocks.set(peerUserId, next);
  return next;
}

function connectToPeer(peerUserId: string, channelId?: string) {
  if (channelId) currentChannelId = channelId;
  return withSdpLock(peerUserId, async () => {
    if (!currentChannelId) { console.warn(`[rtc] connectToPeer ${peerUserId}: no channel id yet, skipping`); return; }
    const pc = await getOrCreatePeer(peerUserId);
    if (pc.signalingState !== "stable" || pc.localDescription) {
      console.log(`[rtc] connectToPeer ${peerUserId}: already negotiating/established (${pc.signalingState}), skipping`);
      return;
    }
    console.log(`[rtc] connectToPeer ${peerUserId} (I am offerer)`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    logTransceivers("after setLocalDescription(offer)", peerUserId, pc);
    sendSdp("rtc.offer", currentChannelId, peerUserId, offer.sdp);
  });
}

function handleIncomingOffer(data: any) {
  if (data.channel_id) currentChannelId = data.channel_id;
  const peerUserId: string = data.from;
  return withSdpLock(peerUserId, async () => {
    if (lastRemoteSdp.get(peerUserId) === data.sdp) {
      console.log(`[rtc] handleIncomingOffer from ${peerUserId}: duplicate offer, ignoring`);
      return;
    }
    console.log(`[rtc] handleIncomingOffer from ${peerUserId} (I am answerer)`);
    const pc = await getOrCreatePeer(peerUserId);
    if (pc.signalingState !== "stable") {
      // Glare: a renegotiation offer landed while our own local description
      // was half-applied. Roll ours back and take theirs — the screen-share
      // owner is the single source of truth for the video m-line.
      try { await pc.setLocalDescription({ type: "rollback" }); } catch { /* already stable */ }
    }
    await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
    lastRemoteSdp.set(peerUserId, data.sdp);
    logTransceivers("after setRemoteDescription(offer)", peerUserId, pc);
    remoteDescriptionSet.add(peerUserId);
    await flushPendingCandidates(peerUserId, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    logTransceivers("after setLocalDescription(answer)", peerUserId, pc);
    sendSdp("rtc.answer", data.channel_id ?? currentChannelId, peerUserId, answer.sdp);
  }).then(() => {
    // Now that signalling is back to stable: (re)start the screen send for any
    // peer subscribed to it, and flush a renegotiation that had to be deferred.
    if (localScreenStream && screenSubscribers.has(peerUserId)) void applyScreenSend(peerUserId, true);
    if (localMusicTrack) void applyMusicSend(peerUserId, true);
  });
}

function handleIncomingAnswer(data: any) {
  const peerUserId: string = data.from;
  return withSdpLock(peerUserId, async () => {
    const pc = peers.get(peerUserId);
    if (!pc) { console.warn(`[rtc] handleIncomingAnswer: no peer connection for ${peerUserId} yet`); return; }
    if (pc.signalingState !== "have-local-offer") {
      console.log(`[rtc] handleIncomingAnswer from ${peerUserId}: not awaiting an answer (${pc.signalingState}), ignoring`);
      return;
    }
    console.log(`[rtc] handleIncomingAnswer from ${peerUserId}`);
    await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    logTransceivers("after setRemoteDescription(answer)", peerUserId, pc);
    remoteDescriptionSet.add(peerUserId);
    await flushPendingCandidates(peerUserId, pc);
  }).then(() => {
    if (localScreenStream && screenSubscribers.has(peerUserId)) void applyScreenSend(peerUserId, true);
    if (localMusicTrack) void applyMusicSend(peerUserId, true);
  });
}

async function flushPendingCandidates(peerUserId: string, pc: RTCPeerConnection) {
  const queued = pendingCandidates.get(peerUserId);
  if (!queued) return;
  pendingCandidates.delete(peerUserId);
  for (const candidate of queued) {
    try { await pc.addIceCandidate(candidate); } catch (error) { console.error("addIceCandidate failed", error); }
  }
}

async function handleIncomingIce(data: any) {
  const peerUserId: string = data.from;
  const candidate: RTCIceCandidateInit = data.candidate;
  const pc = peers.get(peerUserId);
  // A candidate can legitimately arrive before the offer/answer that
  // creates the peer connection's remote description (real network
  // reordering, unlike SIPSorcery which tolerated this internally) —
  // queue it and flush once setRemoteDescription resolves.
  if (!pc || !remoteDescriptionSet.has(peerUserId)) {
    const queue = pendingCandidates.get(peerUserId) ?? [];
    queue.push(candidate);
    pendingCandidates.set(peerUserId, queue);
    return;
  }
  try { await pc.addIceCandidate(candidate); } catch (error) { console.error("addIceCandidate failed", error); }
}

function closePeer(peerUserId: string) {
  const pc = peers.get(peerUserId);
  if (pc) { pc.close(); peers.delete(peerUserId); }
  screenSlots.delete(peerUserId);
  musicSlots.delete(peerUserId);
  screenNeedsOffer.delete(peerUserId);
  spectatedStreams.delete(peerUserId);
  spectatorPeers.delete(peerUserId);
  pendingCandidates.delete(peerUserId);
  remoteDescriptionSet.delete(peerUserId);
  sdpLocks.delete(peerUserId);
  lastRemoteSdp.delete(peerUserId);
  screenSubscribers.delete(peerUserId);
  const timer = iceRestartTimers.get(peerUserId);
  if (timer) { clearTimeout(timer); iceRestartTimers.delete(peerUserId); }
  const audioEl = remoteAudioEls.get(peerUserId);
  if (audioEl) { audioEl.srcObject = null; remoteAudioEls.delete(peerUserId); }
  remoteAudioStreams.delete(peerUserId);
  emitRemoteStream(peerUserId, null);
}

async function applyMusicSend(peerUserId: string, sending: boolean) {
  return withSdpLock(peerUserId, async () => {
    const pc = peers.get(peerUserId); if (!pc) return;
    let slot = musicSlots.get(peerUserId);
    if (sending && localMusicTrack) {
      if (!slot) { slot = pc.addTransceiver(localMusicTrack, { direction: "sendonly" }); musicSlots.set(peerUserId, slot); }
      else { await slot.sender.replaceTrack(localMusicTrack); slot.direction = "sendonly"; }
    } else if (slot) { await slot.sender.replaceTrack(null); slot.direction = "inactive"; }
    if (!currentChannelId || pc.signalingState !== "stable") return;
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    sendSdp("rtc.offer", currentChannelId, peerUserId, offer.sdp);
  });
}

/// Handles every WS event forwarded by the native host. Call this from the
/// same `subscribe` callback the rest of the UI uses — it only reacts to
/// the ops it owns and ignores everything else.
function handleEnvelope(event: Envelope) {
  const data = event.data;
  switch (event.op) {
    case "rtc.turn_credentials": {
      const resolver = pendingTurnRequests.get(data.request_id);
      if (resolver) { pendingTurnRequests.delete(data.request_id); resolver(data); }
      break;
    }
    case "call.snapshot": {
      if (data.channel_id) currentChannelId = data.channel_id;
      if (!selfUserId) break;
      for (const participant of data.participants ?? []) {
        const peerUserId: string = participant.user_id;
        if (peerUserId !== selfUserId && selfUserId < peerUserId) void connectToPeer(peerUserId, data.channel_id).then(() => { if (localMusicTrack) void applyMusicSend(peerUserId, true); });
      }
      break;
    }
    case "call.peer_joined": {
      if (data.channel_id) currentChannelId = data.channel_id;
      const peerUserId: string = data.participant.user_id;
      if (selfUserId && peerUserId !== selfUserId && selfUserId < peerUserId) void connectToPeer(peerUserId, data.channel_id).then(() => { if (localMusicTrack) void applyMusicSend(peerUserId, true); });
      break;
    }
    case "call.peer_left":
      closePeer(data.user_id);
      break;
    case "rtc.offer":
      void handleIncomingOffer(data);
      break;
    case "rtc.answer":
      void handleIncomingAnswer(data);
      break;
    case "rtc.ice":
      void handleIncomingIce(data);
      break;
    // SUB-FR-001: these two ops are only ever routed to the stream's *owner*
    // by the server — receiving one here means this client must start or
    // stop sending its screen share to the named peer.
    case "stream.subscription_requested":
      console.log(`[rtc] stream.subscription_requested from ${data.subscriber}`);
      void setScreenSubscription(data.subscriber, true);
      break;
    case "stream.unsubscribed":
      console.log(`[rtc] stream.unsubscribed from ${data.subscriber}`);
      void setScreenSubscription(data.subscriber, false);
      break;
    case "stream.unpublished":
      // Nothing more will ever arrive for this stream — if we were watching
      // its owner, tear down the rendered video (owner already stopped
      // sending, but the element would otherwise show a frozen last frame).
      emitRemoteStream(data.owner ?? "", null);
      break;
  }
}

async function setScreenSubscription(peerUserId: string, subscribed: boolean) {
  if (subscribed) screenSubscribers.add(peerUserId); else screenSubscribers.delete(peerUserId);
  // A spectator (subscribed but never joined the call) has no peer connection
  // yet — the stream owner has to initiate one, ignoring the usual
  // lower-id-offers rule since the spectator will never offer.
  if (subscribed && !peers.get(peerUserId) && currentChannelId) {
    spectatorPeers.add(peerUserId);
    await connectToPeer(peerUserId, currentChannelId);
  }
  // A spectator-only peer has no reason to stay connected once it unsubscribes
  // — just drop the whole peer connection instead of renegotiating it idle.
  if (!subscribed && spectatorPeers.has(peerUserId)) {
    spectatorPeers.delete(peerUserId);
    closePeer(peerUserId);
    return;
  }
  await applyScreenSend(peerUserId, subscribed && localScreenStream !== null);
}

/// Owner side: activate or idle THIS peer's dedicated screen transceiver(s),
/// then renegotiate once. The transceivers are created a single time and then
/// reused for the lifetime of the peer connection — toggling is replaceTrack +
/// direction, never removeTrack — so repeated hover-previews/subscribes can no
/// longer accumulate dead m-lines and push the SDP past the relay's 64 KiB cap.
function applyScreenSend(peerUserId: string, sending: boolean) {
  return withSdpLock(peerUserId, async () => {
    const pc = peers.get(peerUserId);
    if (!pc) { console.warn(`[rtc] applyScreenSend(${peerUserId}, ${sending}) — no peer yet`); return; }
    let slots = screenSlots.get(peerUserId);

    if (sending) {
      if (!localScreenStream) { console.warn(`[rtc] applyScreenSend(${peerUserId}, true) — no local screen stream`); return; }
      const videoTrack = localScreenStream.getVideoTracks()[0] ?? null;
      const audioTrack = localScreenStream.getAudioTracks()[0] ?? null;
      const alreadyCorrect = !!slots
        && slots.active
        && slots.video.sender.track === videoTrack
        && (slots.audio?.sender.track ?? null) === audioTrack;

      if (!slots) {
        const video = pc.addTransceiver(videoTrack ?? "video", { direction: "sendonly", streams: [localScreenStream] });
        const audio = audioTrack
          ? pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [localScreenStream] })
          : null;
        slots = { video, audio, active: true };
        screenSlots.set(peerUserId, slots);
        screenNeedsOffer.add(peerUserId);
        console.log(`[rtc] applyScreenSend ${peerUserId}: created screen transceivers (audio=${!!audio})`);
      } else if (!alreadyCorrect) {
        await slots.video.sender.replaceTrack(videoTrack);
        slots.video.direction = "sendonly";
        if (audioTrack) {
          if (!slots.audio) {
            slots.audio = pc.addTransceiver(audioTrack, { direction: "sendonly", streams: [localScreenStream] });
          } else {
            await slots.audio.sender.replaceTrack(audioTrack);
            slots.audio.direction = "sendonly";
          }
        } else if (slots.audio) {
          await slots.audio.sender.replaceTrack(null);
          slots.audio.direction = "inactive";
        }
        slots.active = true;
        screenNeedsOffer.add(peerUserId);
        console.log(`[rtc] applyScreenSend ${peerUserId}: reactivated screen transceivers`);
      } else if (!screenNeedsOffer.has(peerUserId)) {
        console.log(`[rtc] applyScreenSend ${peerUserId}: already sending`);
        return;
      }
    } else {
      if (!slots || !slots.active) return;
      await slots.video.sender.replaceTrack(null);
      slots.video.direction = "inactive";
      if (slots.audio) {
        await slots.audio.sender.replaceTrack(null);
        slots.audio.direction = "inactive";
      }
      slots.active = false;
      screenNeedsOffer.add(peerUserId);
      console.log(`[rtc] applyScreenSend ${peerUserId}: idled screen transceivers`);
    }

    if (!screenNeedsOffer.has(peerUserId)) return;
    // Can't renegotiate mid-flight — retried from handleIncomingOffer/Answer.
    if (!currentChannelId || pc.signalingState !== "stable") return;
    screenNeedsOffer.delete(peerUserId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSdp("rtc.offer", currentChannelId, peerUserId, offer.sdp);
  });
}

export function init(currentUserId: string) {
  selfUserId = currentUserId;
  subscribe(handleEnvelope);
}

/// Tell the engine which voice channel is active without (re)capturing the
/// mic — used when the UI shows us already in a call (e.g. a call.snapshot
/// that arrived before this module subscribed) so signalling has a channel
/// id even though joinCall was never called this session.
export function ensureChannel(channelId: string) {
  if (!currentChannelId) currentChannelId = channelId;
}

/// Captures the microphone and applies the current mute/deafen state to it.
/// Peer connections created afterward (via call.snapshot/call.peer_joined)
/// pick up this track automatically; peers already connected before join
/// would be unusual (join always happens before any peer exists) so no
/// renegotiation-on-late-mic path is needed.
export async function joinCall(channelId: string, muted: boolean, deafened: boolean) {
  currentChannelId = channelId;
  joinedCall = true;
  localMuted = muted;
  localDeafened = deafened;
  try {
    // Chromium's built-in audio processing (WebRTC APM): steady-state noise
    // suppression, acoustic echo cancellation, automatic gain. Free, no
    // dependency — the baseline before any ML denoiser.
    rawMic = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Chromium's own APM: echo cancellation + AGC still help; leave its
        // noise suppression on too (RNNoise runs after it and they stack
        // fine — this is the pre-ML baseline).
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    // Denoise locally with RNNoise before anything reaches a peer.
    localStream = await noiseSuppression.processMic(rawMic, noiseSuppressionOn);
    applyLocalAudioState();
  } catch (error) {
    console.error("getUserMedia failed — joining call without a microphone", error);
    localStream = null;
    rawMic = null;
  }
  send("call.join", { channel_id: channelId, req_id: crypto.randomUUID(), muted, deafened });
  startConnQualitySampling();
  startSpeakingSampling();
}

export async function leaveCall() {
  if (!currentChannelId) return;
  stopConnQualitySampling();
  stopSpeakingSampling();
  send("call.leave", { channel_id: currentChannelId, req_id: crypto.randomUUID() });
  for (const peerUserId of Array.from(peers.keys())) closePeer(peerUserId);
  stopNativeScreen();
  stopNativeMusic(); localMusicTrack = null; musicSlots.clear();
  if (localScreenTrack) { localScreenTrack.stop(); localScreenTrack = null; }
  localScreenStream = null;
  screenSlots.clear();
  screenNeedsOffer.clear();
  screenSubscribers.clear();
  spectatedStreams.clear();
  spectatorPeers.clear();
  if (localStream) { for (const track of localStream.getTracks()) track.stop(); localStream = null; }
  if (rawMic) { for (const track of rawMic.getTracks()) track.stop(); rawMic = null; }
  void noiseSuppression.teardown();
  joinedCall = false;
  currentChannelId = null;
}

/// Spectator preview: subscribe to someone's screen share in a channel we have
/// NOT joined, so a sidebar hover can show a live thumbnail. The stream owner
/// initiates the peer connection on its side (setScreenSubscription).
export function spectate(channelId: string, streamId: string, ownerUserId: string) {
  if (!currentChannelId) currentChannelId = channelId;
  spectatedStreams.set(ownerUserId, { channelId, streamId });
  send("stream.subscribe", { channel_id: channelId, stream_id: streamId, owner_user_id: ownerUserId });
}

export function stopSpectate(ownerUserId: string) {
  const entry = spectatedStreams.get(ownerUserId);
  spectatedStreams.delete(ownerUserId);
  if (entry) {
    send("stream.unsubscribe", { channel_id: entry.channelId, stream_id: entry.streamId, owner_user_id: ownerUserId });
  }
  emitRemoteStream(ownerUserId, null);
  // A pure spectator peer connection has no other reason to exist — drop it.
  if (!joinedCall) {
    closePeer(ownerUserId);
    if (spectatedStreams.size === 0) currentChannelId = null;
  }
}

/// Toggle RNNoise on/off (the "crisp" control). Rewires the audio graph in
/// place, so the outgoing track — and therefore the SDP — is unaffected.
export function setNoiseSuppression(on: boolean) {
  noiseSuppressionOn = on;
  noiseSuppression.setEnabled(on);
}
export function isNoiseSuppressionOn() {
  return noiseSuppressionOn;
}

function applyLocalAudioState() {
  if (!localStream) return;
  const shouldSend = !localMuted && !localDeafened;
  for (const track of localStream.getAudioTracks()) track.enabled = shouldSend;
}

export function setLocalAudioState(muted: boolean, deafened: boolean) {
  localMuted = muted;
  localDeafened = deafened;
  applyLocalAudioState();
  applyRemoteMuting();
  if (currentChannelId) send("call.state.update", { channel_id: currentChannelId, muted, deafened, req_id: crypto.randomUUID() });
}

function applyRemoteMuting() {
  for (const [peerUserId, audioEl] of remoteAudioEls) {
    audioEl.muted = !joinedCall || localDeafened || (peerAudioMuted.get(peerUserId) ?? false);
  }
}

/// Local-only mute of a single participant's audio ("Silenciar" on a tile).
export function setPeerAudioMuted(peerUserId: string, isMuted: boolean) {
  peerAudioMuted.set(peerUserId, isMuted);
  applyRemoteMuting();
}

/// SCREEN-FR-001/SUB-FR-001: capture starts immediately (via the native
/// borderless GDI capture path — no getDisplayMedia, so no Chromium capture
/// border), but nothing is sent to any peer until each viewer's
/// stream.subscribe arrives as stream.subscription_requested — see
/// setScreenSubscription. `sourceId` comes from the in-app picker
/// ("screen:all" | "screen:<n>" | "window:<hwnd>").
export async function publishScreen(channelId: string, streamId: string, sourceId: string, targetHeight: number, targetFps: number, withAudio: boolean) {
  localScreenStream = startNativeScreen(sourceId, targetHeight, targetFps, withAudio);
  localScreenTrack = localScreenStream?.getVideoTracks()[0] ?? null;
  const hasAudio = (localScreenStream?.getAudioTracks().length ?? 0) > 0;
  console.log(`[rtc] publishScreen: ${sourceId} video=${localScreenTrack?.readyState} audio=${hasAudio} subs=[${Array.from(screenSubscribers).join(",")}]`);
  // Anyone who already subscribed (before we had a track) now gets it.
  for (const peerUserId of screenSubscribers) await applyScreenSend(peerUserId, true);
  send("stream.publish", { channel_id: channelId, stream_id: streamId, kind: "screen", has_audio: hasAudio, req_id: crypto.randomUUID() });
}

export async function unpublishScreen(channelId: string, streamId: string) {
  const formerSubscribers = Array.from(screenSubscribers);
  screenSubscribers.clear();
  for (const peerUserId of formerSubscribers) await applyScreenSend(peerUserId, false);
  stopNativeScreen();
  if (localScreenTrack) { localScreenTrack.stop(); localScreenTrack = null; }
  localScreenStream = null;
  send("stream.unpublish", { channel_id: channelId, stream_id: streamId, req_id: crypto.randomUUID() });
}

/** Publish local-DJ audio to every call peer. The server's music stream
 * metadata makes it visible in the roster; audio remains direct WebRTC. */
export async function playMusic(channelId: string, streamId: string, query: string) {
  localMusicTrack = startNativeMusic(query);
  if (!localMusicTrack) throw new Error("Seu WebView2 não oferece AudioData/TrackGenerator.");
  for (const peerUserId of peers.keys()) await applyMusicSend(peerUserId, true);
  send("stream.publish", { channel_id: channelId, stream_id: streamId, kind: "music", label: query, has_audio: true, req_id: crypto.randomUUID() });
}
export async function stopMusic(channelId: string, streamId: string) {
  for (const peerUserId of peers.keys()) await applyMusicSend(peerUserId, false);
  stopNativeMusic(); localMusicTrack = null;
  send("stream.unpublish", { channel_id: channelId, stream_id: streamId, req_id: crypto.randomUUID() });
}
export function setMusicPaused(paused: boolean) { pauseNativeMusic(paused); }

export function watchStream(channelId: string, streamId: string, ownerUserId: string) {
  console.log(`[rtc] watchStream: subscribing to ${ownerUserId}'s stream ${streamId}`);
  send("stream.subscribe", { channel_id: channelId, stream_id: streamId, owner_user_id: ownerUserId });
}

export function stopWatchingStream(channelId: string, streamId: string, ownerUserId: string) {
  console.log(`[rtc] stopWatchingStream: unsubscribing from ${ownerUserId}'s stream ${streamId}`);
  send("stream.unsubscribe", { channel_id: channelId, stream_id: streamId, owner_user_id: ownerUserId });
  emitRemoteStream(ownerUserId, null);
}

export function onRemoteStream(listener: RemoteStreamListener) {
  remoteVideoListeners.add(listener);
  return () => { remoteVideoListeners.delete(listener); };
}

/// Subscribe to realtime call-connection quality. Fires the current value
/// immediately, then on every change while in a call. Sampling only runs
/// between joinCall() and leaveCall().
export function onConnectionQuality(listener: ConnQualityListener) {
  connQualityListeners.add(listener);
  listener(lastConnQuality);
  return () => { connQualityListeners.delete(listener); };
}

function emitConnQuality(quality: ConnQuality) {
  if (quality === lastConnQuality) return;
  lastConnQuality = quality;
  connQualityListeners.forEach(listener => listener(quality));
}

async function sampleConnQuality() {
  const pcs = Array.from(peers.values());
  if (pcs.length === 0) { emitConnQuality("good"); return; }
  let worstRtt = 0;
  let worstLoss = 0;
  let anyDown = false;
  for (const pc of pcs) {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") anyDown = true;
    try {
      const stats = await pc.getStats();
      stats.forEach(report => {
        const r = report as unknown as Record<string, unknown>;
        if (r.type === "candidate-pair" && r.nominated === true && r.state === "succeeded"
          && typeof r.currentRoundTripTime === "number") {
          worstRtt = Math.max(worstRtt, r.currentRoundTripTime);
        }
        if (r.type === "remote-inbound-rtp" && typeof r.fractionLost === "number") {
          worstLoss = Math.max(worstLoss, r.fractionLost);
        }
      });
    } catch { /* stats momentarily unavailable for this peer */ }
  }
  if (anyDown || worstRtt >= 0.4 || worstLoss >= 0.1) emitConnQuality("poor");
  else if (worstRtt >= 0.15 || worstLoss >= 0.04) emitConnQuality("medium");
  else emitConnQuality("good");
}

function startConnQualitySampling() {
  if (connQualityTimer) return;
  connQualityTimer = setInterval(() => { void sampleConnQuality(); }, 2000);
  void sampleConnQuality();
}

function stopConnQualitySampling() {
  if (connQualityTimer) { clearInterval(connQualityTimer); connQualityTimer = null; }
  emitConnQuality("good");
}

// --- Speaking indicator ----------------------------------------------------
// Green ring around whoever is currently making sound. Polls each remote
// peer's decoded audio level (RTCRtpReceiver.getSynchronizationSources, the
// RFC 6464 level Chromium fills in for free) plus the local mic (a WebAudio
// analyser on the denoised outgoing stream) ~10×/s, and emits the set of
// user ids talking right now. A short release window keeps the ring from
// strobing between syllables.
type SpeakingListener = (speaking: Set<string>) => void;
const speakingListeners = new Set<SpeakingListener>();
let speakingUsers = new Set<string>();
const speakingSince = new Map<string, number>();
let speakingTimer: ReturnType<typeof setInterval> | null = null;
let speakingAudioCtx: AudioContext | null = null;
let localLevelAnalyser: AnalyserNode | null = null;
let localLevelBuf: Uint8Array<ArrayBuffer> | null = null;
// Linear audio level (~ -34 dBov) — above residual noise the APM + RNNoise
// leave behind, below normal speech.
const REMOTE_SPEAKING_LEVEL = 0.02;
const LOCAL_SPEAKING_RMS = 0.02;
const SPEAKING_RELEASE_MS = 400;

/// Subscribe to the set of user ids currently speaking. Fires immediately
/// with the current set, then on every change while in a call.
export function onSpeaking(listener: SpeakingListener) {
  speakingListeners.add(listener);
  listener(new Set(speakingUsers));
  return () => { speakingListeners.delete(listener); };
}

function emitSpeaking(next: Set<string>) {
  if (next.size === speakingUsers.size && [...next].every(id => speakingUsers.has(id))) return;
  speakingUsers = next;
  speakingListeners.forEach(listener => listener(new Set(next)));
}

function localMicLevel(): number {
  if (!localLevelAnalyser || !localLevelBuf) return 0;
  localLevelAnalyser.getByteTimeDomainData(localLevelBuf);
  let sum = 0;
  for (let i = 0; i < localLevelBuf.length; i++) {
    const v = (localLevelBuf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / localLevelBuf.length);
}

function sampleSpeaking() {
  const now = performance.now();

  for (const [peerUserId, pc] of peers) {
    let level = 0;
    for (const receiver of pc.getReceivers()) {
      if (receiver.track?.kind !== "audio") continue;
      const sources = receiver.getSynchronizationSources?.() ?? [];
      for (const source of sources) {
        if (typeof source.audioLevel === "number") level = Math.max(level, source.audioLevel);
      }
    }
    if (level >= REMOTE_SPEAKING_LEVEL) speakingSince.set(peerUserId, now);
  }

  if (selfUserId && !localMuted && !localDeafened && localMicLevel() >= LOCAL_SPEAKING_RMS) {
    speakingSince.set(selfUserId, now);
  }

  const next = new Set<string>();
  for (const [userId, since] of speakingSince) {
    if (now - since <= SPEAKING_RELEASE_MS) next.add(userId);
    else speakingSince.delete(userId);
  }
  emitSpeaking(next);
}

function startSpeakingSampling() {
  if (!speakingTimer) speakingTimer = setInterval(sampleSpeaking, 100);
  if (localStream && !localLevelAnalyser) {
    try {
      speakingAudioCtx ??= new AudioContext();
      if (speakingAudioCtx.state === "suspended") void speakingAudioCtx.resume().catch(() => { /* needs a gesture */ });
      const source = speakingAudioCtx.createMediaStreamSource(localStream);
      localLevelAnalyser = speakingAudioCtx.createAnalyser();
      localLevelAnalyser.fftSize = 512;
      localLevelAnalyser.smoothingTimeConstant = 0.1;
      localLevelBuf = new Uint8Array(new ArrayBuffer(localLevelAnalyser.fftSize));
      source.connect(localLevelAnalyser);
    } catch (error) {
      console.error("[rtc] speaking analyser setup failed", error);
    }
  }
}

function stopSpeakingSampling() {
  if (speakingTimer) { clearInterval(speakingTimer); speakingTimer = null; }
  localLevelAnalyser = null;
  localLevelBuf = null;
  if (speakingAudioCtx) { void speakingAudioCtx.close().catch(() => { /* already closed */ }); speakingAudioCtx = null; }
  speakingSince.clear();
  emitSpeaking(new Set());
}

export function getLocalScreenStream(): MediaStream | null {
  return localScreenStream;
}
