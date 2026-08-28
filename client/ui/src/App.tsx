import { FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import { send, subscribe } from "./ipc";
import * as rtc from "./rtc";
import { playSound, setSoundsMuted } from "./sounds";
import { Icon, IconName } from "./Icon";
import { HashIcon, SearchIcon, PencilIcon, TrashIcon, CrownIcon, FullscreenIcon, ContractIcon, PipIcon, DotsIcon, TheaterIcon } from "./Glyphs";
import { ScreenPicker, CaptureSource, ShareOptions } from "./ScreenPicker";
import logoUrl from "../icons/logo.webp";

type Channel = { id: string; name: string; kind: "text" | "voice"; topic?: string | null };
type ChannelCategory = { id: string; name: string; position: number; channels: Channel[] };
type Member = { id: string; display_name: string; username: string; role: string; avatar_url?: string | null; profile_tag?: string | null; profile_badge_url?: string | null };
type Attachment = { id: string; filename: string; content_type: string; size_bytes: number; url?: string | null };
// Rich embed imported from Discord (bot polls, "now playing", changelog cards).
// Image URLs are already rewritten to our own `/api/message-embeds/...` route
// by the server — see routes/messages.rs and discord_import::import_json.
type MessageEmbed = {
  title?: string | null; description?: string | null; url?: string | null; color?: number | null;
  author_name?: string | null; author_url?: string | null; provider_name?: string | null;
  footer_text?: string | null; footer_icon_url?: string | null;
  image_url?: string | null; thumbnail_url?: string | null;
  fields?: { name: string; value: string; inline?: boolean }[] | null;
};
type Message = {
  id: string; content: string; created_at: string; author?: { display_name: string; avatar_url?: string | null; profile_tag?: string | null; profile_badge_url?: string | null }; author_id?: string; attachments?: Attachment[];
  link_preview?: { url: string; title?: string | null; site_name?: string | null; image_url?: string | null } | null;
  embeds?: MessageEmbed[];
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

// Slash-command palette (Discord-style autocomplete). All of these are Tupi
// Música commands — see submitMessage's `/(play|pause|...)` parser and the
// server's handle_music_command.
type SlashCommand = { name: string; args?: string; desc: string };
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "play", args: "<link ou nome>", desc: "Toca uma música ou playlist — link do YouTube/Spotify ou busca por nome." },
  { name: "pause", desc: "Pausa a música atual." },
  { name: "resume", desc: "Retoma a música pausada." },
  { name: "skip", desc: "Pula para a próxima faixa." },
  { name: "stop", desc: "Para a música e tira o Tupi Música do canal de voz." },
  { name: "queue", desc: "Mostra a fila atual." },
];
type Participant = { user_id: string; muted: boolean; deafened: boolean; is_bot?: boolean };
type StreamInfo = { stream_id: string; owner: string; kind: string; label?: string | null; msid?: string | null };
// Remote video tracks for one peer, tagged with the sender's MediaStream.id
// so a screen and a camera from the same peer stay separate. `kind` is
// resolved at render time by matching `msid` against the published-stream
// list (a track whose msid matches nothing is treated as a screen).
type RemoteVid = { stream: MediaStream; msid: string | null };
// Community-wide projection of a voice channel's occupants — kept live for
// every voice channel, not just the one this client has joined.
type VoiceRosterEntry = { user_id: string; muted: boolean; deafened: boolean; sharing: boolean; is_bot?: boolean };
// Rich presence: what a member is doing outside Tupi (see
// SDD/specs/activity.md). Detected by the native client, relayed by the
// server; here it is read-only display data keyed by user_id.
type ActivityDto = {
  kind: "playing" | "listening" | "watching" | "browsing";
  name: string;
  details?: string | null;
  state?: string | null;
  started_at?: string | null;
  asset_image?: string | null; // "steam:<appid>" | "att:<hash>" | absolute URL
  asset_text?: string | null;
  // Server-derived for `kind: "playing"` (SDD/specs/activity.md ACT-FR-032).
  total_seconds?: number | null;
  last_played_at?: string | null;
  is_new?: boolean | null;
};

/* ------------------------------------------------------------------ */
/* small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function renderText(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
    /^https?:\/\//.test(part)
      ? <a key={index} href={part} target="_blank" rel="noreferrer noopener">{part}</a>
      : <span key={index}>{part}</span>
  );
}

// Renders a Discord-style rich embed (imported history only — there is no
// composer path that creates these). Mirrors the .link-preview visual
// language: coloured left edge, muted card background, everything optional.
function MessageEmbedCard({ embed }: { embed: MessageEmbed }) {
  const accent =
    typeof embed.color === "number" && embed.color >= 0
      ? "#" + embed.color.toString(16).padStart(6, "0")
      : "var(--link)";
  const fields = (embed.fields ?? []).filter(f => f && (f.name || f.value));
  return (
    <div className="msg-embed" style={{ borderLeftColor: accent }}>
      <div className="msg-embed__main">
        {embed.author_name && (
          <div className="msg-embed__author">
            {embed.author_url
              ? <a href={embed.author_url} target="_blank" rel="noreferrer noopener">{embed.author_name}</a>
              : embed.author_name}
          </div>
        )}
        {embed.title && (
          <div className="msg-embed__title">
            {embed.url
              ? <a href={embed.url} target="_blank" rel="noreferrer noopener">{embed.title}</a>
              : embed.title}
          </div>
        )}
        {embed.description && <div className="msg-embed__desc">{renderText(embed.description)}</div>}
        {fields.length > 0 && (
          <div className="msg-embed__fields">
            {fields.map((f, i) => (
              <div key={i} className={f.inline ? "msg-embed__field is-inline" : "msg-embed__field"}>
                {f.name && <div className="msg-embed__field-name">{f.name}</div>}
                {f.value && <div className="msg-embed__field-value">{renderText(f.value)}</div>}
              </div>
            ))}
          </div>
        )}
        {embed.image_url && (
          <a className="msg-embed__image" href={embed.image_url} target="_blank" rel="noreferrer noopener">
            <img src={embed.image_url} alt="" loading="lazy" />
          </a>
        )}
        {(embed.footer_text || embed.provider_name) && (
          <div className="msg-embed__footer">
            {embed.footer_icon_url && <img src={embed.footer_icon_url} alt="" />}
            <span>{embed.footer_text || embed.provider_name}</span>
          </div>
        )}
      </div>
      {embed.thumbnail_url && (
        <a className="msg-embed__thumb" href={embed.thumbnail_url} target="_blank" rel="noreferrer noopener">
          <img src={embed.thumbnail_url} alt="" loading="lazy" />
        </a>
      )}
    </div>
  );
}

function hueFromString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

function Avatar({ label, size, className, imageUrl }: { label: string; size: number; className?: string; imageUrl?: string | null }) {
  const hue = hueFromString(label || "?");
  return (
    <span
      className={className ? `avatar ${className}` : "avatar"}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: `hsl(${hue} 42% 45%)` }}
    >
      {imageUrl ? <img src={imageUrl} alt="" /> : initials(label)}
    </span>
  );
}

function tileGridColumns(count: number) {
  return Math.max(1, Math.min(5, Math.ceil(Math.sqrt(count))));
}

// True once the <video> is actually painting frames from `stream` (not just
// attached). Flips back to false if the track re-mutes — e.g. the sharer idles
// their screen — so the loading state can come back.
function useVideoReady(videoRef: RefObject<HTMLVideoElement | null>, stream: MediaStream | null | undefined) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) { setReady(false); return; }
    const track = stream.getVideoTracks()[0] ?? null;
    const compute = () => setReady(
      !!track && track.readyState === "live" && !track.muted
      && video.readyState >= 2 && video.videoWidth > 0 && !video.paused,
    );
    const events = ["playing", "loadeddata", "canplay", "waiting", "stalled", "emptied", "pause", "ended"] as const;
    for (const name of events) video.addEventListener(name, compute);
    track?.addEventListener("mute", compute);
    track?.addEventListener("unmute", compute);
    compute();
    return () => {
      for (const name of events) video.removeEventListener(name, compute);
      track?.removeEventListener("mute", compute);
      track?.removeEventListener("unmute", compute);
    };
  }, [videoRef, stream]);
  return ready;
}

// Shown over a video that is attached but not yet painting frames (the old
// "just a black rectangle" state) — soft gradient, pulsing icon, faux progress.
function StreamLoading({ label = "Carregando transmissão" }: { label?: string }) {
  return (
    <div className="stream-loading" aria-hidden="true">
      <div className="stream-loading__glow" />
      <div className="stream-loading__icon"><Icon name="share-screen" size={26} /></div>
      <div className="stream-loading__label">{label}</div>
      <div className="stream-loading__bar"><span /></div>
    </div>
  );
}

function MiniVideo({ stream, className }: { stream: MediaStream; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const ready = useVideoReady(ref, stream);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
  }, [stream]);
  return (
    <>
      <video ref={ref} autoPlay playsInline muted className={className} />
      {!ready && <StreamLoading />}
    </>
  );
}

/// A screen-share peek that floats out to the RIGHT of the sidebar row (fixed
/// positioning keeps it clear of the sidebar's overflow clip). It overlaps the
/// row by a few px so the pointer can travel into it without crossing a dead
/// gap; hovering it expands the tile and reveals the "Assistir" button.
function VoiceMemberPreview({
  anchor,
  stream,
  expanded,
  onEnter,
  onLeave,
  onWatch,
}: {
  anchor: HTMLElement | null;
  stream: MediaStream;
  expanded: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onWatch: (() => void) | null;
}) {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const width = expanded ? 380 : 260;
  const height = (width * 9) / 16;
  let left = rect.right - 8;
  if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width + 8);
  let top = rect.top + rect.height / 2 - height / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  return (
    <div
      className={expanded ? "voice-member__preview is-expanded" : "voice-member__preview"}
      style={{ left, top, width }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <MiniVideo stream={stream} className="voice-member__preview-video" />
      {expanded && onWatch && (
        <button
          className="voice-member__preview-watch"
          onClick={event => { event.stopPropagation(); onWatch(); }}
        >
          Assistir
        </button>
      )}
    </div>
  );
}

function VideoTile({
  stream,
  name,
  micMuted,
  peerMuted,
  focused,
  speaking = false,
  onToggleMute,
  onToggleFocus,
  isSelf = false,
  variant = "screen",
}: {
  stream: MediaStream;
  name: string;
  micMuted: boolean;
  peerMuted: boolean;
  focused: boolean;
  speaking?: boolean;
  onToggleMute: () => void;
  onToggleFocus: () => void;
  isSelf?: boolean;
  variant?: "screen" | "camera";
}) {
  const isCamera = variant === "camera";
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const ready = useVideoReady(videoRef, stream);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(error => console.error("[ui] tile play() failed", error));
    const track = stream.getVideoTracks()[0];
    console.log(`[ui] VideoTile mounted: track muted=${track?.muted} readyState=${track?.readyState}`);
    const onUnmute = () => console.log("[ui] VideoTile: track unmuted (real frames flowing)");
    track?.addEventListener("unmute", onUnmute);
    return () => track?.removeEventListener("unmute", onUnmute);
  }, [stream]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement === wrapRef.current) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen?.().catch(() => {});
  }
  function popOut() {
    const video = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    video?.requestPictureInPicture?.().catch(error => console.error("[ui] PiP failed", error));
  }

  return (
    <div ref={wrapRef} className={"vtile is-video" + (focused ? " is-focused" : "") + (speaking ? " is-speaking" : "")} onDoubleClick={toggleFullscreen}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf || peerMuted}
        className={
          "vtile__video"
          + (isCamera ? " is-cam" : "")
          + (isCamera && isSelf ? " is-self" : "")
        }
      />
      {!ready && <StreamLoading label={isCamera ? `Ativando a câmera de ${name}` : `Carregando a tela de ${name}`} />}
      {isSelf && !isCamera && (
        <div style={{
          position: "absolute",
          top: "12px",
          right: "12px",
          background: "rgba(0, 0, 0, 0.75)",
          color: "#fff",
          padding: "6px 12px",
          borderRadius: "16px",
          fontSize: "12px",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          zIndex: 10,
          border: "1px solid rgba(255, 255, 255, 0.15)",
          backdropFilter: "blur(4px)",
          pointerEvents: "none"
        }}>
          <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: "#23a55a" }} />
          <span>Sua tela (Espelhamento)</span>
        </div>
      )}
      <div className="vtile__name">
        {micMuted && <Icon name="mic-muted" size={14} />}
        <span>{name}</span>
      </div>
      <div className="vtile__hud">
        {!isSelf && (
          <button className={peerMuted ? "vhud-btn is-on" : "vhud-btn"} title={peerMuted ? "Ativar som" : "Silenciar"} onClick={onToggleMute}>
            <Icon name={peerMuted ? "headphone-muted" : "headphone"} size={16} />
          </button>
        )}
        <button className="vhud-btn" title="Janela flutuante" onClick={popOut}><PipIcon size={16} /></button>
        <button className={focused ? "vhud-btn is-on" : "vhud-btn"} title={focused ? "Sair do foco" : "Modo teatro"} onClick={onToggleFocus}><TheaterIcon size={16} /></button>
        <button className="vhud-btn" title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"} onClick={toggleFullscreen}>
          {isFullscreen ? <ContractIcon size={16} /> : <FullscreenIcon size={16} />}
        </button>
        <div className="vhud-more">
          <button className="vhud-btn" title="Mais opções" onClick={() => setMenuOpen(value => !value)}><DotsIcon size={16} /></button>
          {menuOpen && (
            <div className="vhud-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => { onToggleMute(); setMenuOpen(false); }}>{peerMuted ? "Ativar som" : "Silenciar tela"}</button>
              <button onClick={() => { toggleFullscreen(); setMenuOpen(false); }}>Tela cheia</button>
              <button onClick={() => { popOut(); setMenuOpen(false); }}>Janela flutuante</button>
              <button onClick={() => { onToggleFocus(); setMenuOpen(false); }}>{focused ? "Sair do foco" : "Modo teatro"}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

// Per-channel message-count hint for sizing the first-load skeleton, kept in
// localStorage so even a brand-new session opens a plausible skeleton
// instead of one generic size. Clamped so a very active channel doesn't
// render hundreds of skeleton rows.
const SKELETON_MIN = 4;
const SKELETON_MAX = 16;
function readSkeletonRows(channelId: string) {
  try {
    const stored = Number(localStorage.getItem("tk.msgCount." + channelId));
    if (Number.isFinite(stored) && stored > 0) {
      return Math.max(SKELETON_MIN, Math.min(SKELETON_MAX, Math.round(stored)));
    }
  } catch { /* private mode */ }
  return 8;
}
function writeSkeletonRows(channelId: string, count: number) {
  try { localStorage.setItem("tk.msgCount." + channelId, String(Math.min(count, 60))); } catch { /* private mode */ }
}

