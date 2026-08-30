import { FormEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject, useEffect, useMemo, useRef, useState } from "react";
import { send, subscribe } from "./ipc";
import * as rtc from "./rtc";
import { playSound, setSoundsMuted } from "./sounds";
import { Icon, IconName } from "./Icon";
import { HashIcon, SearchIcon, PencilIcon, TrashIcon, CrownIcon, FullscreenIcon, ContractIcon, PipIcon, DotsIcon, TheaterIcon, MusicNoteIcon } from "./Glyphs";
import { ScreenPicker, QualityControls, CaptureSource, ShareOptions } from "./ScreenPicker";
import { SettingsModal, ProfileUpdateData } from "./SettingsModal";
import { UserProfileModal, UserProfileData, AnchorRect } from "./UserProfileModal";
import { BANNER_PRESETS, getBannerPreset } from "./banners";
import { matchesVoiceShortcut, type VoiceInputMode } from "./voiceShortcut";
import logoUrl from "../icons/logo.webp";

type Channel = { id: string; name: string; kind: "text" | "voice"; topic?: string | null };
type ChannelCategory = { id: string; name: string; position: number; channels: Channel[] };
type Member = { id: string; display_name: string; username: string; role: string; avatar_url?: string | null; profile_tag?: string | null; profile_badge_url?: string | null; name_color?: string | null; banner_preset?: string | null; bio?: string | null; pronouns?: string | null; created_at?: string | null };
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
type MusicStatus = {
  kind: "loading" | "queued" | "playing" | "paused" | "resumed" | "skipped" | "stopped" | "finished" | "disconnected" | "queue" | "error";
  origin?: string | null; provider?: string | null; title?: string | null; artist?: string | null;
  detail?: string | null; count?: number | null; position?: number | null;
  queue_size?: number | null; duration_ms?: number | null; total_duration_ms?: number | null; eta_ms?: number | null;
  image_url?: string | null; source_url?: string | null; collection_name?: string | null; collection_kind?: "album" | "playlist" | null;
  requested_by?: string | null;
  items?: { title: string; artist?: string | null; duration_ms?: number | null }[];
};
type Message = {
  id: string; content: string; created_at: string; author?: { display_name: string; avatar_url?: string | null; profile_tag?: string | null; profile_badge_url?: string | null }; author_id?: string; attachments?: Attachment[];
  link_preview?: { url: string; title?: string | null; description?: string | null; site_name?: string | null; image_url?: string | null } | null;
  embeds?: MessageEmbed[];
  music_status?: MusicStatus;
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
const NON_TEXT_INPUT_TYPES = new Set([
  "button", "checkbox", "color", "file", "radio", "range", "reset", "submit",
]);
// Virtual music bot's fixed id (server: MUSIC_BOT_ID = Uuid::from_u128(1)).
const MUSIC_BOT_ID = "00000000-0000-0000-0000-000000000001";

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

function isUserMentioned(
  content: string | undefined,
  currentUserId: string | null,
  currentUser: { display_name?: string; username?: string } | null
) {
  if (!content) return false;
  const lower = content.toLowerCase();
  if (lower.includes("@everyone") || lower.includes("@here")) return true;
  if (currentUserId && content.includes(`<@${currentUserId}>`)) return true;
  if (currentUser?.display_name && lower.includes(`@${currentUser.display_name.toLowerCase()}`)) return true;
  if (currentUser?.username && lower.includes(`@${currentUser.username.toLowerCase()}`)) return true;
  return false;
}

function renderText(
  text: string,
  currentUserId?: string | null,
  currentUser?: { display_name?: string; username?: string } | null,
  membersList: Member[] = []
) {
  if (!text) return null;

  const currentDisplayName = currentUser?.display_name?.toLowerCase();
  const currentUsername = currentUser?.username?.toLowerCase();

  return text.split(/(https?:\/\/[^\s]+|@[a-zA-Z0-9_\u00C0-\u017F-]+|<@[a-f0-9-]+>)/g).map((part, index) => {
    if (!part) return null;

    if (/^https?:\/\//.test(part)) {
      return (
        <a key={index} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      );
    }

    if (part.startsWith("@") || part.startsWith("<@")) {
      let mentionDisplay = part;
      let isMe = false;

      if (part.startsWith("<@") && part.endsWith(">")) {
        const id = part.slice(2, -1);
        const m = membersList.find(mem => mem.id === id);
        mentionDisplay = m ? `@${m.display_name}` : `@membro`;
        isMe = id === currentUserId;
      } else {
        const query = part.slice(1).toLowerCase();
        isMe =
          query === "everyone" ||
          query === "here" ||
          (!!currentDisplayName && currentDisplayName === query) ||
          (!!currentUsername && currentUsername === query);
      }

      return (
        <span
          key={index}
          className={`msg__mention ${isMe ? "msg__mention--me" : ""}`}
        >
          {mentionDisplay}
        </span>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

function SpotifyLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-label="Spotify" role="img">
      <circle cx="12" cy="12" r="12" fill="#1ed760" />
      <path d="M5.7 9.1c4.2-1.25 8.85-.96 12.65.79" fill="none" stroke="#101010" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M6.55 12.45c3.55-1.02 7.48-.78 10.72.64" fill="none" stroke="#101010" strokeWidth="1.65" strokeLinecap="round" />
      <path d="M7.3 15.55c2.9-.78 6.05-.59 8.68.51" fill="none" stroke="#101010" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

function YouTubeLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-label="YouTube" role="img">
      <path d="M23.5 7.1a3 3 0 0 0-2.1-2.12C19.54 4.5 12 4.5 12 4.5s-7.54 0-9.4.48A3 3 0 0 0 .5 7.1 31 31 0 0 0 0 12a31 31 0 0 0 .5 4.9 3 3 0 0 0 2.1 2.12c1.86.48 9.4.48 9.4.48s7.54 0 9.4-.48a3 3 0 0 0 2.1-2.12A31 31 0 0 0 24 12a31 31 0 0 0-.5-4.9Z" fill="#ff0033" />
      <path d="m9.6 15.25 6.3-3.25-6.3-3.25v6.5Z" fill="#fff" />
    </svg>
  );
}

function MusicProviderLogo({ status }: { status: MusicStatus }) {
  const brand = (status.origin === "spotify" || status.origin === "youtube" ? status.origin : status.provider)?.toLowerCase();
  if (brand === "spotify") return <SpotifyLogo />;
  if (brand === "youtube") return <YouTubeLogo />;
  return <MusicNoteIcon />;
}

const MUSIC_STATUS_LABEL: Record<MusicStatus["kind"], string> = {
  loading: "Procurando uma fonte",
  queued: "Adicionada à fila",
  playing: "Tocando agora",
  paused: "Reprodução pausada",
  resumed: "Reprodução retomada",
  skipped: "Faixa pulada",
  stopped: "Fila encerrada",
  finished: "Reprodução finalizada",
  disconnected: "Bot desconectado",
  queue: "Fila atual",
  error: "Não foi possível reproduzir",
};

function formatMusicDuration(value?: number | null) {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function MusicStatusCard({ status, members }: { status: MusicStatus; members: Member[] }) {
  const [imageFailed, setImageFailed] = useState(false);
  const suffix = status.artist ? ` por ${status.artist}` : "";
  const requestedBy = status.requested_by ? members.find(member => member.id === status.requested_by) : null;
  const duration = formatMusicDuration(status.duration_ms);
  const totalDuration = formatMusicDuration(status.total_duration_ms);
  const eta = formatMusicDuration(status.eta_ms);
  const visibleItems = status.items?.slice(0, 5) ?? [];
  return (
    <div className={`music-status music-status--${status.kind}`}>
      {status.image_url && !imageFailed ? (
        <a className="music-status__art-link" href={status.source_url || status.image_url} target="_blank" rel="noreferrer noopener">
          <img className="music-status__art" src={status.image_url} alt="" loading="lazy" onError={() => setImageFailed(true)} />
          <span className="music-status__art-provider"><MusicProviderLogo status={status} /></span>
        </a>
      ) : <span className="music-status__provider"><MusicProviderLogo status={status} /></span>}
      <div className="music-status__copy">
        <span className="music-status__label">{MUSIC_STATUS_LABEL[status.kind]}</span>
        {status.title && (status.source_url
          ? <a className="music-status__track" href={status.source_url} target="_blank" rel="noreferrer noopener">{status.title}<span className="music-status__artist">{suffix}</span></a>
          : <span className="music-status__track">{status.title}<span className="music-status__artist">{suffix}</span></span>)}
        {status.collection_name && status.collection_name !== status.title && (
          <span className="music-status__collection">{status.collection_kind === "album" ? "Álbum" : "Playlist"} · {status.collection_name}</span>
        )}
        {status.kind === "queue" && <span className="music-status__count">{status.count ?? 0} faixa(s) aguardando</span>}
        {(duration || totalDuration || (status.kind === "queued" && (eta !== null || status.position || status.queue_size))) && (
          <div className="music-status__facts">
            {duration && <span><b>Duração</b>{duration}</span>}
            {totalDuration && <span><b>Duração total</b>{totalDuration}</span>}
            {status.count != null && status.count > 1 && <span><b>Faixas</b>{status.count}</span>}
            {eta !== null && status.kind === "queued" && <span><b>Estimativa até tocar</b>{eta}</span>}
            {status.kind === "queued" && !!status.position && <span><b>Primeira faixa na posição</b>{status.position}</span>}
            {status.kind === "queued" && !!status.queue_size && <span><b>Total aguardando</b>{status.queue_size}</span>}
          </div>
        )}
        {visibleItems.length > 0 && (status.count ?? 0) > 1 && (
          <ol className="music-status__items">
            {visibleItems.map((item, index) => (
              <li key={`${item.title}-${index}`}>
                <span>{item.title}{item.artist ? ` — ${item.artist}` : ""}</span>
                <time>{formatMusicDuration(item.duration_ms) || "—"}</time>
              </li>
            ))}
            {(status.count ?? 0) > visibleItems.length && <li className="music-status__items-more">+ {(status.count ?? 0) - visibleItems.length} outras faixas</li>}
          </ol>
        )}
        {status.detail && <span className="music-status__detail">{status.detail}</span>}
        {requestedBy && (
          <span className="music-status__requester">
            {requestedBy.avatar_url && <img src={requestedBy.avatar_url} alt="" />}
            Pedido por {requestedBy.display_name}
          </span>
        )}
      </div>
    </div>
  );
}


// Renders rich Twitter / WhatsApp / Discord style link previews with 3D card layout
function LinkPreviewCard({ preview }: { preview: NonNullable<Message["link_preview"]> }) {
  const isYouTube =
    (preview.site_name?.toLowerCase().includes("youtube") ?? false) ||
    preview.url.includes("youtu.be") ||
    preview.url.includes("youtube.com");

  const [imgFailed, setImgFailed] = useState(false);

  let hostname = preview.site_name;
  if (!hostname) {
    try {
      hostname = new URL(preview.url).hostname.replace(/^www\./, "");
    } catch {
      hostname = preview.url;
    }
  }

  const hasImage = !!preview.image_url && !imgFailed;
  const isLargeMedia = isYouTube || hasImage;

  return (
    <a
      className={`link-preview-card ${isLargeMedia ? "link-preview-card--media" : ""}`}
      href={preview.url}
      target="_blank"
      rel="noreferrer noopener"
    >
      {hasImage && isYouTube && (
        <div className="link-preview-card__media-wrap">
          <img
            src={preview.image_url!}
            alt={preview.title ?? "Video thumbnail"}
            className="link-preview-card__banner"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
          <div className="link-preview-card__play-badge" title="Assistir no YouTube">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
      )}

      {hasImage && !isYouTube && (
        <div className="link-preview-card__thumb-wrap">
          <img
            src={preview.image_url!}
            alt=""
            className="link-preview-card__thumb"
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        </div>
      )}

      <div className="link-preview-card__content">
        <div className="link-preview-card__site">
          {isYouTube ? (
            <span className="link-preview-card__site-badge link-preview-card__site-badge--yt">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
              </svg>
              YouTube
            </span>
          ) : (
            <span className="link-preview-card__site-name">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              {hostname}
            </span>
          )}
        </div>

        <strong className="link-preview-card__title">
          {preview.title ?? preview.url}
        </strong>

        {preview.description && (
          <p className="link-preview-card__desc">
            {preview.description}
          </p>
        )}
      </div>
    </a>
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
  onStopWatch,
  screenAudioMuted = false,
  screenAudioVolume = 1,
  onToggleScreenAudioMute,
  onScreenAudioVolumeChange,
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
  // Screen variant only: stop viewing, and control the SHARE's audio (never
  // the sharer's mic).
  onStopWatch?: () => void;
  screenAudioMuted?: boolean;
  screenAudioVolume?: number;
  onToggleScreenAudioMute?: () => void;
  onScreenAudioVolumeChange?: (volume: number) => void;
}) {
  const isCamera = variant === "camera";
  // On a screen tile the mute/volume act on the share's audio; on a camera
  // tile they act on the person (same as their avatar tile).
  const audioMuted = isCamera ? peerMuted : screenAudioMuted;
  const onToggleAudio = isCamera ? onToggleMute : (onToggleScreenAudioMute ?? onToggleMute);
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
        muted
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
          <button
            className={audioMuted ? "vhud-btn is-on" : "vhud-btn"}
            title={audioMuted ? (isCamera ? "Ativar som" : "Ativar som da tela") : (isCamera ? "Silenciar" : "Silenciar tela")}
            onClick={onToggleAudio}
          >
            <Icon name={audioMuted ? "headphone-muted" : "headphone"} size={16} />
          </button>
        )}
        {!isSelf && !isCamera && onStopWatch && (
          <button className="vhud-btn" title="Parar de assistir" onClick={onStopWatch}>
            <Icon name="share-screen" size={16} />
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
              {!isSelf && (
                <button onClick={() => { onToggleAudio(); setMenuOpen(false); }}>
                  {audioMuted ? (isCamera ? "Ativar som" : "Ativar som da tela") : (isCamera ? "Silenciar" : "Silenciar tela")}
                </button>
              )}
              {!isSelf && !isCamera && onScreenAudioVolumeChange && (
                <label className="vhud-slider" onClick={e => e.stopPropagation()}>
                  <span>Volume da tela {Math.round((screenAudioVolume ?? 1) * 100)}%</span>
                  <input
                    type="range" min={0} max={100} step={1}
                    value={Math.round((screenAudioVolume ?? 1) * 100)}
                    onChange={e => onScreenAudioVolumeChange(parseInt(e.target.value, 10) / 100)}
                  />
                </label>
              )}
              {!isSelf && !isCamera && onStopWatch && (
                <button onClick={() => { onStopWatch(); setMenuOpen(false); }}>Parar de assistir</button>
              )}
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
// A native colour picker embedded in the menu; `value` null = default colour.
type MenuColor = {
  kind: "color";
  label: string;
  value: string | null;
  onChange: (hex: string | null) => void;
};
type MenuItem = MenuAction | MenuSlider | MenuColor;
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
          ? (item.kind === "slider"
            ? <MenuSliderRow key={index} item={item} />
            : <MenuColorRow key={index} item={item} />)
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

function MenuColorRow({ item }: { item: MenuColor }) {
  const [value, setValue] = useState(item.value ?? "#5865f2");
  return (
    <div className="ctx-menu__color">
      <span>{item.label}</span>
      <input
        type="color"
        value={value}
        onChange={event => { setValue(event.target.value); item.onChange(event.target.value); }}
      />
      {item.value && (
        <button
          type="button"
          className="ctx-menu__color-reset"
          title="Redefinir para o padrão"
          onClick={() => item.onChange(null)}
        >
          ✕
        </button>
      )}
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

function AudioWaveform({ color = "var(--yellow)" }: { color?: string }) {
  return (
    <svg className="voice-panel__waveform" width={18} height={18} viewBox="0 0 18 18" fill="none">
      <rect x="2" y="5" width="2.5" height="8" rx="1.25" fill={color} className="wave-bar wave-bar--1" />
      <rect x="6" y="2" width="2.5" height="14" rx="1.25" fill={color} className="wave-bar wave-bar--2" />
      <rect x="10" y="4" width="2.5" height="10" rx="1.25" fill={color} className="wave-bar wave-bar--3" />
      <rect x="14" y="6" width="2.5" height="6" rx="1.25" fill={color} className="wave-bar wave-bar--4" />
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
  const [currentUser, setCurrentUser] = useState<{ id: string; display_name: string; username?: string; avatar_url?: string | null; name_color?: string | null } | null>(null);
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
  const [readyAttachments, setReadyAttachments] = useState<Array<{ id: string; name: string; previewUrl?: string | null; type: string }>>([]);
  const [uploadingFile, setUploadingFile] = useState<{ name: string; previewUrl?: string | null; type: string } | null>(null);
  const uploadingFileRef = useRef<{ name: string; previewUrl?: string | null; type: string } | null>(null);
  uploadingFileRef.current = uploadingFile;
  const pendingUploadPreviewsRef = useRef<Map<string, string>>(new Map());
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Slash-command palette: highlighted row + the content value the user last
  // pressed Esc on (so it stays closed without wiping what they typed).
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismiss, setSlashDismiss] = useState("");
  const composerRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [navMode, setNavMode] = useState<"guild" | "dm">("guild");
  const [activeDmUserId, setActiveDmUserId] = useState<string | null>(null);
  const [activeDmConversations, setActiveDmConversations] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("tk.activeDmUsers") || "[]"); } catch { return []; }
  });
  const [newDmModalOpen, setNewDmModalOpen] = useState(false);
  const [newDmSearch, setNewDmSearch] = useState("");
  const pendingDmMessageRef = useRef<{ targetUserId: string; text: string } | null>(null);
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
  const [bannerPreset, setBannerPreset] = useState<string>(() => {
    try { return localStorage.getItem("tk.bannerPreset") || "sakura"; } catch { return "sakura"; }
  });
  const [call, setCall] = useState<{ channelId: string; participants: Participant[] } | null>(null);
  const [voiceConnState, setVoiceConnState] = useState<"waiting_server" | "authenticating" | "connecting" | "connected" | "disconnected">("disconnected");
  const voiceConnTimers = useRef<number[]>([]);
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
  // While a share is live, the share button opens this little menu instead of
  // stopping immediately: change quality (reuses the wizard's step-2 controls,
  // applied live) or actually stop.
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareQualityOpen, setShareQualityOpen] = useState(false);
  const [shareQuality, setShareQuality] = useState<{ height: number; fps: number }>({ height: 720, fps: 30 });
  // The picker doubles as the "change which screen" dialog for a live share —
  // in that mode it skips the quality step.
  const [pickerSourceOnly, setPickerSourceOnly] = useState(false);
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
  // Local-only per-user playback volume (0..1, 1 = default). Not sent anywhere.
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>(() => rtc.getPeerVolumes());
  // Local-only, per screen-share: mute / volume for the SHARE's audio only —
  // independent of the sharer's microphone (rtc.ts routes it to its own sink).
  const [screenMutedPeers, setScreenMutedPeers] = useState<Record<string, boolean>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>(() => rtc.getScreenAudioVolumes());
  const [noiseSup, setNoiseSup] = useState(() => {
    try { return localStorage.getItem("tk.noiseSuppression") !== "off"; } catch { return true; }
  });
  const [showSharingToast, setShowSharingToast] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    current_version: string;
    latest_version: string;
    release_notes: string;
    download_url: string;
    file_size_bytes?: number;
  } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateReadyPath, setUpdateReadyPath] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<"voice" | "account" | "appearance">("voice");
  const [selectedProfileUserId, setSelectedProfileUserId] = useState<string | null>(null);
  const [profileAnchorRect, setProfileAnchorRect] = useState<AnchorRect | null>(null);

  function openProfile(userId: string, anchorEl?: HTMLElement | null) {
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setProfileAnchorRect({ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom });
    } else {
      setProfileAnchorRect(null);
    }
    setSelectedProfileUserId(userId);
  }

  const selectedProfileUser: UserProfileData | null = useMemo(() => {
    if (!selectedProfileUserId) return null;
    if (selectedProfileUserId === currentUserId && currentUser) {
      const selfMember = members.find(m => m.id === currentUserId);
      return {
        id: currentUser.id,
        display_name: currentUser.display_name,
        username: currentUser.username || "membro",
        avatar_url: currentUser.avatar_url,
        name_color: currentUser.name_color,
        bio: (currentUser as any).bio ?? selfMember?.bio,
        banner_preset: (currentUser as any).banner_preset ?? selfMember?.banner_preset ?? bannerPreset,
        pronouns: (currentUser as any).pronouns ?? selfMember?.pronouns,
        created_at: (currentUser as any).created_at ?? selfMember?.created_at,
        role: selfMember?.role || "member",
        profile_tag: selfMember?.profile_tag,
      };
    }
    if (
      selectedProfileUserId === MUSIC_BOT_ID ||
      selectedProfileUserId === "bot-music" ||
      selectedProfileUserId === "tupi-musica"
    ) {
      return {
        id: MUSIC_BOT_ID,
        display_name: "Tupi Música",
        username: "tupi-musica",
        role: "bot",
        profile_tag: "BOT",
        name_color: "#5865f2",
        banner_preset: "synthwave",
        bio: "Bot oficial de entretenimento do Tupi. Toque qualquer música ou rádio do YouTube ou Spotify nos canais de voz usando /play.",
        pronouns: "ele/bot",
        created_at: "2026-08-28T00:00:00Z",
      };
    }
    const target = members.find(m => m.id === selectedProfileUserId);
    if (!target) return null;
    return {
      id: target.id,
      display_name: target.display_name,
      username: target.username || "membro",
      avatar_url: target.avatar_url,
      name_color: target.name_color,
      bio: target.bio,
      banner_preset: target.banner_preset,
      pronouns: target.pronouns,
      created_at: target.created_at,
      role: target.role,
      profile_tag: target.profile_tag,
      profile_badge_url: target.profile_badge_url,
    };
  }, [selectedProfileUserId, currentUserId, currentUser, members, bannerPreset]);

  function handleProfileSave(data: ProfileUpdateData) {
    if (data.banner_preset) {
      setBannerPreset(data.banner_preset);
      try { localStorage.setItem("tk.bannerPreset", data.banner_preset); } catch {}
    }
    if (currentUserId) {
      setMembers(current => current.map(m => m.id === currentUserId ? {
        ...m,
        display_name: data.display_name ?? m.display_name,
        bio: data.bio !== undefined ? data.bio : m.bio,
        banner_preset: data.banner_preset ?? m.banner_preset,
        pronouns: data.pronouns !== undefined ? data.pronouns : m.pronouns,
        name_color: data.name_color !== undefined ? data.name_color : m.name_color,
      } : m));
      setCurrentUser(current => current ? {
        ...current,
        display_name: data.display_name ?? current.display_name,
        name_color: data.name_color !== undefined ? data.name_color : current.name_color,
        bio: data.bio !== undefined ? data.bio : (current as any).bio,
        banner_preset: data.banner_preset ?? (current as any).banner_preset,
        pronouns: data.pronouns !== undefined ? data.pronouns : (current as any).pronouns,
      } : current);
    }
    send("profile.update", data as unknown as Record<string, unknown>);
  }
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
  const currentUserRef = useRef<{ id: string; display_name: string; username?: string; avatar_url?: string | null; name_color?: string | null } | null>(null);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);
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
        const updated = event.data as { user_id: string; username?: string; role?: string; display_name: string; avatar_url?: string | null; profile_tag?: string | null; name_color?: string | null; bio?: string | null; banner_preset?: string | null; pronouns?: string | null; created_at?: string | null };
        setMembers(current => {
          const exists = current.some(member => member.id === updated.user_id);
          if (exists) {
            return current.map(member => member.id === updated.user_id
              ? {
                  ...member,
                  display_name: updated.display_name ?? member.display_name,
                  avatar_url: updated.avatar_url !== undefined ? updated.avatar_url : member.avatar_url,
                  profile_tag: updated.profile_tag !== undefined ? updated.profile_tag : member.profile_tag,
                  name_color: updated.name_color !== undefined ? updated.name_color : member.name_color,
                  bio: updated.bio !== undefined ? updated.bio : member.bio,
                  banner_preset: updated.banner_preset !== undefined ? updated.banner_preset : member.banner_preset,
                  pronouns: updated.pronouns !== undefined ? updated.pronouns : member.pronouns,
                  created_at: updated.created_at !== undefined ? updated.created_at : member.created_at,
                }
              : member);
          } else {
            return [
              ...current,
              {
                id: updated.user_id,
                username: updated.username ?? "",
                role: updated.role ?? "member",
                display_name: updated.display_name,
                avatar_url: updated.avatar_url ?? null,
                profile_tag: updated.profile_tag ?? null,
                name_color: updated.name_color ?? null,
                bio: updated.bio ?? null,
                banner_preset: updated.banner_preset ?? null,
                pronouns: updated.pronouns ?? null,
                created_at: updated.created_at ?? null,
              }
            ];
          }
        });
        if (updated.user_id === selfIdRef.current) {
          if (updated.banner_preset) setBannerPreset(updated.banner_preset);
          setCurrentUser(current => current ? {
            ...current,
            display_name: updated.display_name ?? current.display_name,
            avatar_url: updated.avatar_url !== undefined ? updated.avatar_url : current.avatar_url,
            name_color: updated.name_color !== undefined ? updated.name_color : current.name_color,
            bio: updated.bio !== undefined ? updated.bio : (current as any).bio,
            banner_preset: updated.banner_preset !== undefined ? updated.banner_preset : (current as any).banner_preset,
            pronouns: updated.pronouns !== undefined ? updated.pronouns : (current as any).pronouns,
          } : current);
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
      if (event.op === "call.state.update") setCall(current => !current || current.channelId !== event.data.channel_id ? current : { channelId: current.channelId, participants: current.participants.map(participant => participant.user_id === event.data.user_id ? { ...participant, muted: event.data.muted, deafened: event.data.deafened } : participant) });
      // The owner dragged us (or we dragged ourselves) into another voice
      // channel — join it, reusing the normal join path.
      if (event.op === "voice.moved") {
        const destId: string = event.data.channel_id;
        const dest = channels.find(channel => channel.id === destId)
          ?? { id: destId, name: "", kind: "voice" as const };
        setActiveChannel(dest);
        joinCall(dest);
      }
      // The owner kicked us out of the voice channel — tear our call down.
      if (event.op === "voice.disconnected") {
        leaveCall();
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
        if (channel_id === callChannelIdRef.current) {
          setCall({ channelId: channel_id, participants: participants ?? [] });
          setStreams(roomStreams ?? []);
        }
        // If the share we're peeking just disappeared, drop the preview.
        if (peekMetaRef.current && (roomStreams ?? []).every(s => s.stream_id !== peekMetaRef.current!.streamId)) {
          endPeek();
        }
      }
      // The music bot's status cards now arrive as ordinary persisted messages
      // (`chat.message.created` with a `music_status` payload) and load with
      // channel history — no separate transient `music.announcement` path.
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
      if (event.op === "dm.opened") {
        const ch = event.data?.channel as Channel | undefined;
        const targetUserId = event.data?.target_user_id as string | undefined;
        if (ch) {
          chooseChannel(ch);
          if (targetUserId) {
            setActiveDmUserId(targetUserId);
            setActiveDmConversations(curr => {
              if (curr.includes(targetUserId)) return curr;
              return [targetUserId, ...curr];
            });
          }
          const pending = pendingDmMessageRef.current;
          if (pending && pending.targetUserId === targetUserId) {
            pendingDmMessageRef.current = null;
            const reqId = crypto.randomUUID();
            setMessages(curr => [...curr, {
              id: reqId, reqId, content: pending.text, created_at: new Date().toISOString(), author_id: selfIdRef.current ?? undefined,
              pending: true, pendingAttachmentIds: [],
            }]);
            sendOptimistic(reqId, ch.id, pending.text, []);
          }
        }
      }
      if (event.op === "chat.message.created") {
        const created = event.data.message;
        const createdChannelId: string | undefined = created?.channel_id;
        const isMusicBot = created?.author_id === MUSIC_BOT_ID;
        const fromSomeoneElse = !!created?.author_id && created.author_id !== selfIdRef.current && !isMusicBot;
        const lookingAtIt = createdChannelId === activeChannel?.id;
        const isMention = fromSomeoneElse && isUserMentioned(created?.content, selfIdRef.current, currentUserRef.current);
        // If received a message from someone else, auto-add them to active DM list if it's a DM channel
        if (fromSomeoneElse && created.author_id) {
          setActiveDmConversations(curr => {
            if (curr.includes(created.author_id)) return curr;
            return [created.author_id, ...curr];
          });
        }
        // A message from someone else mentioning the user ALWAYS chimes and marks unread
        if (fromSomeoneElse) {
          if (isMention) {
            if (myStatusRef.current !== "busy") playSound("notification");
            if (createdChannelId) setUnread(current => ({ ...current, [createdChannelId]: true }));
          } else if (!lookingAtIt) {
            if (myStatusRef.current !== "busy") playSound("notification");
            if (createdChannelId) setUnread(current => current[createdChannelId] ? current : { ...current, [createdChannelId]: true });
          }
        } else if (isMusicBot && !lookingAtIt && createdChannelId) {
          // The Tupi Música bot's status cards mark the channel unread but
          // never chime — they can arrive several per song.
          setUnread(current => current[createdChannelId] ? current : { ...current, [createdChannelId]: true });
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
      if (event.op === "chat.message.preview_updated") setMessages(current => current.map(message => message.id === event.data.message_id ? { ...message, link_preview: event.data.link_preview } : message));
      if (event.op === "chat.message.deleted") setMessages(current => current.filter(message => message.id !== event.data.message_id));
      if (event.op === "connection.state") setConnectionState(event.data.state);
      if (event.op === "screen.sources") { setSources(event.data.sources ?? []); setSourcesLoading(false); }
      if (event.op === "attachment.uploaded") {
        const att = event.data;
        const isImage = (att.content_type ?? "").startsWith("image/");
        let preview = (att.url && (att.url.startsWith("data:") || att.url.startsWith("blob:") || att.url.startsWith("http"))) ? att.url : null;
        if (isImage && !preview) {
          preview = (att.filename && pendingUploadPreviewsRef.current.get(att.filename)) || uploadingFileRef.current?.previewUrl || null;
        }
        setAttachmentIds(current => [...current, att.id]);
        setReadyAttachments(current => [...current, {
          id: att.id,
          name: att.filename || "anexo",
          previewUrl: preview,
          type: att.content_type || "application/octet-stream"
        }]);
        setUploading(false);
        setUploadingFile(null);
      }
      if (event.op === "attachment.cancelled") {
        setUploading(false);
        setUploadingFile(null);
      }
      if (event.op === "update.available") {
        setUpdateInfo(event.data);
        setUpdateDismissed(false);
      }
      if (event.op === "update.progress") {
        setUpdateProgress(typeof event.data.percent === "number" ? event.data.percent : 0);
      }
      if (event.op === "update.ready") {
        setUpdateProgress(null);
        setUpdateReady(true);
        setUpdateReadyPath(event.data?.file_path ?? null);
      }
      if (event.op === "update.error") {
        setUpdateProgress(null);
        setError(`Erro ao atualizar: ${event.data?.message ?? "Falha no download"}`);
      }
      if (event.op === "hotkey.event") {
        const { code, is_down } = event.data as { code: string; is_down: boolean };
        // The native hook is authoritative and remains global even when a form
        // control has focus. Shortcut capture is the sole key-down exception.
        if (!is_down || !shortcutRecordingRef.current) {
          handleVoiceShortcut(code, is_down);
        }
      }
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

  // Both native and WebView events feed this single pressed flag. It removes
  // duplicated events and native key-repeat without another state machine.
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const deafenedRef = useRef(deafened);
  deafenedRef.current = deafened;
  const shortcutPressedRef = useRef(false);
  const shortcutRecordingRef = useRef(false);

  function readVoiceShortcutConfig(): { mode: VoiceInputMode; key: string } {
    try {
      return {
        mode: (localStorage.getItem("tk.inputMode") as VoiceInputMode) || "voice_activity",
        key: localStorage.getItem("tk.pttKey") || "KeyV",
      };
    } catch {
      return { mode: "voice_activity", key: "KeyV" };
    }
  }

  function configureNativeVoiceShortcut(mode: VoiceInputMode, key: string): void {
    send("hotkey.configure", { enabled: mode !== "voice_activity", code: key });
  }

  function handleVoiceShortcut(code: string, isDown: boolean): void {
    const config = readVoiceShortcutConfig();
    if (!matchesVoiceShortcut(code, config.key)) return;
    if (shortcutPressedRef.current === isDown) return;
    shortcutPressedRef.current = isDown;

    if (config.mode === "push_to_talk") {
      updateAudioState(!isDown, deafenedRef.current, true);
    } else if (config.mode === "toggle" && isDown) {
      updateAudioState(!mutedRef.current, deafenedRef.current);
    }
  }

  function isEditableElementFocused(): boolean {
    if (!document.hasFocus()) return false;
    const element = document.activeElement as HTMLElement | null;
    const tag = element?.tagName.toLowerCase();
    if (tag === "textarea" || element?.isContentEditable) return true;
    if (tag !== "input") return false;

    // Radios and sliders are inputs too, but focusing them (for example when
    // selecting PTT in Settings) must not disable the shortcut being tested.
    return !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
  }

  useEffect(() => {
    const config = readVoiceShortcutConfig();
    configureNativeVoiceShortcut(config.mode, config.key);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (shortcutRecordingRef.current || isEditableElementFocused()) return;
      handleVoiceShortcut(e.code, true);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      handleVoiceShortcut(e.code, false);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

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
  // `atBottomRef` = "the view is glued to the newest message". It starts true
  // and only a *deliberate* upward scroll by the reader detaches it; layout
  // shifts from late-loading media (images, embeds, avatars, fonts) must never
  // detach it, or opening a channel would land mid-history. A short guard
  // window after every programmatic pin makes the `scroll` listener ignore the
  // scroll events our own pinning produces.
  const atBottomRef = useRef(true);
  const pinGuardUntilRef = useRef(0);
  const pinToBottom = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    pinGuardUntilRef.current = performance.now() + 200;
    el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) return;
    const gap = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const onScroll = () => {
      if (performance.now() < pinGuardUntilRef.current) return; // our own pin
      atBottomRef.current = gap() < 120;
    };
    // A real "I want to read history" gesture wins immediately, even while
    // media is still settling (bypasses the pin guard).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) { pinGuardUntilRef.current = 0; atBottomRef.current = false; }
    };
    const onKey = (e: KeyboardEvent) => {
      if (["PageUp", "ArrowUp", "Home"].includes(e.key)) { pinGuardUntilRef.current = 0; atBottomRef.current = false; }
    };
    const onTouch = () => { pinGuardUntilRef.current = 0; atBottomRef.current = gap() < 120; };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("touchmove", onTouch, { passive: true });
    // Re-pin on any content-height change while still glued to the bottom —
    // this is what keeps the newest message in view as images/embeds resolve.
    const inner = el.firstElementChild;
    const observer = inner ? new ResizeObserver(() => { if (atBottomRef.current) pinToBottom(); }) : null;
    if (inner && observer) observer.observe(inner);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("touchmove", onTouch);
      observer?.disconnect();
    };
  }, [activeChannel?.id, activeChannel?.kind]);
  // Opening a text channel / finishing a history load: force to the bottom and
  // keep re-pinning briefly while async media settles into its real height.
  useEffect(() => {
    if (historyLoading) return;
    atBottomRef.current = true;
    pinToBottom();
    const raf = requestAnimationFrame(pinToBottom);
    const timers = [80, 250, 600, 1200].map(ms => window.setTimeout(pinToBottom, ms));
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
  }, [activeChannel?.id, activeChannel?.kind, historyLoading]);
  // New / edited message: follow only if still glued to the bottom.
  useEffect(() => {
    if (atBottomRef.current) pinToBottom();
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
    if (!mySharingStreamId) { setShowSharingToast(false); setShareMenuOpen(false); setShareQualityOpen(false); return; }
    setShowSharingToast(true);
    const timer = setTimeout(() => setShowSharingToast(false), 4000);
    return () => clearTimeout(timer);
  }, [mySharingStreamId]);

  useEffect(() => {
    try { localStorage.setItem("tk.activeDmUsers", JSON.stringify(activeDmConversations)); } catch {}
  }, [activeDmConversations]);

  function openDmWithUser(targetUserId: string, initialMessage?: string) {
    if (!currentUserId || targetUserId === currentUserId) return;
    if (activeChannel?.kind === "text") {
      historyCacheRef.current[activeChannel.id] = messagesRef.current;
    }
    setActiveDmConversations(curr => {
      if (curr.includes(targetUserId)) return curr;
      return [targetUserId, ...curr];
    });
    setActiveDmUserId(targetUserId);
    setNavMode("dm");
    setHistoryLoading(true);
    setMessages([]);
    setActiveChannel(null);
    if (initialMessage && initialMessage.trim()) {
      pendingDmMessageRef.current = { targetUserId, text: initialMessage.trim() };
    }
    send("dm.open", { target_user_id: targetUserId });
  }

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

  // Mention palette: active when typing @ or @query
  const mentionMatch = content.match(/(?:^|\s)@([a-zA-Z0-9_\u00C0-\u017F-]*)$/);
  const [mentionSel, setMentionSel] = useState(0);
  const [mentionDismiss, setMentionDismiss] = useState("");

  const mentionList = useMemo(() => {
    if (!mentionMatch || content === mentionDismiss) return null;
    const q = mentionMatch[1].toLowerCase();
    
    // Filter community members
    const matchedMembers = members.filter(m =>
      m.display_name.toLowerCase().includes(q) ||
      m.username.toLowerCase().includes(q)
    );

    const specials = [
      { id: "everyone", name: "everyone", desc: "Notificar todos neste canal", isSpecial: true as const },
      { id: "here", name: "here", desc: "Notificar membros online neste canal", isSpecial: true as const },
    ].filter(s => s.name.toLowerCase().includes(q));

    const total = matchedMembers.length + specials.length;
    if (total === 0) return null;

    return {
      members: matchedMembers.slice(0, 10),
      specials,
      total: matchedMembers.slice(0, 10).length + specials.length,
    };
  }, [mentionMatch, content, mentionDismiss, members]);

  const mentionOpen = !!mentionList && mentionList.total > 0;
  const mentionIndex = Math.max(0, Math.min(mentionSel, (mentionList?.total ?? 1) - 1));

  useEffect(() => { setMentionSel(0); }, [mentionMatch?.[1]]);

  function applyMention(item: Member | { name: string; isSpecial: true }) {
    const atIndex = content.lastIndexOf("@");
    if (atIndex === -1) return;
    const before = content.slice(0, atIndex);
    const mentionText = "isSpecial" in item ? `@${item.name} ` : `@${item.display_name} `;
    setContent(before + mentionText);
    setMentionSel(0);
    setMentionDismiss("");
    composerRef.current?.focus();
  }

  function onComposerKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (mentionOpen && mentionList) {
      const allItems = [...mentionList.members, ...mentionList.specials];
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionSel(value => (value + 1) % allItems.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionSel(value => (value - 1 + allItems.length) % allItems.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (allItems[mentionIndex]) applyMention(allItems[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismiss(content);
        return;
      }
    }

    if (!slashOpen) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSlashSel(value => (value + 1) % slashMatches.length); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSlashSel(value => (value - 1 + slashMatches.length) % slashMatches.length); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); applySlash(slashMatches[slashIndex]); }
    else if (event.key === "Escape") { event.preventDefault(); setSlashDismiss(content); }
  }

  function uploadFileBlob(file: File) {
    if (!activeChannel) return;
    const isImg = file.type.startsWith("image/");
    const preview = isImg ? URL.createObjectURL(file) : null;
    if (preview && file.name) {
      pendingUploadPreviewsRef.current.set(file.name, preview);
    }
    setUploading(true);
    setUploadingFile({
      name: file.name || "arquivo",
      previewUrl: preview,
      type: file.type || "application/octet-stream"
    });
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      const comma = res.indexOf(",");
      const rawBase64 = comma >= 0 ? res.slice(comma + 1) : res;
      send("attachment.upload_base64", {
        channel_id: activeChannel.id,
        base64: rawBase64,
        filename: file.name || "imagem.png",
        content_type: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  }

  function uploadFiles(files: FileList | File[]) {
    if (!activeChannel || !files || files.length === 0) return;
    const fileArray = Array.from(files);
    fileArray.forEach(file => uploadFileBlob(file));
  }

  function handlePaste(event: React.ClipboardEvent) {
    const items = event.clipboardData?.items;
    const files = event.clipboardData?.files;
    if (!activeChannel) return;
    if (files && files.length > 0) {
      event.preventDefault();
      uploadFiles(files);
      return;
    }
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            uploadFileBlob(file);
            return;
          }
        }
      }
    }
  }

  function handleChatDragEnter(event: React.DragEvent) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      setIsDraggingFiles(true);
    }
  }

  function handleChatDragOver(event: React.DragEvent) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (!isDraggingFiles) setIsDraggingFiles(true);
    }
  }

  function handleChatDragLeave(event: React.DragEvent) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) {
        setIsDraggingFiles(false);
      }
    }
  }

  function handleChatDrop(event: React.DragEvent) {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setIsDraggingFiles(false);
      if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
        uploadFiles(event.dataTransfer.files);
      }
    }
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
    const text = content.trim();
    const optimisticAttachments: Attachment[] = readyAttachments.map(a => ({
      id: a.id,
      filename: a.name,
      content_type: a.type,
      size_bytes: 0,
      url: a.previewUrl ?? null,
    }));
    setMessages(current => [...current, {
      id: reqId,
      reqId,
      content: text,
      created_at: new Date().toISOString(),
      author_id: currentUserId ?? undefined,
      pending: true,
      pendingAttachmentIds: attachmentIds,
      attachments: optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
    }]);
    sendOptimistic(reqId, activeChannel.id, text, attachmentIds);
    setContent("");
    setAttachmentIds([]);
    setReadyAttachments([]);
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
  function pickAttachment() {
    if (!activeChannel) return;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    } else {
      setUploading(true);
      send("attachment.pick", { channel_id: activeChannel.id });
    }
  }
  function joinCall(channel: Channel) {
    const mode = readVoiceShortcutConfig().mode;
    const initialMuted = mode === "push_to_talk";
    shortcutPressedRef.current = false;
    mutedRef.current = initialMuted;
    deafenedRef.current = false;
    setMuted(initialMuted);
    setDeafened(false);
    joinedAtRef.current = Date.now();
    playSound("joinCall");

    // Clear any previous progression timers
    voiceConnTimers.current.forEach(id => window.clearTimeout(id));
    voiceConnTimers.current = [];

    // Discord-like progressive voice connection states
    setVoiceConnState("waiting_server");

    const t1 = window.setTimeout(() => {
      setVoiceConnState("authenticating");
    }, 450);

    const t2 = window.setTimeout(() => {
      setVoiceConnState("connecting");
    }, 900);

    const t3 = window.setTimeout(() => {
      setVoiceConnState("connected");
    }, 1450);

    voiceConnTimers.current = [t1, t2, t3];

    void rtc.joinCall(channel.id, initialMuted, false);
  }
  function leaveCall() {
    if (call) { playSound("leaveCall"); void rtc.leaveCall(); }
    shortcutPressedRef.current = false;
    voiceConnTimers.current.forEach(id => window.clearTimeout(id));
    voiceConnTimers.current = [];
    setVoiceConnState("disconnected");
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
  function updateAudioState(nextMuted: boolean, nextDeafened: boolean, silent: boolean = false) {
    const currentMuted = mutedRef.current;
    const currentDeafened = deafenedRef.current;
    const deafenChanged = nextDeafened !== currentDeafened;
    // Deafen always gates the microphone. Keep the requested mute preference
    // separately so mode/hotkey changes made while deafened are restored later.
    if (nextDeafened) {
      preDeafenMutedRef.current = nextMuted;
      nextMuted = true;
    } else if (currentDeafened) {
      nextMuted = preDeafenMutedRef.current;
    }
    const muteChanged = nextMuted !== currentMuted;
    // A headphone action can also mute/restore the microphone. Play one sound
    // for the action the user actually clicked, rather than both at once.
    if (!silent) {
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
    }
    // Refs are updated synchronously so a second native/WebView event in the
    // same render frame always observes the state that was actually applied.
    mutedRef.current = nextMuted;
    deafenedRef.current = nextDeafened;
    setMuted(nextMuted);
    setDeafened(nextDeafened);
    rtc.setLocalAudioState(nextMuted, nextDeafened);
  }
  function openPicker(sourceOnly: boolean) {
    if (!call) return;
    setPickerSourceOnly(sourceOnly);
    setSources([]);
    setSourcesLoading(true);
    setPickerOpen(true);
    send("screen.sources.list");
  }
  function startSharing() { openPicker(false); }
  function changeShareSource() { closeShareMenu(); openPicker(true); }
  async function shareSource(sourceId: string, options: ShareOptions) {
    setPickerOpen(false);
    if (!call) return;
    // "Change which screen" on a live share: swap the source in place, keeping
    // the same stream so viewers don't have to re-subscribe.
    if (pickerSourceOnly && mySharingStreamId) {
      rtc.switchScreenSource(sourceId);
      return;
    }
    const streamId = crypto.randomUUID();
    try {
      await rtc.publishScreen(call.channelId, streamId, sourceId, options.height, options.fps, options.withAudio);
      setMySharingStreamId(streamId);
      setShareQuality({ height: options.height, fps: options.fps });
      playSound("startScreen");
    } catch (error) {
      console.error("[ui] publishScreen failed", error);
      setError("Não foi possível iniciar o compartilhamento de tela.");
    }
  }
  // Clicking the share button while already sharing: open the menu instead of
  // stopping outright.
  function onShareButton() {
    if (mySharingStreamId) setShareMenuOpen(open => !open);
    else startSharing();
  }
  function closeShareMenu() { setShareMenuOpen(false); setShareQualityOpen(false); }
  function applyShareQuality(next: { height: number; fps: number }) {
    setShareQuality(next);
    rtc.reconfigureScreen(next.height, next.fps);
  }
  function renderSharePopover() {
    if (!shareMenuOpen || !mySharingStreamId) return null;
    return (
      <div className="share-menu" onMouseLeave={closeShareMenu}>
        {shareQualityOpen ? (
          <div className="share-menu__quality">
            <div className="share-menu__title">Qualidade da transmissão</div>
            <QualityControls height={shareQuality.height} fps={shareQuality.fps} onChange={applyShareQuality} />
            <button className="share-menu__done" onClick={() => setShareQualityOpen(false)}>Voltar</button>
          </div>
        ) : (
          <>
            <button onClick={changeShareSource}>
              <Icon name="share-screen" size={16} /> Alterar tela
            </button>
            <button onClick={() => setShareQualityOpen(true)}>
              <Icon name="config" size={16} /> Alterar qualidade
            </button>
            <button className="is-danger" onClick={stopSharing}>
              <Icon name="hangout-call" size={16} /> Parar de compartilhar
            </button>
          </>
        )}
      </div>
    );
  }
  function stopSharing() {
    closeShareMenu();
    if (!call || !mySharingStreamId) return;
    playSound("stopScreen");
    void rtc.unpublishScreen(call.channelId, mySharingStreamId);
    setMySharingStreamId(null);
  }

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
    // Decide from what's ACTUALLY on screen, not just the flag: after the share
    // drops (or a transient blip) the flag can be stuck "true" with no video,
    // and a click should then re-subscribe — not unsubscribe.
    const hasVideo = !!pickRemoteVideo(ownerId, "screen");
    const shouldStop = !!watching[ownerId] && hasVideo;
    if (shouldStop) rtc.stopWatchingStream(call.channelId, streamId, ownerId);
    else rtc.watchStream(call.channelId, streamId, ownerId);
    setWatching(current => ({ ...current, [ownerId]: !shouldStop }));
  }
  function stopWatch(ownerId: string, streamId: string) {
    if (!call) return;
    rtc.stopWatchingStream(call.channelId, streamId, ownerId);
    setWatching(current => ({ ...current, [ownerId]: false }));
  }
  function toggleScreenAudioMute(ownerId: string) {
    setScreenMutedPeers(current => {
      const next = !current[ownerId];
      rtc.setScreenAudioMuted(ownerId, next);
      return { ...current, [ownerId]: next };
    });
  }
  function changeScreenVolume(ownerId: string, volume: number) {
    const clamped = Math.max(0, Math.min(1, volume));
    rtc.setScreenAudioVolume(ownerId, clamped);
    setScreenVolumes(current => ({ ...current, [ownerId]: clamped }));
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
        { label: "Ver Meu Perfil", onClick: () => setSelectedProfileUserId(currentUserId) },
        { label: "Editar Perfil", onClick: () => { setSettingsInitialTab("account"); setSettingsOpen(true); } },
        myStatus === "busy"
          ? { label: "Ficar disponível", onClick: () => setStatus("online") }
          : { label: "Não perturbe (ocupado)", onClick: () => setStatus("busy") },
        { label: "Alterar foto de perfil", onClick: () => send("profile.avatar.pick") },
        {
          kind: "color",
          label: "Cor do meu nome",
          value: currentUser?.name_color ?? null,
          onChange: hex => send("member.set_color", { user_id: currentUserId, name_color: hex }),
        },
      ];
    }
    const member = members.find(entry => entry.id === userId);
    const callmate = call?.participants.find(participant => participant.user_id === userId);
    const items: MenuItem[] = [
      { label: "Ver Perfil", onClick: () => setSelectedProfileUserId(userId) },
    ];
    // In a call together → tune this person's (or the music bot's) volume,
    // just for me. The bot's audio is a normal peer track, so the same
    // rtc.setPeerVolume path works.
    if (callmate) {
      items.push({
        kind: "slider",
        label: callmate.is_bot ? "Volume da música" : "Volume do usuário",
        value: Math.round((peerVolumes[userId] ?? 1) * 100),
        min: 0,
        max: 100,
        step: 1,
        resetTo: 100,
        format: percent => `${percent}%`,
        onChange: percent => changePeerVolume(userId, percent / 100),
      });
    }
    if (member) items.push({ label: "Renomear usuário", onClick: () => renameOtherMember(member) });
    if (member) {
      items.push({
        kind: "color",
        label: "Cor do nome",
        value: member.name_color ?? null,
        onChange: hex => send("member.set_color", { user_id: userId, name_color: hex }),
      });
    }
    // Which voice channel (if any) is the target sitting in right now?
    const voiceChannelId = Object.entries(voiceRooms).find(
      ([, entries]) => entries.some(entry => entry.user_id === userId),
    )?.[0];
    if (voiceChannelId) {
      const isBot = userId === MUSIC_BOT_ID;
      items.push({
        label: isBot ? "Desconectar Tupi Música" : "Desconectar do canal de voz",
        danger: true,
        onClick: () => send("voice.disconnect_member", { user_id: userId, channel_id: voiceChannelId }),
      });
    }
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
    const clamped = Math.max(0, Math.min(1, volume));
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
    | { key: string; kind: "screen"; participant: Participant; stream?: MediaStream };

  function tilesForParticipant(participant: Participant): VoiceTileDesc[] {
    const isSelf = participant.user_id === currentUserId;
    const camera = isSelf
      ? (selfCameraStream ?? undefined)
      : pickRemoteVideo(participant.user_id, "camera");

    const screenRow = streams.find(s => s.owner === participant.user_id && s.kind === "screen");
    const screen = isSelf
      ? (mySharingStreamId ? rtc.getLocalScreenStream() ?? undefined : undefined)
      : (watching[participant.user_id] ? pickRemoteVideo(participant.user_id, "screen") : undefined);

    const tiles: VoiceTileDesc[] = [{ key: `cam:${participant.user_id}`, kind: "cam", participant, stream: camera }];

    if (isSelf) {
      if (mySharingStreamId) {
        tiles.push({ key: `screen:${participant.user_id}`, kind: "screen", participant, stream: screen });
      }
    } else if (screenRow) {
      tiles.push({ key: `screen:${participant.user_id}`, kind: "screen", participant, stream: screen });
    }
    return tiles;
  }

  function renderVoiceTile(desc: VoiceTileDesc) {
    const { participant } = desc;
    const isSelf = participant.user_id === currentUserId;
    const name = isSelf ? selfName : memberName(participant.user_id);
    const isMicMuted = isSelf ? muted : participant.muted;
    const speaking = speakingUsers.has(participant.user_id);
    const screenRow = streams.find(s => s.owner === participant.user_id && s.kind === "screen");

    if (desc.kind === "screen") {
      if (!desc.stream) {
        return (
          <div className={speaking ? "vtile is-speaking" : "vtile"} key={desc.key}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
              <span style={{ color: 'var(--text-muted)' }}><Icon name="share-screen" size={48} /></span>
              {screenRow && (
                <button
                  className="vtile__watch"
                  style={{ position: 'relative', right: 'auto', bottom: 'auto' }}
                  onClick={() => toggleWatch(participant.user_id, screenRow.stream_id)}
                >
                  Assistir transmissão
                </button>
              )}
            </div>
            <div className="vtile__name">
              <span>{name} — tela</span>
            </div>
          </div>
        );
      }

      return (
        <VideoTile
          key={desc.key}
          stream={desc.stream!}
          variant="screen"
          name={`${name} — tela`}
          micMuted={isMicMuted}
          peerMuted={!!mutedPeers[participant.user_id]}
          focused={focusedUser === participant.user_id}
          speaking={speaking}
          onToggleMute={() => togglePeerMute(participant.user_id)}
          onToggleFocus={() => toggleFocus(participant.user_id)}
          isSelf={isSelf}
          onStopWatch={isSelf || !screenRow ? undefined : () => stopWatch(participant.user_id, screenRow.stream_id)}
          screenAudioMuted={!!screenMutedPeers[participant.user_id]}
          screenAudioVolume={screenVolumes[participant.user_id] ?? 1}
          onToggleScreenAudioMute={() => toggleScreenAudioMute(participant.user_id)}
          onScreenAudioVolumeChange={volume => changeScreenVolume(participant.user_id, volume)}
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
      <div
        className={speaking ? "vtile is-speaking" : "vtile"}
        key={desc.key}
        onClick={e => openProfile(participant.user_id, e.currentTarget)}
        style={{ cursor: "pointer" }}
        title={`Ver perfil de ${name}`}
      >
        <Avatar label={name} size={88} className="vtile__avatar" imageUrl={isSelf ? currentUser?.avatar_url : members.find(member => member.id === participant.user_id)?.avatar_url} />
        <div className="vtile__name">
          {isMicMuted && <Icon name="mic-muted" size={14} />}
          <span>{name}</span>
        </div>
      </div>
    );
  }

  return (
    <main className="app" onContextMenu={event => event.preventDefault()}>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {selectedProfileUser && (
        <UserProfileModal
          user={selectedProfileUser}
          presence={presence[selectedProfileUser.id] ?? "offline"}
          isSelf={selectedProfileUser.id === currentUserId}
          activities={activities[selectedProfileUser.id] ?? []}
          anchorRect={profileAnchorRect}
          onClose={() => {
            setSelectedProfileUserId(null);
            setProfileAnchorRect(null);
          }}
          onEditProfile={() => {
            setSelectedProfileUserId(null);
            setProfileAnchorRect(null);
            setSettingsInitialTab("account");
            setSettingsOpen(true);
          }}
          onSendMessage={text => {
            openDmWithUser(selectedProfileUser.id, text);
            setSelectedProfileUserId(null);
            setProfileAnchorRect(null);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          currentUser={currentUser}
          currentBanner={bannerPreset}
          initialTab={settingsInitialTab}
          onBannerChange={bannerId => {
            setBannerPreset(bannerId);
            try { localStorage.setItem("tk.bannerPreset", bannerId); } catch {}
            send("profile.banner.set", { banner_preset: bannerId });
          }}
          onProfileSave={handleProfileSave}
          onClose={() => setSettingsOpen(false)}
          onLogout={() => {
            setSettingsOpen(false);
            send("auth.session.clear");
          }}
          onInputModeChange={mode => {
            shortcutPressedRef.current = false;
            configureNativeVoiceShortcut(mode, readVoiceShortcutConfig().key);
            if (mode === "push_to_talk") {
              updateAudioState(true, deafenedRef.current, true);
            } else if (mode === "voice_activity") {
              updateAudioState(false, deafenedRef.current, true);
            }
          }}
          onShortcutChange={key => {
            configureNativeVoiceShortcut(readVoiceShortcutConfig().mode, key);
          }}
          onShortcutRecordingChange={recording => {
            shortcutRecordingRef.current = recording;
            if (recording) shortcutPressedRef.current = false;
          }}
        />
      )}
      {updateInfo && !updateDismissed && (
        <div className="update-modal-overlay">
          <div className="update-modal-card">
            <button className="update-modal-close" onClick={() => setUpdateDismissed(true)} title="Fechar">✕</button>
            <div className="update-modal-badge">ATUALIZAÇÃO DISPONÍVEL</div>
            <h2 className="update-modal-title">Nova Versão do Tupi</h2>
            <div className="update-modal-version-row">
              <span className="update-modal-ver-pill">Atual: {updateInfo.current_version}</span>
              <span className="update-modal-arrow">➔</span>
              <span className="update-modal-ver-pill is-latest">{updateInfo.latest_version}</span>
            </div>

            {updateInfo.release_notes && (
              <div className="update-modal-notes">
                <div className="update-modal-notes-title">Novidades:</div>
                <div className="update-modal-notes-content">
                  {updateInfo.release_notes}
                </div>
              </div>
            )}

            <div className="update-modal-actions">
              {updateProgress !== null ? (
                <div className="update-modal-progress-wrap">
                  <div className="update-modal-progress-bar" style={{ width: `${Math.max(updateProgress, 5)}%` }} />
                  <span className="update-modal-progress-text">
                    {updateProgress >= 0 ? `Baixando atualização... ${updateProgress}%` : "Baixando atualização..."}
                  </span>
                </div>
              ) : updateReady ? (
                <button
                  className="update-modal-btn is-ready"
                  onClick={() => send("update.apply", { file_path: updateReadyPath })}
                >
                  Reiniciar e Atualizar Agora
                </button>
              ) : (
                <div className="update-modal-btn-group">
                  <button className="update-modal-btn is-dismiss" onClick={() => setUpdateDismissed(true)}>
                    Depois
                  </button>
                  <button
                    className="update-modal-btn is-primary"
                    onClick={() => {
                      setUpdateProgress(0);
                      send("update.download", { download_url: updateInfo.download_url });
                    }}
                  >
                    Baixar e Instalar
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {mySharingStreamId && showSharingToast && (
        <div className="sharing-bar">
          <Icon name="share-screen" size={16} />
          <span>Você está compartilhando sua tela</span>
          <button onClick={stopSharing}>Parar</button>
        </div>
      )}
      {/* ---- left nav: server rail + channel sidebar, sharing one full-width bottom dock ---- */}
      <div className="leftnav">
        <div className="leftnav__cols">
          <nav className="guilds">
            <div
              className={`guilds__pill ${navMode === "dm" ? "is-active" : "is-plain"}`}
              onClick={() => {
                setNavMode("dm");
                if (activeDmUserId) {
                  openDmWithUser(activeDmUserId);
                } else {
                  if (activeChannel?.kind === "text") {
                    historyCacheRef.current[activeChannel.id] = messagesRef.current;
                  }
                  setActiveChannel(null);
                  setMessages([]);
                }
              }}
              title="Mensagens Diretas"
            >
              <Icon name="discord-icon" size={26} />
            </div>
            <div className="guilds__sep" />
            <div
              className={`guilds__pill ${navMode === "guild" ? "is-active" : "is-plain"}`}
              onClick={() => {
                setNavMode("guild");
                if (textChannels.length > 0 && (!activeChannel || activeChannel.topic?.startsWith("dm:"))) {
                  chooseChannel(textChannels[0]);
                }
              }}
              title={communityName}
              style={{ overflow: "hidden", padding: 0 }}
            >
              <img src={logoUrl} alt={communityName} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            <div className="guilds__pill is-plain guilds__add" title="Adicionar um servidor">+</div>
          </nav>

          {/* ---- channel sidebar or DM sidebar ---- */}
          {navMode === "dm" ? (
            <aside className="channels">
              <div className="dm-search-bar">
                <button type="button" className="dm-search-btn" onClick={() => setNewDmModalOpen(true)}>
                  <span>Encontre ou comece uma conversa</span>
                </button>
              </div>

              <div className="dm-nav-links">
                <button type="button" className="dm-nav-link is-active">
                  <Icon name="friends" size={20} />
                  <span>Amigos</span>
                </button>
              </div>

              <div className="dm-section-header">
                <span>MENSAGENS DIRETAS</span>
                <button type="button" className="dm-add-btn" onClick={() => setNewDmModalOpen(true)} title="Criar DM">+</button>
              </div>

              <div className="dm-conversations-list scroll-thin">
                {activeDmConversations.map(userId => {
                  const member = members.find(m => m.id === userId);
                  if (!member) return null;
                  const isCurrentDm = activeDmUserId === userId;
                  const userPresence = presence[userId] ?? "offline";
                  return (
                    <div
                      key={userId}
                      className={`dm-conv-item ${isCurrentDm ? "is-active" : ""}`}
                      onClick={() => openDmWithUser(userId)}
                    >
                      <div className="dm-conv-avatar-wrap">
                        <Avatar label={member.display_name} size={32} imageUrl={member.avatar_url} />
                        <span className={`presence-dot presence-dot--${userPresence}`} />
                      </div>
                      <div className="dm-conv-info">
                        <span className="dm-conv-name" style={member.name_color ? { color: member.name_color } : undefined}>
                          {member.display_name}
                        </span>
                        <span className="dm-conv-sub">
                          {activities[userId]?.[0]?.name ? `Jogando ${activities[userId][0].name}` : `@${member.username}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="dm-conv-close"
                        onClick={e => {
                          e.stopPropagation();
                          setActiveDmConversations(curr => curr.filter(id => id !== userId));
                          if (activeDmUserId === userId) setActiveDmUserId(null);
                        }}
                        title="Fechar DM"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {activeDmConversations.length === 0 && (
                  <div style={{ padding: "16px 12px", fontSize: "13px", color: "var(--text-muted, #949ba4)", textAlign: "center" }}>
                    Nenhuma conversa recente. Clique no + acima para iniciar uma DM!
                  </div>
                )}
              </div>
            </aside>
          ) : (
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
              // The whole channel block (name + occupant list) is the drop
              // zone for "move member" — dropping onto just the thin name
              // button used to miss whenever the channel had occupants shown.
              <div
                key={channel.id}
                className={canMoveMembers && dragOverVoice === channel.id ? "voice-chan is-voice-drop" : "voice-chan"}
                onDragOver={canMoveMembers ? (event => {
                  if (!event.dataTransfer.types.includes("application/x-tk-member")) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dragOverVoice !== channel.id) setDragOverVoice(channel.id);
                }) : undefined}
                onDragLeave={canMoveMembers ? (event => {
                  // Ignore leave events fired while crossing onto a child row.
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setDragOverVoice(current => current === channel.id ? null : current);
                }) : undefined}
                onDrop={canMoveMembers ? (event => {
                  event.preventDefault();
                  setDragOverVoice(null);
                  const userId = event.dataTransfer.getData("application/x-tk-member");
                  const from = event.dataTransfer.getData("application/x-tk-member-src");
                  if (userId && from !== channel.id) send("voice.move_member", { user_id: userId, channel_id: channel.id });
                }) : undefined}
              >
                <button
                  className={
                    "chan" +
                    (activeChannel?.id === channel.id && activeChannel?.kind === "voice" ? " is-active" : "") +
                    (here ? " is-connected" : "") +
                    (dragOverVoice === channel.id ? " is-drop-target" : "")
                  }
                  onClick={() => chooseVoiceChannel(channel)}
                  onContextMenu={event => openMenu(event, channelMenuItems(channel))}
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
                            + ((botPlaying || speakingUsers.has(entry.user_id)) ? " is-speaking" : "")
                            + (canMoveMembers ? " is-draggable" : "")
                          }
                          key={entry.user_id}
                          ref={node => { if (node) voiceRowRefs.current[entry.user_id] = node; }}
                          draggable={canMoveMembers || undefined}
                          onDragStart={canMoveMembers ? (event => {
                            event.dataTransfer.setData("application/x-tk-member", entry.user_id);
                            event.dataTransfer.setData("application/x-tk-member-src", channel.id);
                            event.dataTransfer.effectAllowed = "move";
                          }) : undefined}
                          onDragEnd={canMoveMembers ? (() => setDragOverVoice(null)) : undefined}
                          onMouseEnter={() => canPeek && peekEnter(channel.id, entry.user_id, share!.stream_id, here)}
                          onMouseLeave={() => canPeek && peekLeave(entry.user_id)}
                          onClick={event => openProfile(entry.user_id, event.currentTarget)}
                          onContextMenu={event => openMenu(event, memberMenuItems(entry.user_id))}
                        >
                          <Avatar label={name} size={24} className="voice-member__av" imageUrl={isBot ? "/tupi-mascot.png" : members.find(member => member.id === entry.user_id)?.avatar_url} />
                          <span
                            className="voice-member__name"
                            style={(() => {
                              const color = members.find(member => member.id === entry.user_id)?.name_color;
                              return color ? { color } : undefined;
                            })()}
                          >{name}</span>
                          {micMuted && <Icon name="mic-muted" size={15} className="voice-member__flag" />}
                          {audioOff && <Icon name="headphone-muted" size={15} className="voice-member__flag" />}
                          {hasCamera && <Icon name="camera" size={15} className="voice-member__flag voice-member__flag--cam" title="Câmera ligada" />}
                          {isLive && <span className="voice-member__live-badge">AO VIVO</span>}
                          {botPlaying && (
                            <span className="voice-member__live-badge voice-member__live-badge--bot" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <MusicNoteIcon size={11} />
                              <span>TOCANDO</span>
                            </span>
                          )}
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
      )}
    </div>

    <div className="leftnav__dock">
        {/* ---- RTC connected panel with progressive statuses ---- */}
        {call && (
          <div className="voice-panel">
            <div className="voice-panel__row">
              {voiceConnState === "connected" ? (
                <SignalBars quality={connQuality} />
              ) : (
                <AudioWaveform color="var(--yellow)" />
              )}
              <div className="voice-panel__info">
                <div className={`voice-panel__state ${voiceConnState === "connected" ? "is-connected" : "is-connecting"}`}>
                  {voiceConnState === "waiting_server"
                    ? "Aguardando o servidor de voz"
                    : voiceConnState === "authenticating"
                    ? "Autenticando"
                    : voiceConnState === "connecting"
                    ? "Conexão RTC"
                    : "Voz conectada"}
                </div>
                <div className="voice-panel__chan">
                  *{(channels.find(c => c.id === call.channelId)?.name ?? "canal")}* / {communityName}
                </div>
              </div>
              <button className="voice-panel__hangup" onClick={leaveCall} title="Desconectar">
                <Icon name="hangout-call" size={18} />
              </button>
            </div>
            <div className="voice-panel__grid">
              <button
                className={myCameraStreamId ? "vp-btn is-on" : "vp-btn"}
                onClick={toggleCamera}
                title={myCameraStreamId ? "Desligar câmera" : "Ligar câmera"}
              >
                <Icon name={myCameraStreamId ? "camera" : "camera-closed"} size={18} />
              </button>
              <div className="vp-share">
                <button
                  className={mySharingStreamId ? "vp-btn is-danger is-on" : "vp-btn"}
                  onClick={onShareButton}
                  title={mySharingStreamId ? "Opções de transmissão" : "Compartilhar tela"}
                >
                  <Icon name="share-screen" size={18} />
                </button>
                {renderSharePopover()}
              </div>
              <button
                className={noiseSup ? "vp-btn is-on" : "vp-btn"}
                onClick={toggleNoiseSuppression}
                title={noiseSup ? "Supressão de ruído: ligada" : "Supressão de ruído: desligada"}
              >
                <Icon name={noiseSup ? "crisp-nois-cenaceling-on" : "crisp-off"} size={18} />
              </button>
              <button className="vp-btn" title="Efeitos sonoros"><Icon name="sound-effects" size={18} /></button>
            </div>
          </div>
        )}

        {/* ---- user bar with customizable banner ---- */}
        <div
          className="userbar"
          style={{
            background: getBannerPreset(bannerPreset).cssBackground,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="userbar__backdrop-overlay" />
          <div
            className="userbar__id"
            onContextMenu={event => openMenu(event, [
              { label: "Ver Meu Perfil", onClick: () => currentUserId && openProfile(currentUserId) },
              ...memberMenuItems(currentUserId ?? ""),
              { label: "Personalizar Banner de Perfil", onClick: () => { setSettingsInitialTab("account"); setSettingsOpen(true); } },
            ])}
            onClick={e => currentUserId && openProfile(currentUserId, e.currentTarget)}
            title="Clique para ver seu perfil / personalizar"
          >
            <Avatar
              label={selfName}
              size={36}
              className={myStatus === "busy" ? "userbar__avatar is-busy" : "userbar__avatar"}
              imageUrl={currentUser?.avatar_url}
            />
            <div className="userbar__meta">
              <div className="userbar__name">{selfName}</div>
              <div className="userbar__sub">
                {currentUserId && activities[currentUserId]?.[0] ? (
                  <span style={{ color: "#23a55a", display: "flex", alignItems: "center", gap: "4px" }}>
                    <MusicNoteIcon size={12} />
                    <span>{activities[currentUserId][0].name}</span>
                  </span>
                ) : myStatus === "busy" ? (
                  "Ocupado"
                ) : (
                  currentUser?.username ? `@${currentUser.username}` : "online"
                )}
              </div>
            </div>
          </div>
          <div className="userbar__btns">
            <button className={muted ? "userbar__btn is-on" : "userbar__btn"} onClick={() => updateAudioState(!muted, deafened)} title={muted ? "Ativar microfone" : "Desativar microfone"}>
              <Icon name={muted ? "mic-muted" : "mic-open"} size={20} />
            </button>
            <button className={deafened ? "userbar__btn is-on" : "userbar__btn"} onClick={() => updateAudioState(muted, !deafened)} title={deafened ? "Ativar áudio" : "Desativar áudio"}>
              <Icon name={deafened ? "headphone-muted" : "headphone"} size={20} />
            </button>
            <button className="userbar__btn" onClick={() => setSettingsOpen(true)} title="Configurações de Usuário">
              <Icon name="config" size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>

      {/* ---- main column ---- */}
      <div className="workspace">
        <header className="topbar">
          {navMode === "dm" && activeDmUserId ? (
            (() => {
              const dmMember = members.find(m => m.id === activeDmUserId);
              const dmPresence = presence[activeDmUserId] ?? "offline";
              return (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "20px", fontWeight: "700", color: "var(--text-muted, #949ba4)" }}>@</span>
                    <span className="topbar__title" style={dmMember?.name_color ? { color: dmMember.name_color } : undefined}>
                      {dmMember?.display_name || "Membro"}
                    </span>
                    <span className={`presence-dot presence-dot--${dmPresence}`} style={{ width: "10px", height: "10px", margin: "0 4px" }} />
                  </div>
                  <span className="topbar__divider" />
                  <span className="topbar__topic">
                    {activities[activeDmUserId]?.[0]?.name ? `Jogando ${activities[activeDmUserId][0].name}` : `@${dmMember?.username || "membro"}`}
                  </span>
                </>
              );
            })()
          ) : activeChannel ? (
            <>
              {activeChannel.kind === "voice"
                ? <Icon name="voice-chat" size={24} className="topbar__icon" />
                : <HashIcon size={24} className="topbar__icon" />}
              <span className="topbar__title">{activeChannel.name}</span>
              {activeChannel.topic && !activeChannel.topic.startsWith("dm:") && (
                <>
                  <span className="topbar__divider" />
                  <span className="topbar__topic">{activeChannel.topic}</span>
                </>
              )}
            </>
          ) : (
            <span className="topbar__title">Selecione uma conversa ou canal</span>
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
              <div className="vc-share">
                <button
                  className={mySharingStreamId ? "vc-btn is-on" : "vc-btn"}
                  onClick={onShareButton}
                  title={mySharingStreamId ? "Opções de transmissão" : "Compartilhar tela"}
                >
                  <Icon name="share-screen" size={22} />
                </button>
                {renderSharePopover()}
              </div>
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
          <div
            className="chat"
            onDragEnter={handleChatDragEnter}
            onDragOver={handleChatDragOver}
            onDragLeave={handleChatDragLeave}
            onDrop={handleChatDrop}
          >
            {isDraggingFiles && activeChannel && (
              <div className="chat-drop-overlay" onDragOver={handleChatDragOver} onDragLeave={handleChatDragLeave} onDrop={handleChatDrop}>
                <div className="chat-drop-overlay__card">
                  <div className="chat-drop-overlay__icon-glow">
                    <Icon name="add-media" size={36} />
                  </div>
                  <h3 className="chat-drop-overlay__title">Solte para enviar arquivo</h3>
                  <p className="chat-drop-overlay__desc">Enviar para #{activeChannel.name}</p>
                </div>
              </div>
            )}
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
                const isMusicBot = authorId === MUSIC_BOT_ID;
                const displayName = message.author?.display_name ?? (isMusicBot ? "Tupi Música" : memberName(authorId));
                const authorTag = message.author?.profile_tag ?? (isMusicBot ? "BOT" : null);
                const isOwn = authorId != null && authorId === currentUserId;
                const authorMember = members.find(m => m.id === authorId);
                const isOwner = authorMember?.role === "owner";
                const nameColor = isMusicBot ? "#5865f2"
                  : authorMember?.name_color
                  || (isOwner ? "#f0b232" : `hsl(${hueFromString(displayName)} 62% 72%)`);
                const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const mentionsMe = isUserMentioned(message.content, currentUserId, currentUser);
                return (
                  <article
                    key={message.id}
                    className={
                      "msg msg--compact" +
                      (groupStart ? " is-group-start" : "") +
                      (mentionsMe ? " is-mentioned" : "") +
                      (message.failed ? " is-failed" : message.pending ? " is-pending" : "")
                    }
                  >
                    <span className="msg__ts">{time}</span>
                    <div className="msg__content">
                      <span
                        className="msg__author"
                        style={{ color: nameColor, cursor: "pointer" }}
                        onClick={e => authorId && openProfile(authorId, e.currentTarget)}
                        title={`Ver perfil de ${displayName}`}
                      >
                        {displayName}
                        {authorTag && (
                          <small className="msg__tag">
                            {message.author?.profile_badge_url && <img src={message.author.profile_badge_url} alt="" />}
                            {authorTag}
                          </small>
                        )}
                      </span>
                      {message.music_status && <MusicStatusCard status={message.music_status} members={members} />}
                      {message.content && message.content.trim() !== "[anexo]" && (
                        <span className="msg__body">
                          {renderText(message.content, currentUserId, currentUser, members)}
                          {message.pending && <span className="msg__status">enviando…</span>}
                          {message.failed && (
                            <span className="msg__status">
                              falhou
                              <button onClick={() => retryMessage(message)}>tentar de novo</button>
                              <button onClick={() => cancelMessage(message)}>cancelar</button>
                            </span>
                          )}
                        </span>
                      )}
                      {(!message.content || message.content.trim() === "[anexo]") && (message.pending || message.failed) && (
                        <span className="msg__body">
                          {message.pending && <span className="msg__status">enviando…</span>}
                          {message.failed && (
                            <span className="msg__status">
                              falhou
                              <button onClick={() => retryMessage(message)}>tentar de novo</button>
                              <button onClick={() => cancelMessage(message)}>cancelar</button>
                            </span>
                          )}
                        </span>
                      )}
                      {message.attachments?.map(attachment => {
                        const isImage = (attachment.content_type ?? "").startsWith("image/");
                        const isVideo = (attachment.content_type ?? "").startsWith("video/");
                        const hasValidUrl = !!attachment.url && (attachment.url.startsWith("data:") || attachment.url.startsWith("blob:") || attachment.url.startsWith("http"));
                        if (isImage && hasValidUrl) {
                          return (
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
                                onLoad={() => { if (atBottomRef.current) pinToBottom(); }}
                              />
                            </button>
                          );
                        }
                        if (isVideo && hasValidUrl) {
                          return (
                            <div className="msg__video-wrap" key={attachment.id}>
                              <video
                                src={attachment.url ?? ""}
                                controls
                                preload="metadata"
                                className="msg__video"
                                onLoadedData={() => { if (atBottomRef.current) pinToBottom(); }}
                              />
                            </div>
                          );
                        }
                        return (
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
                      {message.link_preview && <LinkPreviewCard preview={message.link_preview} />}
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
              <form className={"composer" + (isDraggingFiles ? " is-drag-over" : "")} onSubmit={submitMessage} onPaste={handlePaste}>
                <input
                  type="file"
                  ref={fileInputRef}
                  multiple
                  onChange={e => {
                    const files = e.target.files;
                    if (files && files.length > 0) uploadFiles(files);
                  }}
                  style={{ display: "none" }}
                />
                {mentionOpen && mentionList && (
                  <div className="mention-menu">
                    <div className="mention-menu__head">MEMBROS</div>
                    {mentionList.members.map((member, index) => {
                      const isActive = index === mentionIndex;
                      return (
                        <button
                          type="button"
                          key={member.id}
                          className={isActive ? "mention-menu__item is-active" : "mention-menu__item"}
                          onMouseEnter={() => setMentionSel(index)}
                          onMouseDown={event => { event.preventDefault(); applyMention(member); }}
                        >
                          <Avatar
                            label={member.display_name}
                            size={24}
                            className="mention-menu__av"
                            imageUrl={member.avatar_url}
                          />
                          <span
                            className="mention-menu__name"
                            style={member.name_color ? { color: member.name_color } : undefined}
                          >
                            {member.display_name}
                          </span>
                          <span className="mention-menu__user">@{member.username}</span>
                        </button>
                      );
                    })}
                    {mentionList.specials.length > 0 && (
                      <>
                        <div className="mention-menu__head" style={{ marginTop: "6px" }}>ESPECIAIS</div>
                        {mentionList.specials.map((spec, specIdx) => {
                          const overallIdx = mentionList.members.length + specIdx;
                          const isActive = overallIdx === mentionIndex;
                          return (
                            <button
                              type="button"
                              key={spec.id}
                              className={isActive ? "mention-menu__item is-active" : "mention-menu__item"}
                              onMouseEnter={() => setMentionSel(overallIdx)}
                              onMouseDown={event => { event.preventDefault(); applyMention(spec); }}
                            >
                              <span className="mention-menu__special-tag">@{spec.name}</span>
                              <span className="mention-menu__special-desc">{spec.desc}</span>
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
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
                {uploading && (
                  <div className="composer__uploading-bar">
                    <div className="composer__uploading-spinner" />
                    {uploadingFile?.previewUrl && (
                      <img src={uploadingFile.previewUrl} alt="" className="composer__uploading-thumb" />
                    )}
                    <div className="composer__uploading-info">
                      <span className="composer__uploading-title">
                        Enviando {uploadingFile?.type.startsWith("video/") ? "vídeo" : uploadingFile?.type.startsWith("image/") ? "imagem" : "arquivo"}...
                      </span>
                      <span className="composer__uploading-name">{uploadingFile?.name}</span>
                    </div>
                  </div>
                )}
                {readyAttachments.length > 0 && !uploading && (
                  <div className="composer__ready-attachments">
                    {readyAttachments.map(att => (
                      <div key={att.id} className="composer__ready-pill">
                        {att.previewUrl ? (
                          <img src={att.previewUrl} alt="" className="composer__ready-thumb" />
                        ) : (
                          <Icon name="add-media" size={14} />
                        )}
                        <span className="composer__ready-name">{att.name}</span>
                        <button
                          type="button"
                          className="composer__ready-remove"
                          onClick={() => {
                            setAttachmentIds(ids => ids.filter(id => id !== att.id));
                            setReadyAttachments(atts => atts.filter(a => a.id !== att.id));
                          }}
                          title="Remover anexo"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="composer__box">
                  <button type="button" className="composer__add" disabled={uploading} onClick={pickAttachment} title="Anexar arquivo">
                    <Icon name="add-media" size={16} />
                  </button>
                  <input
                    ref={composerRef}
                    value={content}
                    onChange={event => setContent(event.target.value)}
                    onKeyDown={onComposerKeyDown}
                    onPaste={handlePaste}
                    placeholder={
                      navMode === "dm" && activeDmUserId
                        ? `Conversar em @${members.find(m => m.id === activeDmUserId)?.display_name || "membro"}`
                        : `Conversar em #${activeChannel.name}`
                    }
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

        {/* ---- member list or DM Profile Panel ---- */}
        {showMembers && !(inThisVoice && theater) && (
          navMode === "dm" && activeDmUserId ? (
            (() => {
              const targetMember = members.find(m => m.id === activeDmUserId);
              const targetPresence = presence[activeDmUserId] ?? "offline";
              const banner = getBannerPreset(targetMember?.banner_preset);
              return (
                <aside className="dm-profile-sidebar">
                  <div className="dm-profile-card">
                    <div className="dm-profile-banner" style={{ background: banner.cssBackground }} />
                    <div className="dm-profile-avatar-wrap">
                      <Avatar label={targetMember?.display_name || ""} size={80} imageUrl={targetMember?.avatar_url} />
                      <span className={`presence-dot presence-dot--lg presence-dot--${targetPresence}`} />
                    </div>
                    <div className="dm-profile-body">
                      <h3 className="dm-profile-name" style={targetMember?.name_color ? { color: targetMember.name_color } : undefined}>
                        {targetMember?.display_name}
                      </h3>
                      <div className="dm-profile-handle">@{targetMember?.username}</div>
                      {targetMember?.pronouns && (
                        <div className="dm-profile-pronouns">{targetMember.pronouns}</div>
                      )}

                      <div className="dm-profile-divider" />

                      {targetMember?.bio && (
                        <div className="dm-profile-section">
                          <div className="dm-profile-section-title">SOBRE MIM</div>
                          <div className="dm-profile-bio">{targetMember.bio}</div>
                        </div>
                      )}

                      <div className="dm-profile-section">
                        <div className="dm-profile-section-title">MEMBRO DESDE</div>
                        <div className="dm-profile-date">
                          {targetMember?.created_at
                            ? new Date(targetMember.created_at).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" })
                            : "28 de ago. de 2026"}
                        </div>
                      </div>

                      <button
                        type="button"
                        className="dm-profile-full-btn"
                        onClick={e => openProfile(activeDmUserId, e.currentTarget)}
                      >
                        Ver Perfil Completo
                      </button>
                    </div>
                  </div>
                </aside>
              );
            })()
          ) : (
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
                currentUserId={currentUserId}
                bannerPreset={bannerPreset}
                botNowPlaying={(() => {
                  const musicStream = streams.find(stream => stream.kind === "music")
                    ?? Object.values(voiceRoomStreams).flat().find(stream => stream.kind === "music");
                  return musicStream ? (musicStream.label ?? "tocando") : null;
                })()}
                onMemberClick={(member, e) => openProfile(member.id, e.currentTarget)}
                onMemberContextMenu={(event, member) => openMenu(event, memberMenuItems(member.id))}
              />
            </aside>
          )
        )}
        </div>
      </div>

      {newDmModalOpen && (
        <div className="new-dm-overlay" onClick={() => setNewDmModalOpen(false)}>
          <div className="new-dm-card" onClick={e => e.stopPropagation()}>
            <div className="new-dm-head">
              <h3>Nova Mensagem Direta</h3>
              <button type="button" className="new-dm-close" onClick={() => setNewDmModalOpen(false)}>✕</button>
            </div>
            <div className="new-dm-search-wrap">
              <input
                autoFocus
                placeholder="Digite o nome de usuário ou exibição"
                value={newDmSearch}
                onChange={e => setNewDmSearch(e.target.value)}
              />
            </div>
            <div className="new-dm-list scroll-thin">
              {members
                .filter(m => m.id !== currentUserId && (
                  m.display_name.toLowerCase().includes(newDmSearch.toLowerCase()) ||
                  m.username.toLowerCase().includes(newDmSearch.toLowerCase())
                ))
                .map(m => (
                  <button
                    key={m.id}
                    type="button"
                    className="new-dm-item"
                    onClick={() => {
                      openDmWithUser(m.id);
                      setNewDmModalOpen(false);
                      setNewDmSearch("");
                    }}
                  >
                    <Avatar label={m.display_name} size={36} imageUrl={m.avatar_url} />
                    <div className="new-dm-item-info">
                      <span className="new-dm-item-name" style={m.name_color ? { color: m.name_color } : undefined}>{m.display_name}</span>
                      <span className="new-dm-item-user">@{m.username}</span>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <ScreenPicker
          sources={sources}
          loading={sourcesLoading}
          channelName={channels.find(c => c.id === call?.channelId)?.name ?? "Canal de voz"}
          onPick={shareSource}
          onCancel={() => setPickerOpen(false)}
          sourceOnly={pickerSourceOnly}
          defaultOptions={{ withAudio: true, height: shareQuality.height, fps: shareQuality.fps }}
        />
      )}
    </main>
  );
}

function MemberList({
  members,
  presence,
  botNowPlaying,
  onMemberClick,
  onMemberContextMenu,
  currentUserId,
  bannerPreset,
}: {
  members: Member[];
  presence: Record<string, "online" | "busy" | "offline">;
  // Non-null when Tupi Música is currently playing (the track label); the bot
  // row itself is always shown — it's a permanent fixture like a Discord bot.
  botNowPlaying: string | null;
  onMemberClick?: (member: Member, e: ReactMouseEvent<HTMLElement>) => void;
  onMemberContextMenu: (event: ReactMouseEvent, member: Member) => void;
  currentUserId: string | null;
  bannerPreset: string;
}) {
  const online = members.filter(member => presence[member.id] === "online" || presence[member.id] === "busy");
  const offline = members.filter(member => !presence[member.id] || presence[member.id] === "offline");
  const row = (member: Member, isOffline: boolean) => {
    const memberBannerId = member.id === currentUserId ? bannerPreset : (member.banner_preset ?? null);
    const banner = memberBannerId ? getBannerPreset(memberBannerId) : null;
    return (
      <div
        key={member.id}
        className={
          "member" +
          (isOffline ? " is-offline" : "") +
          (presence[member.id] === "busy" ? " is-busy" : "") +
          (member.role === "owner" ? " is-owner" : "") +
          (banner ? " has-banner" : "")
        }
        style={banner ? ({ "--banner-accent": banner.accentColor } as React.CSSProperties) : undefined}
        onClick={e => onMemberClick?.(member, e)}
        onContextMenu={event => onMemberContextMenu(event, member)}
        title={`Ver perfil de ${member.display_name}`}
      >
        {banner && (
          <div
            className="member__banner-bg"
            style={{ background: banner.previewGradient }}
          />
        )}
        <Avatar label={member.display_name} size={32} className="member__avatar" imageUrl={member.avatar_url} />
        <span className="member__name" style={member.name_color ? { color: member.name_color } : undefined}>
          {member.display_name}
          {member.profile_tag && <small className="member__tag">{member.profile_badge_url && <img src={member.profile_badge_url} alt="" />}{member.profile_tag}</small>}
        </span>
        {member.role === "owner" && <CrownIcon className="member__crown" />}
      </div>
    );
  };
  return (
    <>
      <div className="members__group">Online — {online.length + 1}</div>
      <div
        className="member member--bot"
        onClick={e => onMemberClick?.({
          id: MUSIC_BOT_ID,
          display_name: "Tupi Música",
          username: "tupi-musica",
          role: "bot",
          profile_tag: "BOT",
          name_color: "#5865f2",
          banner_preset: "synthwave",
          bio: "Bot de música oficial do Tupi. Toque qualquer música ou rádio usando os controles de voz.",
          pronouns: "ele/bot",
        }, e)}
        style={{ cursor: "pointer" }}
        title="Ver perfil de Tupi Música"
      >
        <Avatar label="Tupi Música" size={32} className="member__avatar" imageUrl="/tupi-mascot.png" />
        <div className="member__lines">
          <span className="member__name">Tupi Música<small className="member__tag">BOT</small></span>
          {botNowPlaying && (
            <span className="member__status">
              <Icon name="sound-effects" size={13} className="member__status-icon" />
              {botNowPlaying}
            </span>
          )}
        </div>
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
