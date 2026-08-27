import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { send, subscribe } from "./ipc";
import * as rtc from "./rtc";

type Channel = { id: string; name: string; kind: "text" | "voice"; topic?: string | null };
type Member = { id: string; display_name: string; username: string; role: string };
type Attachment = { id: string; filename: string; content_type: string; size_bytes: number };
type Message = {
  id: string; content: string; created_at: string; author?: { display_name: string }; author_id?: string; attachments?: Attachment[];
  // Optimistic-send bookkeeping (never sent to the server, purely local UI
  // state) — see submitMessage/retryMessage. `reqId` is the same id echoed
  // back by the server as `in_reply_to` (CHAT-FR idempotent send).
  pending?: boolean; failed?: boolean; reqId?: string; pendingAttachmentIds?: string[];
};
// How long to wait for a `chat.message.created` echo before treating a send
// as failed and offering retry. Retrying is safe even if the original
// attempt actually succeeded server-side: the same req_id is reused, and
// the server's idempotency key (channel_id, author_id, req_id) resolves a
// duplicate send to the original row instead of inserting a second message.
const SEND_TIMEOUT_MS = 8000;
type Participant = { user_id: string; muted: boolean; deafened: boolean };
type StreamInfo = { stream_id: string; owner: string; kind: string; label?: string | null };

function StreamVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    // Setting srcObject imperatively does not reliably trigger the
    // `autoplay` attribute in every embedder — call play() explicitly and
    // log the outcome instead of silently sitting on a black frame forever.
    void video.play().catch(error => console.error("[ui] StreamVideo play() failed", error));
    const track = stream.getVideoTracks()[0];
    console.log(`[ui] StreamVideo mounted: track muted=${track?.muted} readyState=${track?.readyState}`);
    const onUnmute = () => console.log("[ui] StreamVideo: track unmuted (real frames should be flowing now)");
    const onMute = () => console.log("[ui] StreamVideo: track muted (sender stopped sending, or never started)");
    track?.addEventListener("unmute", onUnmute);
    track?.addEventListener("mute", onMute);
    return () => { track?.removeEventListener("unmute", onUnmute); track?.removeEventListener("mute", onMute); };
  }, [stream]);
  return <video ref={videoRef} autoPlay playsInline muted className="stream-video" />;
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [presence, setPresence] = useState<Record<string, "online" | "offline">>({});
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [call, setCall] = useState<{ channelId: string; participants: Participant[] } | null>(null);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [mySharingStreamId, setMySharingStreamId] = useState<string | null>(null);
  // getDisplayMedia constraints — honored for real by the browser's own
  // libwebrtc (unlike the old pinned VP8 wrapper's TargetKbps, confirmed
  // inert by direct testing — SDD/27-decisions.md ADR-008/ADR-009).
  const qualityPresets = ["720p30", "720p60", "1080p30", "1080p60"] as const;
  const qualityDimensions: Record<string, { height: number; fps: number }> = {
    "720p30": { height: 720, fps: 30 },
    "720p60": { height: 720, fps: 60 },
    "1080p30": { height: 1080, fps: 30 },
    "1080p60": { height: 1080, fps: 60 },
  };
  const [screenQuality, setScreenQuality] = useState<string>("720p60");
  const [watching, setWatching] = useState<Record<string, boolean>>({});
  const [remoteVideos, setRemoteVideos] = useState<Record<string, MediaStream>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const textChannels = useMemo(() => channels.filter(channel => channel.kind === "text"), [channels]);
  const voiceChannels = useMemo(() => channels.filter(channel => channel.kind === "voice"), [channels]);

  useEffect(() => {
    const unsubscribe = subscribe(event => {
      if (event.op === "auth.state_changed") setAuthenticated(event.data.state === "authenticated");
      if (event.op === "app.bootstrap") {
        setAuthenticated(true); setChannels(event.data.channels ?? []); setMembers(event.data.members ?? []);
        const selfId = event.data.currentUser?.id ?? null;
        setCurrentUserId(selfId);
        if (selfId) rtc.init(selfId);
      }
      if (event.op === "presence.snapshot") setPresence(Object.fromEntries((event.data.users ?? []).map((user: { user_id: string; status: "online" | "offline" }) => [user.user_id, user.status])));
      if (event.op === "presence.update") setPresence(current => ({ ...current, [event.data.user_id]: event.data.status }));
      if (event.op === "call.snapshot") setCall({ channelId: event.data.channel_id, participants: event.data.participants ?? [] });
      if (event.op === "call.peer_joined") setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: [...current.participants.filter(participant => participant.user_id !== event.data.participant.user_id), event.data.participant] });
      if (event.op === "call.peer_left") setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: current.participants.filter(participant => participant.user_id !== event.data.user_id) });
      if (event.op === "call.state.update") setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: current.participants.map(participant => participant.user_id === event.data.user_id ? { ...participant, muted: event.data.muted, deafened: event.data.deafened } : participant) });
      if (event.op === "call.snapshot") setStreams(event.data.streams ?? []);
      if (event.op === "stream.published") setStreams(current => [...current.filter(stream => stream.stream_id !== event.data.stream_id), event.data]);
      if (event.op === "stream.unpublished") setStreams(current => {
        const removed = current.find(stream => stream.stream_id === event.data.stream_id);
        if (removed) setWatching(watch => { const next = { ...watch }; delete next[removed.owner]; return next; });
        return current.filter(stream => stream.stream_id !== event.data.stream_id);
      });
      if (event.op === "chat.history") { setMessages(event.data.messages ?? []); setHistoryLoading(false); }
      if (event.op === "chat.message.created" && event.data.message?.channel_id === activeChannel?.id) {
        const reqId: string | undefined = event.data.in_reply_to;
        if (reqId && pendingTimers.current[reqId]) { clearTimeout(pendingTimers.current[reqId]); delete pendingTimers.current[reqId]; }
        setMessages(current => {
          // Replace the optimistic entry (matched by reqId) instead of
          // appending a second copy; if there is no matching pending entry
          // (message from someone else, or our own from a previous
          // session/tab) just append, guarding against an accidental
          // duplicate by id.
          const replacedIndex = reqId ? current.findIndex(message => message.reqId === reqId) : -1;
          if (replacedIndex >= 0) {
            const next = [...current];
            next[replacedIndex] = event.data.message;
            return next;
          }
          if (current.some(message => message.id === event.data.message.id)) return current;
          return [...current, event.data.message];
        });
      }
      if (event.op === "chat.message.edited") setMessages(current => current.map(message => message.id === event.data.message_id ? { ...message, content: event.data.content } : message));
      if (event.op === "chat.message.deleted") setMessages(current => current.filter(message => message.id !== event.data.message_id));
      if (event.op === "connection.state") setConnectionState(event.data.state);
      if (event.op === "attachment.uploaded") { setAttachmentIds(current => [...current, event.data.id]); setUploading(false); }
      if (event.op === "attachment.cancelled") setUploading(false);
      if (event.op === "error") setError(event.data.message ?? "Não foi possível concluir a operação.");
    });
    send("auth.session.restore");
    return () => { unsubscribe(); };
  }, [activeChannel?.id]);

  useEffect(() => rtc.onRemoteStream((peerUserId, stream) => {
    setRemoteVideos(current => {
      if (!stream) { if (!(peerUserId in current)) return current; const next = { ...current }; delete next[peerUserId]; return next; }
      return { ...current, [peerUserId]: stream };
    });
  }), []);

  function chooseChannel(channel: Channel) { setActiveChannel(channel); setMessages([]); setAttachmentIds([]); setHistoryLoading(true); send("chat.history.load", { channel_id: channel.id }); }
  function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); const form = new FormData(event.currentTarget);
    send(register ? "auth.register" : "auth.login", Object.fromEntries(form));
  }
  function sendOptimistic(reqId: string, channelId: string, text: string, ids: string[]) {
    send("chat.message.create", { channel_id: channelId, content: text, attachment_ids: ids, req_id: reqId });
    pendingTimers.current[reqId] = setTimeout(() => {
      delete pendingTimers.current[reqId];
      setMessages(current => current.map(message => message.reqId === reqId ? { ...message, pending: false, failed: true } : message));
    }, SEND_TIMEOUT_MS);
  }
  function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!activeChannel || (!content.trim() && attachmentIds.length === 0)) return;
    const reqId = crypto.randomUUID();
    const text = content || "[anexo]";
    setMessages(current => [...current, {
      id: reqId, reqId, content: text, created_at: new Date().toISOString(), author_id: currentUserId ?? undefined,
      pending: true, pendingAttachmentIds: attachmentIds,
    }]);
    sendOptimistic(reqId, activeChannel.id, text, attachmentIds);
    setContent(""); setAttachmentIds([]);
  }
  function retryMessage(message: Message) {
    if (!activeChannel || !message.reqId) return;
    setMessages(current => current.map(entry => entry.reqId === message.reqId ? { ...entry, pending: true, failed: false } : entry));
    sendOptimistic(message.reqId, activeChannel.id, message.content, message.pendingAttachmentIds ?? []);
  }
  function cancelMessage(message: Message) {
    if (message.reqId && pendingTimers.current[message.reqId]) { clearTimeout(pendingTimers.current[message.reqId]); delete pendingTimers.current[message.reqId]; }
    setMessages(current => current.filter(entry => entry.reqId !== message.reqId));
  }
  function pickAttachment() { if (!activeChannel) return; setUploading(true); send("attachment.pick", { channel_id: activeChannel.id }); }
  function joinCall(channel: Channel) { setMuted(false); setDeafened(false); void rtc.joinCall(channel.id, false, false); }
  function leaveCall() { if (!call) return; void rtc.leaveCall(); setCall(null); setStreams([]); setMySharingStreamId(null); setWatching({}); setRemoteVideos({}); }
  function updateCallState(nextMuted: boolean, nextDeafened: boolean) { if (!call) return; setMuted(nextMuted); setDeafened(nextDeafened); rtc.setLocalAudioState(nextMuted, nextDeafened); }
  async function startSharing() {
    if (!call) return;
    const streamId = crypto.randomUUID();
    const { height, fps } = qualityDimensions[screenQuality];
    try {
      await rtc.publishScreen(call.channelId, streamId, height, fps);
      setMySharingStreamId(streamId);
    } catch {
      setError("Não foi possível compartilhar a tela — permissão negada ou nenhuma fonte selecionada.");
    }
  }
  function stopSharing() { if (!call || !mySharingStreamId) return; void rtc.unpublishScreen(call.channelId, mySharingStreamId); setMySharingStreamId(null); }
  function toggleWatch(stream: StreamInfo) {
    if (!call) return;
    const isWatching = !!watching[stream.owner];
    if (isWatching) rtc.stopWatchingStream(call.channelId, stream.stream_id, stream.owner);
    else rtc.watchStream(call.channelId, stream.stream_id, stream.owner);
    setWatching(current => ({ ...current, [stream.owner]: !isWatching }));
  }
  function editMessage(message: Message) { const content = window.prompt("Editar mensagem", message.content); if (content === null || !content.trim() || content === message.content) return; send("chat.message.edit", { message_id: message.id, content, req_id: crypto.randomUUID() }); }
  function deleteMessage(message: Message) { if (!window.confirm("Excluir esta mensagem?")) return; send("chat.message.delete", { message_id: message.id, req_id: crypto.randomUUID() }); }

  if (!authenticated) return <main className="auth"><section><h1>talkeando</h1><p>Seu espaço privado para conversar.</p>{error && <p className="error">{error}</p>}<form onSubmit={submitAuth}>
    {register && <><input name="invite_code" placeholder="Código do convite" required /><input name="display_name" placeholder="Como quer ser chamado" required /></>}
    <input name="username" placeholder="Usuário" required /><input name="password" type="password" placeholder="Senha" minLength={8} required />
    <button>{register ? "Criar conta" : "Entrar"}</button>
  </form><button className="link" onClick={() => setRegister(value => !value)}>{register ? "Já tenho conta" : "Tenho um convite"}</button></section></main>;

  return <main className="shell"><aside className="sidebar"><h1>talkeando</h1><label>CANAIS DE TEXTO</label>{textChannels.map(channel => <button className={activeChannel?.id === channel.id ? "selected" : ""} onClick={() => chooseChannel(channel)} key={channel.id}># {channel.name}</button>)}<label>CANAIS DE VOZ</label>{voiceChannels.map(channel => <button className={call?.channelId === channel.id ? "selected" : ""} onClick={() => joinCall(channel)} key={channel.id}>🔊 {channel.name}</button>)}{call && <section className="call"><strong>Em chamada</strong><span>{call.participants.length} participante(s)</span><div className="call-controls"><button onClick={() => updateCallState(!muted, deafened)}>{muted ? "Ativar mic" : "Mutar"}</button><button onClick={() => updateCallState(muted, !deafened)}>{deafened ? "Ouvir" : "Ensurdecer"}</button></div>
      {mySharingStreamId ? <button onClick={stopSharing}>Parar compartilhamento</button> : <>
        <div className="quality-picker">
          <label>Qualidade</label>
          <select value={screenQuality} onChange={event => setScreenQuality(event.target.value)}>
            {qualityPresets.map(preset => <option key={preset} value={preset}>{preset}</option>)}
          </select>
        </div>
        <button onClick={startSharing}>Compartilhar tela</button>
      </>}
      <button onClick={leaveCall}>Sair da call</button></section>}<button className="logout" onClick={() => send("auth.session.clear")}>Sair</button></aside>
    <section className="chat"><header>{activeChannel ? <><strong># {activeChannel.name}</strong><span>{activeChannel.topic}</span></> : "Escolha um canal"}</header>
      {error && <div className="error-banner">{error}<button className="link" onClick={() => setError("")}>Dispensar</button></div>}
      {connectionState !== "connected" && <div className="connection">{connectionState === "reconnecting" ? "Reconectando…" : "Sem conexão em tempo real"}</div>}
      {call && streams.some(stream => stream.owner !== currentUserId) && <div className="stage">
        <div className="stage-tabs">
          {streams.filter(stream => stream.owner !== currentUserId).map(stream => <button key={stream.stream_id} className={watching[stream.owner] ? "selected" : ""} onClick={() => toggleWatch(stream)}>
            🖥️ {members.find(member => member.id === stream.owner)?.display_name ?? stream.owner}
          </button>)}
        </div>
        {Object.entries(remoteVideos).filter(([ownerId]) => watching[ownerId]).map(([ownerId, stream]) => <StreamVideo key={ownerId} stream={stream} />)}
      </div>}
      <div className="messages">
        {!activeChannel && <p className="empty">Escolha um canal de texto para começar.</p>}
        {activeChannel && historyLoading && <p className="empty">Carregando histórico…</p>}
        {activeChannel && !historyLoading && messages.length === 0 && <p className="empty">Nenhuma mensagem ainda — comece a conversa!</p>}
        {messages.map(message => <article key={message.id} className={message.failed ? "failed" : message.pending ? "pending" : ""}>
          <b>{message.author?.display_name ?? members.find(member => member.id === message.author_id)?.display_name ?? message.author_id ?? "Membro"}</b>
          <time>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          {message.pending && <span className="message-status">enviando…</span>}
          {message.failed && <span className="message-status">falhou <button onClick={() => retryMessage(message)}>tentar de novo</button><button onClick={() => cancelMessage(message)}>cancelar</button></span>}
          {!message.pending && !message.failed && message.author_id === currentUserId && <span className="message-actions"><button onClick={() => editMessage(message)}>Editar</button><button onClick={() => deleteMessage(message)}>Excluir</button></span>}
          <p>{message.content}</p>
          {message.attachments?.map(attachment => <button className="attachment" onClick={() => send("attachment.open", { attachment_id: attachment.id, filename: attachment.filename })} key={attachment.id}>📎 {attachment.filename}</button>)}
        </article>)}
      </div>
      {activeChannel && <form className="composer" onSubmit={submitMessage}>{attachmentIds.length > 0 && <span className="attachments">{attachmentIds.length} anexo(s)</span>}<button type="button" className="attach" disabled={uploading} onClick={pickAttachment}>{uploading ? "Enviando…" : "+"}</button><input value={content} onChange={event => setContent(event.target.value)} placeholder={`Conversar em #${activeChannel.name}`} maxLength={4000}/><button disabled={connectionState !== "connected"}>Enviar</button></form>}</section>
    <aside className="members"><label>MEMBROS — {members.length}</label>{members.map(member => <div className={presence[member.id] === "offline" ? "offline" : ""} key={member.id}><i />{member.display_name}<small>{member.role === "owner" ? "dono" : presence[member.id] === "offline" ? "offline" : ""}</small></div>)}</aside></main>;
}
