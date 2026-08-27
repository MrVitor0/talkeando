// Mesh WebRTC engine — moved here from client/native/Talkeando.Client/RtcEngine.cs
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

type TurnCredentials = { username: string; credential: string; uris: string[] };
type RemoteStreamListener = (peerUserId: string, stream: MediaStream | null) => void;

const peers = new Map<string, RTCPeerConnection>();
const pendingPeers = new Map<string, Promise<RTCPeerConnection>>();
const videoSenders = new Map<string, RTCRtpSender>();
const pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
const remoteDescriptionSet = new Set<string>();
const iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>();
const remoteAudioEls = new Map<string, HTMLAudioElement>();
const pendingTurnRequests = new Map<string, (creds: TurnCredentials) => void>();
const remoteVideoListeners = new Set<RemoteStreamListener>();

let selfUserId: string | null = null;
let currentChannelId: string | null = null;
let localStream: MediaStream | null = null;
let localMuted = false;
let localDeafened = false;

// Screen share (send side): at most one active local publish at a time (v1
// simplification also documented on the old RtcEngine.cs). `subscribers` is
// the set of peer user ids the server has told us are watching — nothing is
// sent to a peer until it appears here, mirroring the old send-side gate
// that avoided a renegotiation storm on every subscribe/unsubscribe.
let localScreenTrack: MediaStreamTrack | null = null;
const screenSubscribers = new Set<string>();

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

  // Single sendrecv video transceiver per peer, added once and never
  // renegotiated afterward — screen-share subscribe/unsubscribe is a
  // send-side gate via replaceTrack (see setScreenSubscription), exactly
  // like the old RtcEngine.cs (SDD/12-stream-subscription-model.md).
  const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
  videoSenders.set(peerUserId, transceiver.sender);

  pc.ontrack = event => {
    console.log(`[rtc] ontrack from ${peerUserId}: kind=${event.track.kind} streams=${event.streams.length} readyState=${event.track.readyState}`);
    if (event.track.kind === "audio") {
      let audioEl = remoteAudioEls.get(peerUserId);
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.autoplay = true;
        remoteAudioEls.set(peerUserId, audioEl);
      }
      audioEl.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      audioEl.muted = localDeafened;
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
    send("rtc.offer", { channel_id: currentChannelId, to: peerUserId, sdp: offer.sdp });
  } catch (error) {
    console.error("ICE restart failed", peerUserId, error);
  }
}

async function connectToPeer(peerUserId: string) {
  console.log(`[rtc] connectToPeer ${peerUserId} (I am offerer)`);
  const pc = await getOrCreatePeer(peerUserId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send("rtc.offer", { channel_id: currentChannelId, to: peerUserId, sdp: offer.sdp });
}

async function handleIncomingOffer(data: any) {
  currentChannelId = data.channel_id;
  const peerUserId: string = data.from;
  console.log(`[rtc] handleIncomingOffer from ${peerUserId} (I am answerer)`);
  const pc = await getOrCreatePeer(peerUserId);
  await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
  remoteDescriptionSet.add(peerUserId);
  await flushPendingCandidates(peerUserId, pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send("rtc.answer", { channel_id: data.channel_id, to: peerUserId, sdp: answer.sdp });
}

async function handleIncomingAnswer(data: any) {
  const peerUserId: string = data.from;
  console.log(`[rtc] handleIncomingAnswer from ${peerUserId}`);
  const pc = peers.get(peerUserId);
  if (!pc) { console.warn(`[rtc] handleIncomingAnswer: no peer connection for ${peerUserId} yet`); return; }
  await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
  remoteDescriptionSet.add(peerUserId);
  await flushPendingCandidates(peerUserId, pc);
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
  videoSenders.delete(peerUserId);
  pendingCandidates.delete(peerUserId);
  remoteDescriptionSet.delete(peerUserId);
  screenSubscribers.delete(peerUserId);
  const timer = iceRestartTimers.get(peerUserId);
  if (timer) { clearTimeout(timer); iceRestartTimers.delete(peerUserId); }
  const audioEl = remoteAudioEls.get(peerUserId);
  if (audioEl) { audioEl.srcObject = null; remoteAudioEls.delete(peerUserId); }
  emitRemoteStream(peerUserId, null);
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
      currentChannelId = data.channel_id;
      if (!selfUserId) break;
      for (const participant of data.participants ?? []) {
        const peerUserId: string = participant.user_id;
        if (peerUserId !== selfUserId && selfUserId < peerUserId) void connectToPeer(peerUserId);
      }
      break;
    }
    case "call.peer_joined": {
      const peerUserId: string = data.participant.user_id;
      if (selfUserId && peerUserId !== selfUserId && selfUserId < peerUserId) void connectToPeer(peerUserId);
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
      setScreenSubscription(data.subscriber, true);
      break;
    case "stream.unsubscribed":
      console.log(`[rtc] stream.unsubscribed from ${data.subscriber}`);
      setScreenSubscription(data.subscriber, false);
      break;
    case "stream.unpublished":
      // Nothing more will ever arrive for this stream — if we were watching
      // its owner, tear down the rendered video (owner already stopped
      // sending, but the element would otherwise show a frozen last frame).
      emitRemoteStream(data.owner ?? "", null);
      break;
  }
}

function setScreenSubscription(peerUserId: string, subscribed: boolean) {
  if (subscribed) screenSubscribers.add(peerUserId); else screenSubscribers.delete(peerUserId);
  const sender = videoSenders.get(peerUserId);
  if (!sender) { console.warn(`[rtc] setScreenSubscription(${peerUserId}, ${subscribed}) — no video sender for this peer yet`); return; }
  console.log(`[rtc] replaceTrack(${subscribed ? (localScreenTrack ? localScreenTrack.label || "screen-track" : "null (no localScreenTrack!)") : "null"}) on sender for ${peerUserId}`);
  void sender.replaceTrack(subscribed ? localScreenTrack : null);
}

export function init(currentUserId: string) {
  selfUserId = currentUserId;
  subscribe(handleEnvelope);
}

/// Captures the microphone and applies the current mute/deafen state to it.
/// Peer connections created afterward (via call.snapshot/call.peer_joined)
/// pick up this track automatically; peers already connected before join
/// would be unusual (join always happens before any peer exists) so no
/// renegotiation-on-late-mic path is needed.
export async function joinCall(channelId: string, muted: boolean, deafened: boolean) {
  currentChannelId = channelId;
  localMuted = muted;
  localDeafened = deafened;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    applyLocalAudioState();
  } catch (error) {
    console.error("getUserMedia failed — joining call without a microphone", error);
    localStream = null;
  }
  send("call.join", { channel_id: channelId, req_id: crypto.randomUUID(), muted, deafened });
}