// First-load chat skeleton: bottom-anchored like the real message list, a
// couple of embed-sized blocks plus grouped text lines of stable
// pseudo-random widths (index-derived, so they don't reshuffle on re-render).
function ChatSkeleton({ rows }: { rows: number }) {
  const widths = [58, 44, 72, 51, 38, 66, 49, 80, 42, 61, 55, 47, 63, 40, 74, 52];
  return (
    <div className="chat-skeleton" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => {
        const groupStart = index === 0 || index % 4 === 0;
        const showEmbed = index === 2 || (rows > 8 && index === Math.floor(rows / 2));
        return (
          <div key={index} className={groupStart ? "sk-row is-start" : "sk-row"}>
            {groupStart ? <div className="sk-avatar" /> : <div className="sk-gutter" />}
            <div className="sk-row__lines">
              {groupStart && <div className="sk-bar sk-name" style={{ width: 80 + ((index * 17) % 90) }} />}
              <div className="sk-bar" style={{ width: `${widths[index % widths.length]}%` }} />
              {index % 3 === 1 && <div className="sk-bar" style={{ width: `${widths[(index + 6) % widths.length]}%` }} />}
              {showEmbed && <div className="sk-embed" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* custom right-click menu (replaces the WebView2 default — see        */
/* MainWindow.xaml.cs AreDefaultContextMenusEnabled=false)             */
/* ------------------------------------------------------------------ */

type MenuAction = { label: string; onClick: () => void; danger?: boolean };
// A live slider embedded in the menu (e.g. per-user local volume). The menu
// stays open while it's dragged.
type MenuSlider = {
  kind: "slider";
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  resetTo?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
};
type MenuItem = MenuAction | MenuSlider;
type MenuState = { x: number; y: number; items: MenuItem[] };

function ContextMenu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    // Defer wiring the dismiss listeners so the same click/contextmenu that
    // opened the menu doesn't immediately close it.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const timer = window.setTimeout(() => {
      window.addEventListener("click", onClose);
      window.addEventListener("contextmenu", onClose);
      window.addEventListener("resize", onClose);
      window.addEventListener("blur", onClose);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("click", onClose);
      window.removeEventListener("contextmenu", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.left, top: pos.top }} onClick={event => event.stopPropagation()}>
      {items.map((item, index) =>
        "kind" in item
          ? <MenuSliderRow key={index} item={item} />
          : (
            <button
              key={index}
              className={item.danger ? "ctx-menu__item is-danger" : "ctx-menu__item"}
              onClick={() => { onClose(); item.onClick(); }}
            >
              {item.label}
            </button>
          )
      )}
    </div>
  );
}

function MenuSliderRow({ item }: { item: MenuSlider }) {
  // Own the value locally so dragging stays smooth even though the parent
  // menu holds a one-shot snapshot of `items`.
  const [value, setValue] = useState(item.value);
  const apply = (next: number) => { setValue(next); item.onChange(next); };
  return (
    <div className="ctx-menu__slider">
      <div className="ctx-menu__slider-head">
        <span>{item.label}</span>
        <span className="ctx-menu__slider-val">{item.format ? item.format(value) : value}</span>
      </div>
      <input
        type="range"
        min={item.min}
        max={item.max}
        step={item.step}
        value={value}
        onChange={event => apply(Number(event.target.value))}
        onDoubleClick={() => { if (item.resetTo !== undefined) apply(item.resetTo); }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* realtime call-connection quality — cellular-style signal bars       */
/* ------------------------------------------------------------------ */

function SignalBars({ quality }: { quality: rtc.ConnQuality }) {
  const level = quality === "good" ? 3 : quality === "medium" ? 2 : 1;
  const color =
    quality === "good" ? "var(--green)" : quality === "medium" ? "var(--yellow)" : "var(--red)";
  const label =
    quality === "good" ? "Conexão boa" : quality === "medium" ? "Conexão lenta" : "Conexão muito lenta";
  const bars = [
    { x: 1, y: 9, height: 4 },
    { x: 6, y: 5.5, height: 7.5 },
    { x: 11, y: 2, height: 11 },
  ];
  return (
    <svg
      className={`voice-panel__signal is-${quality}`}
      width={18}
      height={18}
      viewBox="0 0 16 16"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={bar.y}
          width={3}
          height={bar.height}
          rx={1}
          fill={index < level ? color : "currentColor"}
          opacity={index < level ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* animated boot splash — shown until the session-restore answer lands */
/* ------------------------------------------------------------------ */

const SPLASH_TIPS = [
  "Clique com o botão direito num canal para renomeá-lo.",
  "Fique como Ocupado pelo menu do seu perfil para silenciar as notificações.",
  "Passe o mouse sobre quem está compartilhando a tela para espiar sem entrar na call.",
  "As barrinhas ao lado de “Voz conectada” mostram a qualidade da conexão em tempo real.",
  "Clique no nome de uma categoria para recolher os canais dela.",
  "A supressão de ruído (RNNoise) fica no painel de voz, no botão “crisp”.",
];

function SplashScreen() {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * SPLASH_TIPS.length));
  useEffect(() => {
    const id = window.setInterval(() => setTip(current => (current + 1) % SPLASH_TIPS.length), 3800);
    return () => window.clearInterval(id);
  }, []);
  return (
    <main className="splash">
      <div className="auth__nebula" aria-hidden="true" />
      <div className="splash__stage" aria-hidden="true">
        <div className="splash__glow" />
        <div className="splash__ring" />
        <div className="splash__ring splash__ring--2" />
        <div className="splash__orbit"><span className="splash__sat" /></div>
        <div className="splash__orbit splash__orbit--b"><span className="splash__sat" /></div>
        <div className="splash__logo"><img src={logoUrl} alt="" /></div>
      </div>
      <div className="splash__title">Carregando o Tupi…</div>
      <div className="splash__bar" aria-hidden="true"><span /></div>
      <div className="splash__tips">
        {SPLASH_TIPS.map((text, index) => (
          <p key={index} className={index === tip ? "splash__tip is-active" : "splash__tip"}>
            <b>DICA</b> {text}
          </p>
        ))}
      </div>
    </main>
  );
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  // False until the native host answers `auth.session.restore` (with either an
  // `app.bootstrap` or an `auth.state_changed`). Gates the animated splash so
  // the login form no longer flashes for already-logged-in users.
  const [authResolved, setAuthResolved] = useState(false);
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [connectionState, setConnectionState] = useState<"connected" | "reconnecting" | "disconnected">("disconnected");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [categories, setCategories] = useState<ChannelCategory[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [communityName, setCommunityName] = useState("Estação Finita");
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; display_name: string; username?: string; avatar_url?: string | null } | null>(null);
  const [presence, setPresence] = useState<Record<string, "online" | "busy" | "offline">>({});
  const [activities, setActivities] = useState<Record<string, ActivityDto[]>>({});
  // API root (e.g. http://localhost:8080/api), from the native bootstrap —
  // used only to build <img> src for the unauthenticated activity-asset
  // endpoint (game icons). All other data still comes over IPC.
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [shareActivity, setShareActivity] = useState(() => {
    try { return localStorage.getItem("tk.shareActivity") !== "off"; } catch { return true; }
  });
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  // Slash-command palette: highlighted row + the content value the user last
  // pressed Esc on (so it stays closed without wiping what they typed).
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismiss, setSlashDismiss] = useState("");
  const composerRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showMembers, setShowMembers] = useState(true);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Text channels with a message the reader hasn't opened yet (Discord's
  // white pill + bright name). Purely client-side and in-memory: cleared when
  // the channel is opened, never set for the channel already on screen.
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  // Mirrors our own presence status for the WS subscriber closure so a "busy"
  // member silences their own new-message chime without re-subscribing.
  const myStatusRef = useRef<"online" | "busy">("online");
  const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("tk.collapsedCats") || "{}"); } catch { return {}; }
  });
  const [call, setCall] = useState<{ channelId: string; participants: Participant[] } | null>(null);
  const [connQuality, setConnQuality] = useState<rtc.ConnQuality>("good");
  // User ids currently making sound — drives the green speaking ring in the
  // voice roster and on the stage tiles.
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(() => new Set());
  const [voiceRooms, setVoiceRooms] = useState<Record<string, VoiceRosterEntry[]>>({});
  // Live streams per voice channel — lets a member preview a share in a
  // channel they haven't joined (spectator hover).
  const [voiceRoomStreams, setVoiceRoomStreams] = useState<Record<string, StreamInfo[]>>({});
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [mySharingStreamId, setMySharingStreamId] = useState<string | null>(null);
  const [myMusicStreamId, setMyMusicStreamId] = useState<string | null>(null);
  const musicStreamRef = useRef<string | null>(null);
  // Resolution + frame-rate are chosen in the screen-share wizard now
  // (ScreenPicker), not a standalone dropdown. libwebrtc honours these for real
  // (unlike the old pinned VP8 wrapper's TargetKbps — SDD/27-decisions.md
  // ADR-008/ADR-009).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [watching, setWatching] = useState<Record<string, boolean>>({});
  const [peekOwner, setPeekOwner] = useState<string | null>(null);
  // Voice channel currently under a member-drag, for the drop-target highlight.
  const [dragOverVoice, setDragOverVoice] = useState<string | null>(null);
  // Mouse is inside the floating peek → expand it and show the watch button.
  const [previewHot, setPreviewHot] = useState(false);
  const peekHideTimer = useRef<number | null>(null);
  // Mic state to restore when the user turns deafen back off (deafen forces
  // the mic muted while it is on — Discord parity).
  const preDeafenMutedRef = useRef(false);
  // The voice channel we're actually a participant of — mirrors `call.channelId`
  // for use inside the stale-closure WS subscriber, so call sounds only fire
  // for events in our own call.
  const callChannelIdRef = useRef<string | null>(null);
  // Channel + stream of the share we're currently peeking (may be a channel we
  // haven't joined → spectator subscribe).
  const peekMetaRef = useRef<{ channelId: string; streamId: string; spectator: boolean } | null>(null);
  const peekOwnerRef = useRef<string | null>(null);
  // Set when "Assistir" is clicked for a channel we haven't joined: after the
  // join completes and the stream shows up, promote it to a full watch.
  const pendingWatchRef = useRef<{ ownerId: string; streamId: string } | null>(null);
  const voiceRowRefs = useRef<Record<string, HTMLElement>>({});
  const [remoteVideos, setRemoteVideos] = useState<Record<string, RemoteVid[]>>({});
  // Our own webcam publication (streamId for unpublish) + live preview stream.
  const [myCameraStreamId, setMyCameraStreamId] = useState<string | null>(null);
  const [selfCameraStream, setSelfCameraStream] = useState<MediaStream | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraDeviceId, setCameraDeviceId] = useState<string | null>(() => {
    try { return localStorage.getItem("tk.cameraDeviceId"); } catch { return null; }
  });
  const [cameraMenuOpen, setCameraMenuOpen] = useState(false);
  const [focusedUser, setFocusedUser] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const [mutedPeers, setMutedPeers] = useState<Record<string, boolean>>({});
  // Local-only per-user playback volume (0..2, 1 = default). Not sent anywhere.
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({});
  const [noiseSup, setNoiseSup] = useState(() => {
    try { return localStorage.getItem("tk.noiseSuppression") !== "off"; } catch { return true; }
  });
  const [showSharingToast, setShowSharingToast] = useState(false);
  // `historyLoading` now means only "show the skeleton" — it is true just on
  // the *first* visit to a text channel this session. Re-entering a channel
  // we already hydrated restores its messages from `historyCacheRef`
  // instantly (no skeleton, no flash) and refreshes silently in the
  // background. `skeletonRows` sizes the skeleton to the channel's
  // last-known message count (persisted per channel) so it doesn't jump.
  const [historyLoading, setHistoryLoading] = useState(false);
  const [skeletonRows, setSkeletonRows] = useState(8);
  const historyCacheRef = useRef<Record<string, Message[]>>({});
  const messagesRef = useRef<Message[]>([]);
  // The scrollable message viewport — kept pinned to the newest message.
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const pendingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const selfIdRef = useRef<string | null>(null);
  const joinedAtRef = useRef(0);
  const textChannels = useMemo(() => channels.filter(channel => channel.kind === "text"), [channels]);
  const voiceChannels = useMemo(() => channels.filter(channel => channel.kind === "voice"), [channels]);
  const memberName = (id: string | undefined | null) =>
    members.find(member => member.id === id)?.display_name ?? (id ? "Membro" : "Membro");

  useEffect(() => {
    const unsubscribe = subscribe(event => {
      if (event.op === "auth.state_changed") { setAuthenticated(event.data.state === "authenticated"); setAuthResolved(true); }
      if (event.op === "app.bootstrap") {
        setAuthResolved(true);
        setAuthenticated(true); setChannels(event.data.channels ?? []); setCategories(event.data.categories ?? []); setMembers(event.data.members ?? []);
        if (typeof event.data.apiBaseUrl === "string") setApiBaseUrl(event.data.apiBaseUrl);
        if (event.data.community?.name) setCommunityName(event.data.community.name);
        const selfId = event.data.currentUser?.id ?? null;
        setCurrentUserId(selfId);
        selfIdRef.current = selfId;
        if (event.data.currentUser) setCurrentUser(event.data.currentUser);
        if (selfId) rtc.init(selfId);
      }
      if (event.op === "presence.snapshot") setPresence(Object.fromEntries((event.data.users ?? []).map((user: { user_id: string; status: "online" | "busy" | "offline" }) => [user.user_id, user.status])));
      if (event.op === "presence.update") setPresence(current => ({ ...current, [event.data.user_id]: event.data.status }));
      // A member was renamed / changed avatar (native has already inlined
      // avatar_url to a data: URI). Patch the roster, and our own identity if
      // it was us.
      if (event.op === "member.updated") {
        const updated = event.data as { user_id: string; display_name: string; avatar_url?: string | null; profile_tag?: string | null };
        setMembers(current => current.map(member => member.id === updated.user_id
          ? { ...member, display_name: updated.display_name ?? member.display_name, avatar_url: updated.avatar_url ?? null, profile_tag: updated.profile_tag ?? member.profile_tag }
          : member));
        if (updated.user_id === selfIdRef.current) {
          setCurrentUser(current => current ? { ...current, display_name: updated.display_name ?? current.display_name, avatar_url: updated.avatar_url ?? null } : current);
        }
      }
      // A channel was renamed (name-only edit — see routes/channels.rs rename).
      if (event.op === "channel.updated") {
        const updated = event.data as { id: string; name: string };
        setChannels(current => current.map(channel => channel.id === updated.id ? { ...channel, name: updated.name } : channel));
        setCategories(current => current.map(category => ({
          ...category,
          channels: category.channels.map(channel => channel.id === updated.id ? { ...channel, name: updated.name } : channel),
        })));
        setActiveChannel(current => current && current.id === updated.id ? { ...current, name: updated.name } : current);
      }
      // Activity (rich presence) — replace the whole map on snapshot (never
      // diff against a stale one), merge per-user on update; an empty list
      // means the member stopped sharing / went offline.
      if (event.op === "activity.snapshot") setActivities(Object.fromEntries(((event.data.users ?? []) as Array<{ user_id: string; activities: ActivityDto[] }>).map(entry => [entry.user_id, entry.activities ?? []])));
      if (event.op === "activity.update") setActivities(current => {
        const next = { ...current };
        const list: ActivityDto[] = event.data.activities ?? [];
        if (list.length === 0) delete next[event.data.user_id];
        else next[event.data.user_id] = list;
        return next;
      });
      if (event.op === "call.snapshot") setCall({ channelId: event.data.channel_id, participants: event.data.participants ?? [] });
      if (event.op === "call.peer_joined") { if (event.data.channel_id === callChannelIdRef.current && event.data.participant?.user_id !== selfIdRef.current && Date.now() - joinedAtRef.current > 1500) playSound("joinCall"); setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: [...current.participants.filter(participant => participant.user_id !== event.data.participant.user_id), event.data.participant] }); }
      if (event.op === "call.peer_left") { if (event.data.channel_id === callChannelIdRef.current && event.data.user_id !== selfIdRef.current && Date.now() - joinedAtRef.current > 1500) playSound("leaveCall"); setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: current.participants.filter(participant => participant.user_id !== event.data.user_id) }); }
      if (event.op === "call.state.update") setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: current.participants.map(participant => participant.user_id === event.data.user_id ? { ...participant, muted: event.data.muted, deafened: event.data.deafened } : participant) });
      // The owner dragged us (or we dragged ourselves) into another voice
      // channel — join it, reusing the normal join path.
      if (event.op === "voice.moved") {
        const dest = channels.find(channel => channel.id === event.data.channel_id);
        if (dest) { setActiveChannel(dest); joinCall(dest); }
      }
      if (event.op === "voice.rooms") {
        const rooms: Array<{ channel_id: string; participants: VoiceRosterEntry[]; streams?: StreamInfo[] }> = event.data.rooms ?? [];
        setVoiceRooms(Object.fromEntries(rooms.map(room => [room.channel_id, room.participants])));
        setVoiceRoomStreams(Object.fromEntries(rooms.map(room => [room.channel_id, room.streams ?? []])));
      }
      if (event.op === "voice.roster") {
        const { channel_id, participants, streams: roomStreams } = event.data as { channel_id: string; participants: VoiceRosterEntry[]; streams?: StreamInfo[] };
        setVoiceRooms(current => {
          const next = { ...current };
          if (!participants || participants.length === 0) delete next[channel_id];
          else next[channel_id] = participants;
          return next;
        });
        setVoiceRoomStreams(current => ({ ...current, [channel_id]: roomStreams ?? [] }));
        // If the share we're peeking just disappeared, drop the preview.
        if (peekMetaRef.current && (roomStreams ?? []).every(s => s.stream_id !== peekMetaRef.current!.streamId)) {
          endPeek();
        }
      }
      if (event.op === "call.snapshot") setStreams(event.data.streams ?? []);
      if (event.op === "stream.published") setStreams(current => [...current.filter(stream => stream.stream_id !== event.data.stream_id), event.data]);
      if (event.op === "stream.unpublished") setStreams(current => {
        const removed = current.find(stream => stream.stream_id === event.data.stream_id);
        if (removed) setWatching(watch => { const next = { ...watch }; delete next[removed.owner]; return next; });
        return current.filter(stream => stream.stream_id !== event.data.stream_id);
      });
      if (event.op === "music.command") {
        const command: string = event.data.command;
        const voiceChannelId: string = event.data.voice_channel_id;
        if (command === "play" && event.data.query) {
          const streamId = crypto.randomUUID(); musicStreamRef.current = streamId; setMyMusicStreamId(streamId);
          void rtc.playMusic(voiceChannelId, streamId, event.data.query).catch(error => console.error("[music] play failed", error));
        } else if (command === "pause") rtc.setMusicPaused(true);
        else if (command === "resume") rtc.setMusicPaused(false);
        else if (command === "stop" || command === "skip") {
          const streamId = musicStreamRef.current;
          if (streamId) { void rtc.stopMusic(voiceChannelId, streamId); musicStreamRef.current = null; setMyMusicStreamId(null); }
        }
      }
      if (event.op === "music.announcement" && event.data.channel_id === activeChannel?.id) {
        setMessages(current => [...current, { id: crypto.randomUUID(), content: event.data.content, created_at: new Date().toISOString(), author: { display_name: "Tupi Música" } }]);
      }
      if (event.op === "chat.history") {
        const historyChannelId: string | undefined = event.data.channel_id ?? event.data.messages?.[0]?.channel_id;
        const historyMessages: Message[] = event.data.messages ?? [];
        if (historyChannelId) {
          historyCacheRef.current[historyChannelId] = historyMessages;
          writeSkeletonRows(historyChannelId, historyMessages.length);
        }
        // Apply to the view only if it's still the channel being looked at —
        // a slow response for a channel the user already left just updates
        // that channel's cache silently.
        if (!historyChannelId || historyChannelId === activeChannel?.id) {
          setMessages(historyMessages);
          setHistoryLoading(false);
        }
      }
      if (event.op === "chat.message.created") {
        const created = event.data.message;
        const createdChannelId: string | undefined = created?.channel_id;
        const fromSomeoneElse = !!created?.author_id && created.author_id !== selfIdRef.current;
        const lookingAtIt = createdChannelId === activeChannel?.id;
        // A message from someone else in a channel we're NOT reading: chime
        // (unless we're "busy") and light up the channel. If we're already in
        // that channel, neither happens (scenario 2).
        if (fromSomeoneElse && !lookingAtIt) {
          if (myStatusRef.current !== "busy") playSound("notification");
          if (createdChannelId) setUnread(current => current[createdChannelId] ? current : { ...current, [createdChannelId]: true });
        }
      }
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
      if (event.op === "screen.sources") { setSources(event.data.sources ?? []); setSourcesLoading(false); }
      if (event.op === "attachment.uploaded") { setAttachmentIds(current => [...current, event.data.id]); setUploading(false); }
      if (event.op === "attachment.cancelled") setUploading(false);
      if (event.op === "error") {
        // Version skew: an op this client sends that the (older) server build
        // doesn't know yet — e.g. `activity.report` against a server without
        // rich presence. Not user-actionable, so don't raise a banner.
        const code = event.data?.code;
        if (code !== "unknown_op" && code !== "unknown_ipc_op") {
          setError(event.data.message ?? "Não foi possível concluir a operação.");
        } else {
          console.warn("[ipc] ignoring version-skew error:", event.data);
        }
      }
    });
    return () => { unsubscribe(); };
  }, [activeChannel?.id]);

  // Session restore must happen exactly once — re-running it on every channel
  // switch re-publishes app.bootstrap and churns the RTC/WS setup.
  useEffect(() => { send("auth.session.restore"); }, []);

  // Safety net: if the native host never answers session.restore (dead bridge,
  // offline), stop showing the splash after a few seconds and fall through to
  // the login form instead of hanging forever.
  useEffect(() => {
    if (authResolved) return;
    const timer = window.setTimeout(() => setAuthResolved(true), 8000);
    return () => window.clearTimeout(timer);
  }, [authResolved]);

  // Land on "átrio-principal" by default (fall back to the first text channel)
  // once channels arrive and nothing is open yet.
  useEffect(() => {
    if (activeChannel || channels.length === 0) return;
    const norm = (value: string) =>
      value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const textChans = channels.filter(channel => channel.kind === "text");
    const preferred =
      textChans.find(channel => norm(channel.name) === "atrio-principal") ??
      textChans.find(channel => norm(channel.name).includes("atrio-principal")) ??
      textChans[0];
    if (preferred) chooseChannel(preferred);
  }, [channels, activeChannel]);

  // Mirror a couple of pieces of state into refs so the (channel-id-scoped) WS
  // subscriber and stray timeouts can read the current value.
  useEffect(() => { callChannelIdRef.current = call?.channelId ?? null; }, [call?.channelId]);
  // Feed the community name to the native custom title bar (host.title);
  // clear it back to the app default while signed out.
  useEffect(() => {
    send("host.title", { text: authenticated ? communityName : "" });
  }, [authenticated, communityName]);
  useEffect(() => { peekOwnerRef.current = peekOwner; }, [peekOwner]);
  useEffect(() => {
    myStatusRef.current = currentUserId && presence[currentUserId] === "busy" ? "busy" : "online";
  }, [currentUserId, presence]);
  // Keep the live message list mirrored so `chooseChannel` can snapshot the
  // channel being left into the session cache, and keep that cache current
  // for the channel being viewed (optimistic sends, edits, deletes, live
  // arrivals all flow through `messages`).
  useEffect(() => {
    messagesRef.current = messages;
    const id = activeChannel?.kind === "text" ? activeChannel.id : null;
    if (id && !historyLoading) historyCacheRef.current[id] = messages;
  }, [messages, activeChannel?.id, activeChannel?.kind, historyLoading]);

  // Chat stays pinned to the newest message: jump to the bottom on opening a
  // text channel / finishing a history load, and keep following new messages
  // as long as the reader is already near the bottom (scrolling up to read
  // history is respected).
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeChannel?.id, activeChannel?.kind]);
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
  }, [activeChannel?.id, activeChannel?.kind, historyLoading]);
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // After joining a channel via a preview's "Assistir", auto-promote to a full
  // watch once that stream is in the joined call's stream list.
  useEffect(() => {
    const pending = pendingWatchRef.current;
    if (!pending || !call) return;
    if (!streams.some(s => s.stream_id === pending.streamId)) return;
    pendingWatchRef.current = null;
    if (!watching[pending.ownerId]) {
      rtc.watchStream(call.channelId, pending.streamId, pending.ownerId);
      setWatching(current => ({ ...current, [pending.ownerId]: true }));
    }
  }, [streams, call, watching]);

  useEffect(() => rtc.onRemoteStream((peerUserId, stream, msid) => {
    setRemoteVideos(current => {
      const list = current[peerUserId] ?? [];
      // Removal: `null` msid clears every video for the peer (peer left /
      // connection closed); a specific msid clears just that track.
      if (!stream) {
        if (msid == null) {
          if (!(peerUserId in current)) return current;
          const next = { ...current }; delete next[peerUserId]; return next;
        }
        const trimmed = list.filter(v => v.msid !== msid);
        if (trimmed.length === list.length) return current;
        const next = { ...current };
        if (trimmed.length) next[peerUserId] = trimmed; else delete next[peerUserId];
        return next;
      }
      // Upsert by msid (and de-dupe by the stream object itself).
      const rest = list.filter(v => v.msid !== msid && v.stream.id !== stream.id);
      return { ...current, [peerUserId]: [...rest, { stream, msid: msid ?? stream.id }] };
    });
  }), []);

  // Keep the self-preview stream and publish id in sync with the engine — a
  // camera the OS revokes (unplug / another app) ends the track, and the
  // engine fires this with `null`.
  useEffect(() => rtc.onLocalCamera(stream => {
    setSelfCameraStream(stream);
    if (!stream) setMyCameraStreamId(null);
  }), []);

  // List cameras up front (labels stay blank until permission is granted once).
  useEffect(() => { void rtc.listCameras().then(setCameras); }, []);

  useEffect(() => rtc.onConnectionQuality(setConnQuality), []);
  useEffect(() => rtc.onSpeaking(setSpeakingUsers), []);

  useEffect(() => { setSoundsMuted(deafened); }, [deafened]);
  useEffect(() => {
    rtc.setNoiseSuppression(noiseSup);
    try { localStorage.setItem("tk.noiseSuppression", noiseSup ? "on" : "off"); } catch { /* private mode */ }
  }, [noiseSup]);
  // ACT-FR-008: the native ActivityMonitor stays idle until the UI opts it
  // in. It keeps its enabled state across WS reconnects (it is not tied to
  // the socket lifecycle), so sending this once per toggle is enough.
  useEffect(() => {
    send("activity.config", { enabled: shareActivity });
    try { localStorage.setItem("tk.shareActivity", shareActivity ? "on" : "off"); } catch { /* private mode */ }
  }, [shareActivity]);
  // The "you're sharing" toast shows briefly on start, then hides — there's
  // no OS capture border, but a permanent banner is nagging.
  useEffect(() => {
    if (!mySharingStreamId) { setShowSharingToast(false); return; }
    setShowSharingToast(true);
    const timer = setTimeout(() => setShowSharingToast(false), 4000);
    return () => clearTimeout(timer);
  }, [mySharingStreamId]);

  function chooseChannel(channel: Channel) {
    // Snapshot the channel we're leaving so coming back is instant + current.
    if (activeChannel?.kind === "text" && activeChannel.id !== channel.id) {
      historyCacheRef.current[activeChannel.id] = messagesRef.current;
    }
    setActiveChannel(channel);
    setAttachmentIds([]);
    setUnread(current => {
      if (!current[channel.id]) return current;
      const next = { ...current };
      delete next[channel.id];
      return next;
    });
    const cached = historyCacheRef.current[channel.id];
    if (cached) {
      // Already hydrated this session — show it now, refresh quietly below.
      setMessages(cached);
      setHistoryLoading(false);
    } else {
      // First visit: skeleton sized to the channel's last-known length.
      setMessages([]);
      setSkeletonRows(readSkeletonRows(channel.id));
      setHistoryLoading(true);
    }
    send("chat.history.load", { channel_id: channel.id });
  }
  function chooseVoiceChannel(channel: Channel) {
    setActiveChannel(channel);
    if (call?.channelId !== channel.id) joinCall(channel);
    else rtc.ensureChannel(channel.id);
  }
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
  // Slash palette is open only while typing the command *name* ("/", "/pl",
  // "/play") — once a space is typed the user is on the arguments and it hides.
  const slashPrefix = content.match(/^\/([a-z]*)$/i);
  const slashMatches = slashPrefix
    ? SLASH_COMMANDS.filter(command => command.name.startsWith(slashPrefix[1].toLowerCase()))
    : [];
  const slashOpen = slashMatches.length > 0 && content !== slashDismiss;
  const slashIndex = Math.max(0, Math.min(slashSel, slashMatches.length - 1));
  useEffect(() => { setSlashSel(0); }, [slashPrefix?.[1]]);
  function applySlash(command: SlashCommand) {
    setContent(`/${command.name} `);
    setSlashSel(0);
    setSlashDismiss("");
    composerRef.current?.focus();
  }
  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!slashOpen) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSlashSel(value => (value + 1) % slashMatches.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSlashSel(value => (value - 1 + slashMatches.length) % slashMatches.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); applySlash(slashMatches[slashIndex]); }
    else if (event.key === "Escape") { event.preventDefault(); setSlashDismiss(content); }
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!activeChannel || (!content.trim() && attachmentIds.length === 0)) return;
    const music = content.trim().match(/^\/(play|pause|resume|skip|stop|queue)(?:\s+(.+))?$/i);
    if (music) {
      if (!call) return;
      send("music.command", { channel_id: activeChannel.id, voice_channel_id: call.channelId, command: music[1].toLowerCase(), query: music[2]?.trim() });
      setContent(""); return;
    }
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
  function joinCall(channel: Channel) { setMuted(false); setDeafened(false); joinedAtRef.current = Date.now(); playSound("joinCall"); void rtc.joinCall(channel.id, false, false); }
  function leaveCall() {
    if (call) { playSound("leaveCall"); void rtc.leaveCall(); }
    musicStreamRef.current = null;
    setCall(null); setStreams([]); setMySharingStreamId(null); setMyMusicStreamId(null);
    setMyCameraStreamId(null); setSelfCameraStream(null); setCameraMenuOpen(false);
    setWatching({}); setRemoteVideos({}); cancelPeekHide(); peekMetaRef.current = null;
    peekOwnerRef.current = null; setPeekOwner(null); setPreviewHot(false);

    // Leaving voice should return the member to the community's landing text
    // channel rather than leaving the voice-stage UI frozen on screen.
    const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const textChannels = channels.filter(channel => channel.kind === "text");
    const atrium = textChannels.find(channel => normalize(channel.name) === "atrio-principal")
      ?? textChannels.find(channel => normalize(channel.name).includes("atrio-principal"))
      ?? textChannels[0];
    if (atrium) chooseChannel(atrium);
  }
  function updateAudioState(nextMuted: boolean, nextDeafened: boolean) {
    const deafenChanged = nextDeafened !== deafened;
    const muteChanged = nextMuted !== muted;
    // Deafen implies mic muted: on the way into deafen, remember the mic
    // state so it can be restored when deafen is turned back off.
    if (nextDeafened && !deafened) { preDeafenMutedRef.current = nextMuted; nextMuted = true; }
    else if (!nextDeafened && deafened) { nextMuted = preDeafenMutedRef.current; }
    // A headphone action can also mute/restore the microphone. Play one sound
    // for the action the user actually clicked, rather than both at once.
    if (deafenChanged) {
      if (!nextDeafened) {
        setSoundsMuted(false);
      }
      playSound(nextDeafened ? "headphoneMuted" : "headphoneUnmuted");
      if (nextDeafened) {
        setSoundsMuted(true);
      }
    }
    else if (muteChanged) playSound(nextMuted ? "micMuted" : "micUnmuted");
    setMuted(nextMuted); setDeafened(nextDeafened);
    if (call) rtc.setLocalAudioState(nextMuted, nextDeafened);
  }
  function startSharing() {
    if (!call) return;
    setSources([]);
    setSourcesLoading(true);
    setPickerOpen(true);
    send("screen.sources.list");
  }
  async function shareSource(sourceId: string, options: ShareOptions) {
    setPickerOpen(false);
    if (!call) return;
    const streamId = crypto.randomUUID();
    try {
      await rtc.publishScreen(call.channelId, streamId, sourceId, options.height, options.fps, options.withAudio);
      setMySharingStreamId(streamId);
      playSound("startScreen");
    } catch (error) {
      console.error("[ui] publishScreen failed", error);
      setError("Não foi possível iniciar o compartilhamento de tela.");
    }
  }
  function stopSharing() { if (!call || !mySharingStreamId) return; playSound("stopScreen"); void rtc.unpublishScreen(call.channelId, mySharingStreamId); setMySharingStreamId(null); }

  async function startCamera(deviceId?: string | null) {
    if (!call) return;
    const streamId = crypto.randomUUID();
    try {
      await rtc.startCamera(call.channelId, streamId, deviceId ?? cameraDeviceId);
      setMyCameraStreamId(streamId);
      playSound("startScreen");
      // Permission is granted now — re-list so the menu shows real labels.
      void rtc.listCameras().then(setCameras);
    } catch (error) {
      console.error("[ui] startCamera failed", error);
      setError("Não foi possível acessar a câmera. Verifique as permissões.");
    }
  }
  function stopCamera() {
    if (!call || !myCameraStreamId) return;
    playSound("stopScreen");
    void rtc.stopCamera(call.channelId, myCameraStreamId);
    setMyCameraStreamId(null);
  }
  function toggleCamera() { if (myCameraStreamId) stopCamera(); else void startCamera(); }
  function openCameraMenu() {
    void rtc.listCameras().then(setCameras);
    setCameraMenuOpen(open => !open);
  }
  async function pickCamera(deviceId: string) {
    try { localStorage.setItem("tk.cameraDeviceId", deviceId); } catch { /* private mode */ }
    setCameraDeviceId(deviceId);
    setCameraMenuOpen(false);
    if (myCameraStreamId) {
      try { await rtc.switchCamera(deviceId); }
      catch (error) { console.error("[ui] switchCamera failed", error); setError("Não foi possível trocar de câmera."); }
    }
  }
  function toggleWatch(ownerId: string, streamId: string) {
    if (!call) return;
    const isWatching = !!watching[ownerId];
    if (isWatching) rtc.stopWatchingStream(call.channelId, streamId, ownerId);
    else rtc.watchStream(call.channelId, streamId, ownerId);
    setWatching(current => ({ ...current, [ownerId]: !isWatching }));
  }
  // Hover-to-peek in the sidebar: transiently subscribe just to show a
  // thumbnail; hovering the floating preview expands it and its "Assistir"
  // button promotes it to `watching` (main stage). A grace timer on leave
  // lets the pointer travel from the row into the preview and back. Works for
  // channels we haven't joined too, via a spectator subscribe.
  function cancelPeekHide() {
    if (peekHideTimer.current !== null) { clearTimeout(peekHideTimer.current); peekHideTimer.current = null; }
  }
  // Unsubscribe the current peek (participant or spectator) without touching
  // the grace timer — used on leave-timeout, promote-to-watch, and teardown.
  function endPeek() {
    const meta = peekMetaRef.current;
    if (meta) {
      if (meta.spectator) rtc.stopSpectate(peekOwnerRef.current ?? "");
      else if (call) rtc.stopWatchingStream(meta.channelId, meta.streamId, peekOwnerRef.current ?? "");
      peekMetaRef.current = null;
    }
    peekOwnerRef.current = null;
    setPeekOwner(null);
    setPreviewHot(false);
  }
  function peekEnter(channelId: string, ownerId: string, streamId: string, isHere: boolean) {
    cancelPeekHide();
    if (watching[ownerId] || peekOwner === ownerId) return;
    if (peekOwner && peekOwner !== ownerId) endPeek();
    setPreviewHot(false);
    peekMetaRef.current = { channelId, streamId, spectator: !isHere };
    peekOwnerRef.current = ownerId;
    if (isHere && call) rtc.watchStream(channelId, streamId, ownerId);
    else rtc.spectate(channelId, streamId, ownerId);
    setPeekOwner(ownerId);
  }
  function peekLeave(ownerId: string) {
    cancelPeekHide();
    peekHideTimer.current = window.setTimeout(() => {
      peekHideTimer.current = null;
      if (!watching[ownerId] && peekOwner === ownerId) endPeek();
      else setPreviewHot(false);
    }, 220);
  }
  function editMessage(message: Message) { const next = window.prompt("Editar mensagem", message.content); if (next === null || !next.trim() || next === message.content) return; send("chat.message.edit", { message_id: message.id, content: next, req_id: crypto.randomUUID() }); }
  function deleteMessage(message: Message) { if (!window.confirm("Excluir esta mensagem?")) return; send("chat.message.delete", { message_id: message.id, req_id: crypto.randomUUID() }); }

  /* ---------------------------------------------------------------- */
  /* boot splash — until we know whether the user is signed in        */
  /* ---------------------------------------------------------------- */
  if (!authResolved) {
    return <SplashScreen />;
  }

  /* ---------------------------------------------------------------- */
  /* auth screen                                                      */
  /* ---------------------------------------------------------------- */
  if (!authenticated) {
    return (
      <main className="auth">
        <div className="auth__nebula" aria-hidden="true" />
        <span className="auth__star auth__star--one" aria-hidden="true" />
        <span className="auth__star auth__star--two" aria-hidden="true" />
        <span className="auth__star auth__star--three" aria-hidden="true" />
        <header className="auth__brand">
          <img src="/tupi-mascot.png" alt="" />
          <span>Tupi</span>
        </header>
        <section className={register ? "auth__card auth__card--register" : "auth__card auth__card--login"}>
          <div className="auth__form-panel">
            <h1>{register ? "Criar uma conta" : "Boas-vindas de volta!"}</h1>
            <p className="auth__subtitle">{register ? "Crie sua conta para começar a conversar no Tupi." : "Que bom ter você de volta ao Tupi."}</p>
            {error && <p className="auth__error">{error}</p>}
            <form onSubmit={submitAuth}>
              {register && (
                <>
                  <input type="hidden" name="invite_code" value="estacao-infinita" />
                  <label className="auth__field"><span>Como quer ser chamado <b>*</b></span><input name="display_name" autoComplete="name" required /></label>
                </>
              )}
              <label className="auth__field"><span>Usuário <b>*</b></span><input name="username" autoComplete="username" autoFocus required /></label>
              <label className="auth__field"><span>Senha <b>*</b></span><input name="password" type="password" autoComplete={register ? "new-password" : "current-password"} minLength={8} required /></label>
              <button className="auth__submit">{register ? "Criar conta" : "Entrar"}</button>
            </form>
            <div className="auth__link">
              {register ? "Já tem uma conta? " : "Tem um convite? "}
              <button type="button" onClick={() => { setRegister(value => !value); setError(""); }}>
                {register ? "Entrar" : "Criar uma conta"}
              </button>
            </div>
          </div>
          {!register && (
            <aside className="auth__aside">
              <div className="auth__mascot-wrap"><img src="/tupi-mascot.png" alt="Mascote do Tupi" /></div>
              <h2>Seu espaço, sua comunidade</h2>
              <p>Converse, entre em chamadas e compartilhe momentos com quem importa.</p>
            </aside>
          )}
        </section>
      </main>
    );
  }

  /* ---------------------------------------------------------------- */
  /* app                                                             */
  /* ---------------------------------------------------------------- */
  const selfName = currentUser?.display_name ?? "Você";
  const inThisVoice = activeChannel?.kind === "voice";
  const connected = connectionState === "connected";
  const myStatus: "online" | "busy" =
    currentUserId && presence[currentUserId] === "busy" ? "busy" : "online";
  // Only the community owner can drag members between voice channels.
  const canMoveMembers = members.find(member => member.id === currentUserId)?.role === "owner";

  /* ---- custom context menu + category collapse ---- */
  function openMenu(event: ReactMouseEvent, items: MenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    if (items.length > 0) setMenu({ x: event.clientX, y: event.clientY, items });
  }
  function toggleCategory(id: string) {
    setCollapsedCats(current => {
      const next = { ...current, [id]: !current[id] };
      try { localStorage.setItem("tk.collapsedCats", JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }
  function renameSelf() {
    const next = window.prompt("Novo nome de exibição", currentUser?.display_name ?? selfName);
    if (next && next.trim()) send("profile.rename", { display_name: next.trim() });
  }
  function renameOtherMember(member: Member) {
    const next = window.prompt(`Novo nome para ${member.display_name}`, member.display_name);
    if (next && next.trim() && next.trim() !== member.display_name) {
      send("member.rename", { user_id: member.id, display_name: next.trim() });
    }
  }
  function renameChannel(channel: Channel) {
    const next = window.prompt("Novo nome do canal", channel.name);
    if (next && next.trim() && next.trim() !== channel.name) {
      send("channel.rename", { channel_id: channel.id, name: next.trim() });
    }
  }
  function setStatus(next: "online" | "busy") {
    if (currentUserId) setPresence(current => ({ ...current, [currentUserId]: next }));
    myStatusRef.current = next;
    send("presence.set", { status: next });
  }
  function memberMenuItems(userId: string): MenuItem[] {
    if (userId && userId === currentUserId) {
      return [
        myStatus === "busy"
          ? { label: "Ficar disponível", onClick: () => setStatus("online") }
          : { label: "Não perturbe (ocupado)", onClick: () => setStatus("busy") },
        { label: "Alterar meu nome", onClick: renameSelf },
        { label: "Alterar foto de perfil", onClick: () => send("profile.avatar.pick") },
      ];
    }
    const member = members.find(entry => entry.id === userId);
    const items: MenuItem[] = [];
    // In a call together → let me tune this person's volume, just for me.
    if (call && call.participants.some(participant => participant.user_id === userId && !participant.is_bot)) {
      items.push({
        kind: "slider",
        label: "Volume do usuário",
        value: Math.round((peerVolumes[userId] ?? 1) * 100),
        min: 0,
        max: 200,
        step: 5,
        resetTo: 100,
        format: percent => `${percent}%`,
        onChange: percent => changePeerVolume(userId, percent / 100),
      });
    }
    if (member) items.push({ label: "Renomear usuário", onClick: () => renameOtherMember(member) });
    return items;
  }
  const channelMenuItems = (channel: Channel): MenuItem[] => [
    { label: "Renomear canal", onClick: () => renameChannel(channel) },
  ];

  const voiceParticipants: Participant[] = (() => {
    if (!inThisVoice) return [];
    const list = call?.channelId === activeChannel?.id ? call!.participants.filter(participant => !participant.is_bot) : [];
    if (currentUserId && !list.some(p => p.user_id === currentUserId)) {
      list.unshift({ user_id: currentUserId, muted, deafened });
    }
    return list;
  })();

  function togglePeerMute(userId: string) {
    setMutedPeers(current => {
      const next = !current[userId];
      rtc.setPeerAudioMuted(userId, next);
      return { ...current, [userId]: next };
    });
  }
  function changePeerVolume(userId: string, volume: number) {
    const clamped = Math.max(0, Math.min(2, volume));
    rtc.setPeerVolume(userId, clamped);
    setPeerVolumes(current => ({ ...current, [userId]: clamped }));
  }
  function toggleNoiseSuppression() {
    setNoiseSup(value => !value);
  }
  function toggleFocus(userId: string) {
    setFocusedUser(current => (current === userId ? null : userId));
  }

  // Resolve one of a peer's remote video tracks by kind. A track whose msid
  // matches a published "camera" row is the camera; anything else (including
  // an msid we haven't seen a row for yet) is treated as the screen.
  function pickRemoteVideo(userId: string, want: "screen" | "camera"): MediaStream | undefined {
    for (const vid of remoteVideos[userId] ?? []) {
      const row = streams.find(s => s.msid && s.msid === vid.msid);
      const kind = row ? row.kind : "screen";
      if (kind === want) return vid.stream;
    }
    return undefined;
  }

  // One participant expands to a base tile (camera video, or avatar) plus a
  // separate screen tile whenever their share is being watched.
  type VoiceTileDesc =
    | { key: string; kind: "cam"; participant: Participant; stream?: MediaStream }
    | { key: string; kind: "screen"; participant: Participant; stream: MediaStream };

  function tilesForParticipant(participant: Participant): VoiceTileDesc[] {
    const isSelf = participant.user_id === currentUserId;
    const camera = isSelf
      ? (selfCameraStream ?? undefined)
      : pickRemoteVideo(participant.user_id, "camera");
    const screen = isSelf
      ? (mySharingStreamId ? rtc.getLocalScreenStream() ?? undefined : undefined)
      : (watching[participant.user_id] ? pickRemoteVideo(participant.user_id, "screen") : undefined);
    const tiles: VoiceTileDesc[] = [{ key: `cam:${participant.user_id}`, kind: "cam", participant, stream: camera }];
    if (screen) tiles.push({ key: `screen:${participant.user_id}`, kind: "screen", participant, stream: screen });
    return tiles;
  }

  function renderVoiceTile(desc: VoiceTileDesc) {
    const { participant } = desc;
    const isSelf = participant.user_id === currentUserId;
    const name = isSelf ? selfName : memberName(participant.user_id);
    const isMicMuted = isSelf ? muted : participant.muted;
    const speaking = speakingUsers.has(participant.user_id);
    const screenRow = streams.find(s => s.owner === participant.user_id && s.kind === "screen");
    const watchable = desc.kind === "cam" && !!screenRow && !isSelf && !watching[participant.user_id];

    if (desc.kind === "screen") {
      return (
        <VideoTile
          key={desc.key}
          stream={desc.stream}
          variant="screen"
          name={`${name} — tela`}
          micMuted={isMicMuted}
          peerMuted={!!mutedPeers[participant.user_id]}
          focused={focusedUser === participant.user_id}
          speaking={speaking}
          onToggleMute={() => togglePeerMute(participant.user_id)}
          onToggleFocus={() => toggleFocus(participant.user_id)}
          isSelf={isSelf}
        />
      );
    }

    if (desc.stream) {
      return (
        <VideoTile
          key={desc.key}
          stream={desc.stream}
          variant="camera"
          name={name}
          micMuted={isMicMuted}
          peerMuted={!!mutedPeers[participant.user_id]}
          focused={focusedUser === participant.user_id}
          speaking={speaking}
          onToggleMute={() => togglePeerMute(participant.user_id)}
          onToggleFocus={() => toggleFocus(participant.user_id)}
          isSelf={isSelf}
        />
      );
    }

    return (
      <div className={speaking ? "vtile is-speaking" : "vtile"} key={desc.key}>
        <Avatar label={name} size={88} className="vtile__avatar" imageUrl={isSelf ? currentUser?.avatar_url : members.find(member => member.id === participant.user_id)?.avatar_url} />
        <div className="vtile__name">
          {isMicMuted && <Icon name="mic-muted" size={14} />}
          <span>{name}</span>
        </div>
        {watchable && (
          <button
            className="vtile__watch"
            onClick={() => toggleWatch(participant.user_id, screenRow!.stream_id)}
          >
            Assistir tela
          </button>
        )}
      </div>
    );
  }

  return (
    <main className="app" onContextMenu={event => event.preventDefault()}>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {mySharingStreamId && showSharingToast && (
        <div className="sharing-bar">
          <Icon name="share-screen" size={16} />
          <span>Você está compartilhando sua tela</span>
          <button onClick={stopSharing}>Parar</button>
        </div>
      )}
      {/* ---- left nav: server rail + channel sidebar, sharing one bottom dock ---- */}
      <div className="leftnav">
       <div className="leftnav__cols">
      <nav className="guilds">
        <div className="guilds__pill is-plain" title="Início"><Icon name="discord-icon" size={26} /></div>
        <div className="guilds__sep" />
        <div className="guilds__pill is-active" title={communityName} style={{ overflow: "hidden", padding: 0 }}>
          <img src={logoUrl} alt={communityName} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
        <div className="guilds__pill is-plain guilds__add" title="Adicionar um servidor">+</div>
      </nav>

      {/* ---- channel sidebar ---- */}
      <aside className="channels">
        <button className="channels__header">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <img src={logoUrl} alt="" style={{ width: "18px", height: "18px", borderRadius: "4px", objectFit: "cover" }} />
            <span>{communityName}</span>
          </div>
          <Icon name="config" size={16} />
        </button>

        <div className="channels__list scroll-thin">
          <div className="server-shortcuts">
            <button className="server-shortcut"><Icon name="events" size={20} /><span>Eventos</span></button>
            <button className="server-shortcut"><Icon name="notifications" size={20} /><span>Impulsos de servidor</span></button>
          </div>
          {(categories.length ? categories : [
            { id: "text", name: "Canais de texto", position: 0, channels: textChannels },
            { id: "voice", name: "Canais de voz", position: 1, channels: voiceChannels },
          ]).map(category => {
            const isCollapsed = !!collapsedCats[category.id];
            return <section className="channel-category" key={category.id}>
            <div
              className={isCollapsed ? "cat is-collapsed" : "cat"}
              onClick={() => toggleCategory(category.id)}
            >
              <svg className="cat__chevron" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
              <span className="cat__label">{category.name}</span>
              <span className="cat__add" onClick={event => event.stopPropagation()}>+</span>
            </div>
            {category.channels
              .filter(channel =>
                !isCollapsed
                || (activeChannel?.id === channel.id)
                || call?.channelId === channel.id
                || unread[channel.id])
              .map(channel => {
            const here = call?.channelId === channel.id;
            if (channel.kind === "text") {
              const isActiveText = activeChannel?.id === channel.id && activeChannel?.kind === "text";
              return <button
              key={channel.id}
              className={"chan" + (isActiveText ? " is-active" : "") + (!isActiveText && unread[channel.id] ? " is-unread" : "")}
              onClick={() => chooseChannel(channel)}
              onContextMenu={event => openMenu(event, channelMenuItems(channel))}
            >
              <HashIcon size={18} className="chan__icon" />
              <span className="chan__name">{channel.name}</span>
              <span className="chan__tools"><Icon name="add-media" size={16} /><Icon name="config" size={16} /></span>
            </button>;
            }
            // Live occupants of this voice channel, from the community-wide
            // roster. For the call we're actually in, fold in our own optimistic
            // state so mute/deafen/sharing update instantly without a round-trip.
            const roster = voiceRooms[channel.id] ?? [];
            const voiceRoster: VoiceRosterEntry[] = here && currentUserId
              ? [
                  ...roster.filter(entry => entry.user_id !== currentUserId),
                  {
                    user_id: currentUserId,
                    muted,
                    deafened,
                    sharing: !!mySharingStreamId || roster.some(e => e.user_id === currentUserId && e.sharing),
                  },
                ]
              : roster;
            return (
              <div key={channel.id}>
                <button
                  className={
                    "chan" +
                    (activeChannel?.id === channel.id && activeChannel?.kind === "voice" ? " is-active" : "") +
                    (here ? " is-connected" : "") +
                    (dragOverVoice === channel.id ? " is-drop-target" : "")
                  }
                  onClick={() => chooseVoiceChannel(channel)}
                  onContextMenu={event => openMenu(event, channelMenuItems(channel))}
                  onDragOver={canMoveMembers ? (event => {
                    if (!event.dataTransfer.types.includes("application/x-tk-member")) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverVoice(channel.id);
                  }) : undefined}
                  onDragLeave={canMoveMembers ? (() => setDragOverVoice(current => current === channel.id ? null : current)) : undefined}
                  onDrop={canMoveMembers ? (event => {
                    event.preventDefault();
                    setDragOverVoice(null);
                    const userId = event.dataTransfer.getData("application/x-tk-member");
                    const from = event.dataTransfer.getData("application/x-tk-member-src");
                    if (userId && from !== channel.id) send("voice.move_member", { user_id: userId, channel_id: channel.id });
                  }) : undefined}
                >
                  <Icon name="voice-chat" size={18} className="chan__icon" />
                  <span className="chan__name">{channel.name}</span>
                  {voiceRoster.length > 0 && <span className="chan__count">{voiceRoster.length}</span>}
                </button>
                {voiceRoster.length > 0 && (
                  <div className="voice-members">
                    {voiceRoster.map(entry => {
                      const isBot = !!entry.is_bot;
                      const isSelf = entry.user_id === currentUserId;
                      const name = isBot ? "Tupi Música" : (isSelf ? selfName : memberName(entry.user_id));
                      const micMuted = !isBot && (isSelf && here ? muted : entry.muted);
                      const audioOff = !isBot && (isSelf && here ? deafened : entry.deafened);
                      // The stream to preview: from the joined call's list when
                      // we're here, otherwise from the community roster (a
                      // spectator subscribe drives the RTC path).
                      const roomStreams = here ? streams : (voiceRoomStreams[channel.id] ?? []);
                      const share = isBot ? undefined : roomStreams.find(s => s.owner === entry.user_id && s.kind === "screen");
                      const hasCamera = !isBot && ((isSelf && here && !!myCameraStreamId)
                        || roomStreams.some(s => s.owner === entry.user_id && s.kind === "camera"));
                      const botPlaying = isBot && (entry.sharing || roomStreams.some(s => s.owner === entry.user_id && s.kind === "music"));
                      const isLive = !isBot && (entry.sharing || !!share);
                      const canPeek = !!share && !isSelf;
                      // The floating peek preview is purely a hover affordance:
                      // once you're actually watching, the main stage carries
                      // the video and the row just shows a "Parar" button.
                      const preview = canPeek && !watching[entry.user_id] && peekOwner === entry.user_id
                        ? pickRemoteVideo(entry.user_id, "screen")
                        : undefined;
                      const promoteWatch = () => {
                        cancelPeekHide();
                        if (here) {
                          endPeek();
                          toggleWatch(entry.user_id, share!.stream_id);
                        } else {
                          // Not in this channel yet — join it, then auto-watch
                          // once the call is up.
                          pendingWatchRef.current = { ownerId: entry.user_id, streamId: share!.stream_id };
                          endPeek();
                          chooseVoiceChannel(channel);
                        }
                      };
                      return (
                        <div
                          className={
                            "voice-member"
                            + (isBot ? " voice-member--bot" : "")
                            + (isLive ? " is-live" : "")
                            + (!isBot && speakingUsers.has(entry.user_id) ? " is-speaking" : "")
                            + (canMoveMembers && !isBot ? " is-draggable" : "")
                          }
                          key={entry.user_id}
                          ref={node => { if (node) voiceRowRefs.current[entry.user_id] = node; }}
                          draggable={(canMoveMembers && !isBot) || undefined}
                          onDragStart={canMoveMembers && !isBot ? (event => {
                            event.dataTransfer.setData("application/x-tk-member", entry.user_id);
                            event.dataTransfer.setData("application/x-tk-member-src", channel.id);
                            event.dataTransfer.effectAllowed = "move";
                          }) : undefined}
                          onDragEnd={canMoveMembers ? (() => setDragOverVoice(null)) : undefined}
                          onMouseEnter={() => canPeek && peekEnter(channel.id, entry.user_id, share!.stream_id, here)}
                          onMouseLeave={() => canPeek && peekLeave(entry.user_id)}
                          onContextMenu={event => openMenu(event, memberMenuItems(entry.user_id))}
                        >
                          <Avatar label={name} size={24} className="voice-member__av" imageUrl={members.find(member => member.id === entry.user_id)?.avatar_url} />
                          <span className="voice-member__name">{name}</span>
                          {micMuted && <Icon name="mic-muted" size={15} className="voice-member__flag" />}
                          {audioOff && <Icon name="headphone-muted" size={15} className="voice-member__flag" />}
                          {hasCamera && <Icon name="camera" size={15} className="voice-member__flag voice-member__flag--cam" title="Câmera ligada" />}
                          {isLive && <span className="voice-member__live-badge">AO VIVO</span>}
                          {botPlaying && <span className="voice-member__live-badge voice-member__live-badge--bot">🎵 TOCANDO</span>}
                          {here && !isSelf && watching[entry.user_id] && (
                            <button
                              className="voice-member__watch"
                              onClick={event => { event.stopPropagation(); toggleWatch(entry.user_id, share!.stream_id); }}
                            >
                              Parar
                            </button>
                          )}
                          {preview && (
                            <VoiceMemberPreview
                              anchor={voiceRowRefs.current[entry.user_id] ?? null}
                              stream={preview}
                              expanded={previewHot && peekOwner === entry.user_id}
                              onEnter={() => { cancelPeekHide(); setPreviewHot(true); }}
                              onLeave={() => peekLeave(entry.user_id)}
                              onWatch={promoteWatch}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
            })}
          </section>;
          })}
        </div>
      </aside>
       </div>

       <div className="leftnav__dock">
        {/* ---- RTC connected panel ---- */}
        {call && (
          <div className="voice-panel">
            <div className="voice-panel__row">
              <SignalBars quality={connQuality} />
              <div className="voice-panel__info">
                <div className="voice-panel__state">Voz conectada</div>
                <div className="voice-panel__chan">
                  {(channels.find(c => c.id === call.channelId)?.name ?? "canal")} / {communityName}
                </div>
              </div>
              <button className="voice-panel__hangup" onClick={leaveCall} title="Desconectar">
                <Icon name="hangout-call" size={18} />
              </button>
            </div>
            <div className="voice-panel__grid">
              <button
                className={noiseSup ? "vp-btn is-on" : "vp-btn"}
                onClick={toggleNoiseSuppression}
                title={noiseSup ? "Supressão de ruído: ligada" : "Supressão de ruído: desligada"}
              >
                <Icon name={noiseSup ? "crisp-nois-cenaceling-on" : "crisp-off"} size={18} />
              </button>
              <button className="vp-btn" title="Efeitos sonoros"><Icon name="sound-effects" size={18} /></button>
              <button
                className={mySharingStreamId ? "vp-btn is-danger is-on" : "vp-btn"}
                onClick={mySharingStreamId ? stopSharing : startSharing}
                title="Compartilhar tela"
              >
                <Icon name="share-screen" size={18} />
              </button>
              <button
                className={myCameraStreamId ? "vp-btn is-on" : "vp-btn"}
                onClick={toggleCamera}
                title={myCameraStreamId ? "Desligar câmera" : "Ligar câmera"}
              >
                <Icon name={myCameraStreamId ? "camera" : "camera-closed"} size={18} />
              </button>
            </div>
          </div>
        )}

        {/* ---- user bar ---- */}
        <div className="userbar">
          <div
            className="userbar__id"
            onContextMenu={event => openMenu(event, memberMenuItems(currentUserId ?? ""))}
            title="Clique com o botão direito para editar seu perfil / status"
          >
            <Avatar
              label={selfName}
              size={32}
              className={myStatus === "busy" ? "userbar__avatar is-busy" : "userbar__avatar"}
              imageUrl={currentUser?.avatar_url}
            />
            <div className="userbar__meta">
              <div className="userbar__name">{selfName}</div>
              <div className="userbar__sub">{myStatus === "busy" ? "Ocupado" : (currentUser?.username ? `@${currentUser.username}` : "online")}</div>
            </div>
          </div>
          <div className="userbar__btns">
            <button className={muted ? "userbar__btn is-on" : "userbar__btn"} onClick={() => updateAudioState(!muted, deafened)} title={muted ? "Ativar microfone" : "Desativar microfone"}>
              <Icon name={muted ? "mic-muted" : "mic-open"} size={20} />
            </button>
            <button className={deafened ? "userbar__btn is-on" : "userbar__btn"} onClick={() => updateAudioState(muted, !deafened)} title={deafened ? "Ativar áudio" : "Desativar áudio"}>
              <Icon name={deafened ? "headphone-muted" : "headphone"} size={20} />
            </button>
            <button className="userbar__btn" onClick={() => send("auth.session.clear")} title="Sair">
              <Icon name="config" size={20} />
            </button>
          </div>
        </div>
       </div>
      </div>

      {/* ---- main column ---- */}
      <div className="workspace">
        <header className="topbar">
          {activeChannel ? (
            <>
              {activeChannel.kind === "voice"
                ? <Icon name="voice-chat" size={24} className="topbar__icon" />
                : <HashIcon size={24} className="topbar__icon" />}
              <span className="topbar__title">{activeChannel.name}</span>
              {activeChannel.topic && (
                <>
                  <span className="topbar__divider" />
                  <span className="topbar__topic">{activeChannel.topic}</span>
                </>
              )}
            </>
          ) : (
            <span className="topbar__title">Selecione um canal</span>
          )}
          <div className="topbar__actions">
            <button className="topbar__btn" title="Notificações"><Icon name="notifications" size={24} /></button>
            <button className="topbar__btn" title="Mensagens fixadas"><Icon name="pin-messages" size={24} /></button>
            <button
              className={showMembers ? "topbar__btn is-on" : "topbar__btn"}
              onClick={() => setShowMembers(value => !value)}
              title="Lista de membros"
            >
              <Icon name="members" size={24} />
            </button>
            <div className="search">
              <span>{`Buscar ${communityName}`}</span>
              <SearchIcon size={16} />
            </div>
            <button className="topbar__btn" title="Caixa de entrada"><Icon name="inbox" size={24} /></button>
            <button className="topbar__btn" title="Ajuda"><Icon name="question" size={24} /></button>
          </div>
        </header>

        {error && (
          <div className="banner is-error">
            <span>{error}</span>
            <button onClick={() => setError("")}>Dispensar</button>
          </div>
        )}
        {!connected && (
          <div className="banner is-warn">
            <span>{connectionState === "reconnecting" ? "Reconectando…" : "Sem conexão em tempo real"}</span>
          </div>
        )}

        <div className="workspace__body">
        <section className="main">
        {inThisVoice ? (
          <div className={theater ? "voice-stage is-theater" : "voice-stage"}>
            <div className="voice-stage__head">
              <Icon name="wifi-connect" size={16} />
              <span>{activeChannel!.name} / {communityName}</span>
              <button
                className={theater ? "voice-stage__theater is-on" : "voice-stage__theater"}
                onClick={() => setTheater(value => !value)}
                title={theater ? "Sair do modo teatro" : "Modo teatro"}
              >
                <TheaterIcon size={15} />
              </button>
            </div>
            {(() => {
              const tiles = voiceParticipants.flatMap(tilesForParticipant);
              const focused = focusedUser && tiles.some(t => t.participant.user_id === focusedUser)
                ? focusedUser : null;
              if (focused) {
                const main = tiles.filter(t => t.participant.user_id === focused);
                const strip = tiles.filter(t => t.participant.user_id !== focused);
                return (
                  <div className="voice-focus">
                    <div className="voice-focus__main">{main.map(renderVoiceTile)}</div>
                    <div className="voice-strip">{strip.map(renderVoiceTile)}</div>
                  </div>
                );
              }
              return (
                <div
                  className="voice-grid"
                  style={{ gridTemplateColumns: `repeat(${tileGridColumns(Math.max(tiles.length, 1))}, minmax(0, 1fr))` }}
                >
                  {tiles.length === 0
                    ? <div className="empty">Conectando…</div>
                    : tiles.map(renderVoiceTile)}
                </div>
              );
            })()}
            <div className="voice-controls">
              <button className="vc-btn" title="Atividades"><Icon name="activities" size={22} /></button>
              <button className="vc-btn" title="Efeitos sonoros"><Icon name="sound-effects" size={22} /></button>
              <button
                className={mySharingStreamId ? "vc-btn is-on" : "vc-btn"}
                onClick={mySharingStreamId ? stopSharing : startSharing}
                title={mySharingStreamId ? "Parar de compartilhar" : "Compartilhar tela"}
              >
                <Icon name="share-screen" size={22} />
              </button>
              <div className="vc-cam">
                <button
                  className={myCameraStreamId ? "vc-btn is-on" : "vc-btn"}
                  onClick={toggleCamera}
                  title={myCameraStreamId ? "Desligar câmera" : "Ligar câmera"}
                >
                  <Icon name={myCameraStreamId ? "camera" : "camera-closed"} size={22} />
                </button>
                <button className="vc-cam__caret" onClick={openCameraMenu} title="Escolher câmera" aria-label="Escolher câmera">▾</button>
                {cameraMenuOpen && (
                  <div className="vc-cam__menu" onMouseLeave={() => setCameraMenuOpen(false)}>
                    {cameras.length === 0 && <div className="vc-cam__empty">Nenhuma câmera encontrada</div>}
                    {cameras.map((cam, index) => (
                      <button
                        key={cam.deviceId || index}
                        className={cam.deviceId === cameraDeviceId ? "is-active" : ""}
                        onClick={() => void pickCamera(cam.deviceId)}
                      >
                        {cam.label || `Câmera ${index + 1}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                className={muted ? "vc-btn is-danger" : "vc-btn"}
                onClick={() => updateAudioState(!muted, deafened)}
                title={muted ? "Ativar microfone" : "Desativar microfone"}
              >
                <Icon name={muted ? "mic-muted" : "mic-open"} size={22} />
              </button>
              <button
                className={deafened ? "vc-btn is-danger" : "vc-btn"}
                onClick={() => updateAudioState(muted, !deafened)}
                title={deafened ? "Ativar áudio" : "Desativar áudio"}
              >
                <Icon name={deafened ? "headphone-muted" : "headphone"} size={22} />
              </button>
              <button className="vc-btn is-hangup" onClick={leaveCall} title="Desconectar">
                <Icon name="hangout-call" size={22} />
              </button>
            </div>
          </div>
        ) : (
          <div className="chat">
            <div className="messages" ref={messagesScrollRef}>
             <div className="messages__inner">
              {!activeChannel && <p className="empty">Escolha um canal de texto para começar.</p>}
              {activeChannel && historyLoading && <ChatSkeleton rows={skeletonRows} />}
              {activeChannel && !historyLoading && (
                <div className="messages__welcome">
                  <div className="welcome-hash"><HashIcon size={40} /></div>
                  <h2>Bem-vindo a #{activeChannel.name}</h2>
                  <p>Este é o começo do canal #{activeChannel.name}.</p>
                </div>
              )}
              {activeChannel && !historyLoading && messages.length === 0 && <p className="empty">Nenhuma mensagem ainda — comece a conversa!</p>}
              {!historyLoading && messages.map((message, index) => {
                const previous = messages[index - 1];
                const authorId = message.author_id;
                const groupStart =
                  !previous ||
                  previous.author_id !== authorId ||
                  (message.author?.display_name ?? "") !== (previous.author?.display_name ?? "") ||
                  new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() > 5 * 60 * 1000;
                const displayName = message.author?.display_name ?? memberName(authorId);
                const isOwn = authorId != null && authorId === currentUserId;
                const isOwner = members.find(m => m.id === authorId)?.role === "owner";
                const nameColor = isOwner ? "#f0b232" : `hsl(${hueFromString(displayName)} 62% 72%)`;
                const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                return (
                  <article
                    key={message.id}
                    className={
                      "msg msg--compact" +
                      (groupStart ? " is-group-start" : "") +
                      (message.failed ? " is-failed" : message.pending ? " is-pending" : "")
                    }
                  >
                    <span className="msg__ts">{time}</span>
                    <div className="msg__content">
                      <span className="msg__author" style={{ color: nameColor }}>{displayName}{message.author?.profile_tag && <small className="msg__tag">{message.author.profile_badge_url && <img src={message.author.profile_badge_url} alt="" />}{message.author.profile_tag}</small>}</span>
                      <span className="msg__body">
                        {renderText(message.content)}
                        {message.pending && <span className="msg__status">enviando…</span>}
                        {message.failed && (
                          <span className="msg__status">
                            falhou
                            <button onClick={() => retryMessage(message)}>tentar de novo</button>
                            <button onClick={() => cancelMessage(message)}>cancelar</button>
                          </span>
                        )}
                      </span>
                      {message.attachments?.map(attachment => {
                        const isImage = (attachment.content_type ?? "").startsWith("image/");
                        // The native layer inlines image attachments as data:
                        // URIs (NetworkClient.HydrateMediaUrlsAsync). Show a
                        // thumbnail when we have one; otherwise fall back to a
                        // download chip.
                        const inlined = isImage && (attachment.url ?? "").startsWith("data:");
                        return inlined ? (
                          <button
                            className="msg__image"
                            key={attachment.id}
                            title={attachment.filename}
                            onClick={() => send("attachment.open", { attachment_id: attachment.id, filename: attachment.filename })}
                          >
                            <img
                              src={attachment.url ?? ""}
                              alt={attachment.filename}
                              loading="lazy"
                              onLoad={() => {
                                const el = messagesScrollRef.current;
                                if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
                              }}
                            />
                          </button>
                        ) : (
                          <button
                            className="attach"
                            key={attachment.id}
                            onClick={() => send("attachment.open", { attachment_id: attachment.id, filename: attachment.filename })}
                          >
                            <Icon name="add-media" size={16} />
                            {attachment.filename}
                          </button>
                        );
                      })}
                      {message.link_preview && (
                        <a className="link-preview" href={message.link_preview.url} target="_blank" rel="noreferrer noopener">
                          {message.link_preview.image_url && <img src={message.link_preview.image_url} alt="" />}
                          <span className="link-preview__body">
                            {message.link_preview.site_name && <small>{message.link_preview.site_name}</small>}
                            <strong>{message.link_preview.title ?? message.link_preview.url}</strong>
                          </span>
                        </a>
                      )}
                      {message.embeds?.map((embed, i) => <MessageEmbedCard key={i} embed={embed} />)}
                    </div>
                    {isOwn && !message.pending && !message.failed && (
                      <div className="msg__actions">
                        <button onClick={() => editMessage(message)} title="Editar"><PencilIcon size={16} /></button>
                        <button onClick={() => deleteMessage(message)} title="Excluir"><TrashIcon size={16} /></button>
                      </div>
                    )}
                  </article>
                );
              })}
             </div>
            </div>

            {activeChannel && (
              <form className="composer" onSubmit={submitMessage}>
                {slashOpen && (
                  <div className="slash-menu">
                    <div className="slash-menu__head">
                      {call ? "COMANDOS — Tupi Música" : "⚠️ Entre num canal de voz para usar"}
                    </div>
                    {slashMatches.map((command, index) => (
                      <button
                        type="button"
                        key={command.name}
                        className={index === slashIndex ? "slash-menu__item is-active" : "slash-menu__item"}
                        onMouseEnter={() => setSlashSel(index)}
                        onMouseDown={event => { event.preventDefault(); applySlash(command); }}
                      >
                        <span className="slash-menu__name">
                          /{command.name}
                          {command.args && <span className="slash-menu__args"> {command.args}</span>}
                        </span>
                        <span className="slash-menu__desc">{command.desc}</span>
                        <span className="slash-menu__src">Tupi Música</span>
                      </button>
                    ))}
                  </div>
                )}
                {attachmentIds.length > 0 && (
                  <div className="composer__pills">{attachmentIds.length} anexo(s) pronto(s)</div>
                )}
                <div className="composer__box">
                  <button type="button" className="composer__add" disabled={uploading} onClick={pickAttachment} title="Anexar">
                    <Icon name="add-media" size={16} />
                  </button>
                  <input
                    ref={composerRef}
                    value={content}
                    onChange={event => setContent(event.target.value)}
                    onKeyDown={onComposerKeyDown}
                    placeholder={`Conversar em #${activeChannel.name}`}
                    maxLength={4000}
                  />
                  <div className="composer__icons">
                    <button type="button" title="Enviar presente"><Icon name="send-gift" size={22} /></button>
                    <button type="button" title="GIF"><Icon name="send-gif" size={22} /></button>
                    <button type="button" title="Figurinha"><Icon name="send-sticker" size={22} /></button>
                    <button type="submit" disabled={!connected} title="Emoji"><Icon name="activities" size={22} /></button>
                  </div>
                </div>
              </form>
            )}
          </div>
        )}
        </section>

        {/* ---- member list ---- */}
        {showMembers && !(inThisVoice && theater) && (
          <aside className="members">
            <button
              className={shareActivity ? "members__share is-on" : "members__share"}
              onClick={() => setShareActivity(value => !value)}
              title={shareActivity
                ? "Sua atividade (música/jogo) está visível para a comunidade"
                : "Sua atividade não está sendo compartilhada"}
            >
              <Icon name="activities" size={14} />
              <span>{shareActivity ? "Compartilhando atividade" : "Atividade oculta"}</span>
            </button>
            <ActivityPanel members={members} activities={activities} apiBaseUrl={apiBaseUrl} />
            <MemberList
              members={members}
              presence={presence}
              botNowPlaying={(() => {
                const musicStream = streams.find(stream => stream.kind === "music")
                  ?? Object.values(voiceRoomStreams).flat().find(stream => stream.kind === "music");
                return musicStream ? (musicStream.label ?? "tocando") : null;
              })()}
              onMemberContextMenu={(event, member) => openMenu(event, memberMenuItems(member.id))}
            />
          </aside>
        )}
        </div>
      </div>

      {pickerOpen && (
        <ScreenPicker
          sources={sources}
          loading={sourcesLoading}
          channelName={channels.find(c => c.id === call?.channelId)?.name ?? "Canal de voz"}
          onPick={shareSource}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </main>
  );
}

function MemberList({
  members,
  presence,
  botNowPlaying,
  onMemberContextMenu,
}: {
  members: Member[];
  presence: Record<string, "online" | "busy" | "offline">;
  // Non-null when Tupi Música is currently playing (the track label); the bot
  // row itself is always shown — it's a permanent fixture like a Discord bot.
  botNowPlaying: string | null;
  onMemberContextMenu: (event: ReactMouseEvent, member: Member) => void;
}) {
  const online = members.filter(member => presence[member.id] !== "offline");
  const offline = members.filter(member => presence[member.id] === "offline");
  const row = (member: Member, isOffline: boolean) => (
    <div
      key={member.id}
      className={
        "member" +
        (isOffline ? " is-offline" : "") +
        (presence[member.id] === "busy" ? " is-busy" : "") +
        (member.role === "owner" ? " is-owner" : "")
      }
      onContextMenu={event => onMemberContextMenu(event, member)}
    >
      <Avatar label={member.display_name} size={32} className="member__avatar" imageUrl={member.avatar_url} />
      <span className="member__name">{member.display_name}{member.profile_tag && <small className="member__tag">{member.profile_badge_url && <img src={member.profile_badge_url} alt="" />}{member.profile_tag}</small>}</span>
      {member.role === "owner" && <CrownIcon className="member__crown" />}
    </div>
  );
  return (
    <>
      <div className="members__group">Online — {online.length + 1}</div>
      <div className="member member--bot">
        <Avatar label="Tupi Música" size={32} className="member__avatar" />
        <span className="member__name">Tupi Música<small className="member__tag">BOT</small></span>
        {botNowPlaying && <span className="member__status">🎵 {botNowPlaying}</span>}
      </div>
      {online.map(member => row(member, false))}
      {offline.length > 0 && <div className="members__group">Offline — {offline.length}</div>}
      {offline.map(member => row(member, true))}
    </>
  );
}

/* ---- activity (rich presence) panel ---- */

// A once-per-second clock, only ticking while something is mounted that
// needs it (the elapsed timers). Cheap: one interval for the whole panel.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function formatElapsed(startedAt: string, now: number) {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  let seconds = Math.floor((now - start) / 1000);
  if (seconds < 0) seconds = 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const two = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

const ACTIVITY_VERB: Record<ActivityDto["kind"], string> = {
  playing: "Jogando",
  listening: "Ouvindo",
  watching: "Assistindo",
  browsing: "Navegando",
};

const ACTIVITY_ICON: Record<ActivityDto["kind"], IconName> = {
  playing: "activities",
  listening: "sound-effects",
  watching: "share-screen",
  browsing: "wifi-connect",
};

// Turn the opaque `asset_image` ref into something an <img> can load.
// `att:` refs normally arrive already inlined as `data:` URIs by the native
// host (no cross-origin / auth concern); the raw `att:`→API-origin fallback
// only matters if that inlining was skipped. Steam header art is public.
function resolveActivityArt(ref: string | null | undefined, apiBaseUrl: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("data:") || /^https?:\/\//i.test(ref)) return ref;
  const steam = /^steam:(\d+)$/.exec(ref);
  if (steam) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steam[1]}/header.jpg`;
  const att = /^att:([0-9a-f]{64})$/.exec(ref);
  if (att && apiBaseUrl) return `${apiBaseUrl}/activity-assets/${att[1]}`;
  return null;
}

function formatPlaytime(totalSeconds: number | null | undefined): string | null {
  if (!totalSeconds || totalSeconds < 300) return null;
  const hours = totalSeconds / 3600;
  return hours >= 1 ? `${Math.round(hours)}h jogadas` : `${Math.round(totalSeconds / 60)}min jogadas`;
}

function ActivityPanel({
  members,
  activities,
  apiBaseUrl,
}: {
  members: Member[];
  activities: Record<string, ActivityDto[]>;
  apiBaseUrl: string;
}) {
  const rows = members
    .map(member => ({ member, list: activities[member.id] ?? [] }))
    .filter(entry => entry.list.length > 0);
  const now = useNow(rows.length > 0);
  if (rows.length === 0) return null;
  return (
    <div className="activity-panel">
      <div className="members__group">Atividade — {rows.length}</div>
      {rows.map(({ member, list }) => (
        <div className="activity" key={member.id}>
          <Avatar label={member.display_name} size={40} className="activity__avatar" />
          <div className="activity__body">
            <div className="activity__who">{member.display_name}</div>
            {list.map((item, index) => {
              const elapsed = item.started_at ? formatElapsed(item.started_at, now) : null;
              const art = resolveActivityArt(item.asset_image, apiBaseUrl);
              const playtime = item.kind === "playing" ? formatPlaytime(item.total_seconds) : null;
              return (
                <div className="activity__item" key={`${item.kind}:${item.name}:${index}`}>
                  {art && (
                    <img
                      className="activity__art"
                      src={art}
                      alt=""
                      loading="lazy"
                      onError={event => { (event.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  )}
                  <div className="activity__item-text">
                    <span className="activity__verb">
                      <Icon name={ACTIVITY_ICON[item.kind] ?? "activities"} size={12} />
                      {(ACTIVITY_VERB[item.kind] ?? "Em") + " " + item.name}
                      {item.kind === "playing" && item.is_new && <span className="activity__badge">Novo jogador</span>}
                    </span>
                    {item.details && <span className="activity__line">{item.details}</span>}
                    {item.state && <span className="activity__line is-dim">{item.state}</span>}
                    <span className="activity__meta">
                      {elapsed && <span className="activity__time">{elapsed}</span>}
                      {playtime && <span className="activity__total">{playtime}</span>}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