export async function leaveCall() {
  if (!currentChannelId) return;
  send("call.leave", { channel_id: currentChannelId, req_id: crypto.randomUUID() });
  for (const peerUserId of Array.from(peers.keys())) closePeer(peerUserId);
  if (localScreenTrack) { localScreenTrack.stop(); localScreenTrack = null; }
  screenSubscribers.clear();
  if (localStream) { for (const track of localStream.getTracks()) track.stop(); localStream = null; }
  currentChannelId = null;
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
  for (const audioEl of remoteAudioEls.values()) audioEl.muted = deafened;
  if (currentChannelId) send("call.state.update", { channel_id: currentChannelId, muted, deafened, req_id: crypto.randomUUID() });
}

/// SCREEN-FR-001/SUB-FR-001: capture starts immediately, but nothing is sent
/// to any peer until each viewer's stream.subscribe arrives as
/// stream.subscription_requested — see setScreenSubscription.
export async function publishScreen(channelId: string, streamId: string, targetHeight: number, targetFps: number) {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { height: { ideal: targetHeight }, frameRate: { ideal: targetFps } },
    audio: false,
  });
  localScreenTrack = displayStream.getVideoTracks()[0] ?? null;
  console.log(`[rtc] publishScreen: got track=${localScreenTrack?.label ?? "none"} readyState=${localScreenTrack?.readyState}, current subscribers=[${Array.from(screenSubscribers).join(",")}]`);
  if (localScreenTrack) {
    // The system "stop sharing" control (or the user closing the shared
    // window) ends the track without going through our own stopSharing —
    // treat that the same as an explicit unpublish.
    localScreenTrack.onended = () => { void unpublishScreen(channelId, streamId); };
  }
  for (const peerUserId of screenSubscribers) {
    const sender = videoSenders.get(peerUserId);
    if (sender) void sender.replaceTrack(localScreenTrack);
  }
  send("stream.publish", { channel_id: channelId, stream_id: streamId, kind: "screen", has_audio: false, req_id: crypto.randomUUID() });
}

export async function unpublishScreen(channelId: string, streamId: string) {
  if (localScreenTrack) { localScreenTrack.stop(); localScreenTrack = null; }
  for (const sender of videoSenders.values()) void sender.replaceTrack(null);
  screenSubscribers.clear();
  send("stream.unpublish", { channel_id: channelId, stream_id: streamId, req_id: crypto.randomUUID() });
}

export function watchStream(channelId: string, streamId: string, ownerUserId: string) {
  console.log(`[rtc] watchStream: subscribing to ${ownerUserId}'s stream ${streamId}`);
  send("stream.subscribe", { channel_id: channelId, stream_id: streamId, owner_user_id: ownerUserId });
}

export function stopWatchingStream(channelId: string, streamId: string, ownerUserId: string) {
  send("stream.unsubscribe", { channel_id: channelId, stream_id: streamId, owner_user_id: ownerUserId });
  emitRemoteStream(ownerUserId, null);
}

export function onRemoteStream(listener: RemoteStreamListener) {
  remoteVideoListeners.add(listener);
  return () => { remoteVideoListeners.delete(listener); };
}
