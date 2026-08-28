import React, { useState, useMemo } from "react";
import { Icon } from "./Icon";
import { CrownIcon, DotsIcon, LightningIcon } from "./Glyphs";
import { getBannerPreset } from "./banners";

export interface UserProfileData {
  id: string;
  display_name: string;
  username: string;
  role?: string;
  avatar_url?: string | null;
  profile_tag?: string | null;
  profile_badge_url?: string | null;
  name_color?: string | null;
  bio?: string | null;
  banner_preset?: string | null;
  pronouns?: string | null;
  created_at?: string | null;
}

export interface ActivityDto {
  name: string;
  kind?: string | null;
  details?: string | null;
  state?: string | null;
  large_image?: string | null;
  small_image?: string | null;
  started_at?: string | number | null;
}

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface UserProfileModalProps {
  user: UserProfileData;
  presence?: "online" | "busy" | "offline";
  isSelf?: boolean;
  activities?: ActivityDto[];
  anchorRect?: AnchorRect | null;
  onClose: () => void;
  onEditProfile?: () => void;
  onSendMessage?: (text: string) => void;
}

export function UserProfileModal({
  user,
  presence = "online",
  isSelf = false,
  activities = [],
  anchorRect,
  onClose,
  onEditProfile,
  onSendMessage,
}: UserProfileModalProps) {
  const [quickMsg, setQuickMsg] = useState("");
  const banner = getBannerPreset(user.banner_preset);

  const formattedDate = (() => {
    if (!user.created_at) return "28 de ago. de 2026";
    try {
      const d = new Date(user.created_at);
      return d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "28 de ago. de 2026";
    }
  })();

  const isBot = user.profile_tag === "BOT" || user.username === "tupi-musica";

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickMsg.trim()) return;
    onSendMessage?.(quickMsg.trim());
    setQuickMsg("");
    onClose();
  };

  // Discord-style anchored floating position (e.g. to the left of the member list row)
  const popoutStyle = useMemo<React.CSSProperties>(() => {
    if (!anchorRect) {
      return {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        position: "fixed",
      };
    }

    const cardWidth = 330;
    const cardEstHeight = 520;
    const windowWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
    const windowHeight = typeof window !== "undefined" ? window.innerHeight : 800;

    let left = 0;
    let top = 0;

    // Anchor is on the right side (MemberList) -> place popout to the left of the anchor
    if (anchorRect.left > windowWidth / 2) {
      left = anchorRect.left - cardWidth - 12;
      top = anchorRect.top - 16;
    } else if (anchorRect.bottom > windowHeight - 120) {
      // Bottom dock (userbar) -> place popout above
      left = Math.max(16, anchorRect.left);
      top = anchorRect.top - cardEstHeight + 30;
    } else {
      // Left/middle side (chat author) -> place popout to the right
      left = anchorRect.right + 12;
      top = anchorRect.top - 8;
    }

    // Keep clamped inside viewport boundaries
    if (left < 16) left = 16;
    if (left + cardWidth > windowWidth - 16) left = windowWidth - cardWidth - 16;
    if (top < 16) top = 16;
    if (top + cardEstHeight > windowHeight - 16) top = Math.max(16, windowHeight - cardEstHeight - 16);

    return {
      top: `${top}px`,
      left: `${left}px`,
      position: "fixed",
    };
  }, [anchorRect]);

  return (
    <div className="user-profile-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="user-profile-card" style={popoutStyle}>
        {/* Banner Section */}
        <div
          className="user-profile-banner"
          style={{
            background: banner.cssBackground,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="user-profile-banner__overlay" />

          {/* Action buttons on banner top-right */}
          <div className="user-profile-banner__actions">
            {isSelf ? (
              <button
                className="user-profile-btn user-profile-btn--edit"
                onClick={() => {
                  onClose();
                  onEditProfile?.();
                }}
                title="Editar meu perfil"
              >
                <Icon name="config" size={14} />
                <span>Editar Perfil</span>
              </button>
            ) : (
              <button className="user-profile-icon-btn" title="Mais opções">
                <DotsIcon size={16} />
              </button>
            )}
          </div>
        </div>

        {/* Avatar & Presence Header */}
        <div className="user-profile-header">
          <div className="user-profile-avatar-wrapper">
            <div className="user-profile-avatar">
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="" />
              ) : (
                <span className="user-profile-avatar__initials">
                  {(user.display_name || "?").substring(0, 2).toUpperCase()}
                </span>
              )}
            </div>
            <div className={`user-profile-status-badge is-${presence}`} title={`Status: ${presence}`}>
              {presence === "busy" && <span className="dnd-dash" />}
            </div>
          </div>
        </div>

        {/* Main Details Body */}
        <div className="user-profile-body">
          {/* Names & Badges */}
          <div className="user-profile-names">
            <div className="user-profile-display-name-row">
              <h3
                className="user-profile-display-name"
                style={user.name_color ? { color: user.name_color } : undefined}
              >
                {user.display_name}
              </h3>
              {user.role === "owner" && <CrownIcon className="user-profile-crown" />}
              {isBot && <span className="profile-tag profile-tag--bot">APP</span>}
              {user.profile_tag && !isBot && (
                <span className="profile-tag">{user.profile_tag}</span>
              )}
            </div>

            <div className="user-profile-username-row">
              <span className="user-profile-username">
                {user.username ? (user.username.includes("#") ? user.username : `@${user.username}`) : "@membro"}
              </span>
              {user.pronouns && (
                <span className="user-profile-pronouns" title="Pronomes">{`{ ${user.pronouns} }`}</span>
              )}
            </div>

            {/* Badges / Mutuals Row */}
            <div className="user-profile-mutuals">
              <LightningIcon size={14} className="mutual-icon" />
              <span>1 servidor mútuo</span>
            </div>
          </div>

          {/* Action Button: Edit Profile (Self) or Send Message / Add (Other) */}
          <div className="user-profile-main-action">
            {isSelf ? (
              <button
                type="button"
                className="user-profile-action-btn"
                onClick={() => {
                  onClose();
                  onEditProfile?.();
                }}
              >
                <Icon name="config" size={15} />
                <span>Personalizar Perfil</span>
              </button>
            ) : isBot ? (
              <button
                type="button"
                className="user-profile-action-btn"
                onClick={() => {
                  onSendMessage?.("/help");
                  onClose();
                }}
              >
                <span>+ Usar comandos do bot</span>
              </button>
            ) : (
              <button
                type="button"
                className="user-profile-action-btn"
                onClick={() => {
                  onSendMessage?.(`Olá @${user.display_name}!`);
                  onClose();
                }}
              >
                <span>+ Enviar mensagem</span>
              </button>
            )}
          </div>

          <div className="user-profile-divider" />

          {/* Section: Sobre Mim / Bio */}
          <div className="user-profile-section">
            <h4 className="user-profile-section-title">SOBRE MIM</h4>
            <div className="user-profile-bio">
              {user.bio ? (
                <p>{user.bio}</p>
              ) : (
                <p className="is-empty">
                  {isSelf
                    ? "Você ainda não adicionou um Sobre Mim. Clique em \"Personalizar Perfil\" para adicionar!"
                    : "Este usuário não adicionou uma biografia."}
                </p>
              )}
            </div>
          </div>

          {/* Section: Cargos / Roles */}
          <div className="user-profile-section">
            <h4 className="user-profile-section-title">CARGOS</h4>
            <div className="user-profile-roles">
              {user.role === "owner" ? (
                <span className="role-pill role-pill--owner">
                  <span className="role-dot" />
                  Dono do Servidor
                  <span className="role-close">✕</span>
                </span>
              ) : (
                <span className="role-pill">
                  <span className="role-dot" />
                  Membro
                  <span className="role-close">✕</span>
                </span>
              )}
              {isBot && (
                <span className="role-pill role-pill--bot">
                  <span className="role-dot" />
                  Bot Oficial
                  <span className="role-close">✕</span>
                </span>
              )}
              <button className="role-add-btn" title="Adicionar cargo">+</button>
            </div>
          </div>

          {/* Section: Membro Desde */}
          <div className="user-profile-section">
            <h4 className="user-profile-section-title">MEMBRO DESDE</h4>
            <div className="user-profile-date">
              <Icon name="events" size={13} />
              <span>{formattedDate}</span>
            </div>
          </div>

          {/* Section: Realtime Activity (if any) */}
          {activities && activities.length > 0 && (
            <div className="user-profile-section">
              <h4 className="user-profile-section-title">ATIVIDADE</h4>
              {activities.map((act, i) => (
                <div key={i} className="user-profile-activity-card">
                  <div className="activity-card-icon">
                    <Icon name="activities" size={18} />
                  </div>
                  <div className="activity-card-info">
                    <div className="activity-card-name">{act.name}</div>
                    {act.details && <div className="activity-card-detail">{act.details}</div>}
                    {act.state && <div className="activity-card-state">{act.state}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Quick Message Input at bottom */}
          {!isSelf && (
            <form className="user-profile-quick-message" onSubmit={handleSend}>
              <input
                type="text"
                placeholder={`Conversar com @${user.display_name}...`}
                value={quickMsg}
                onChange={e => setQuickMsg(e.target.value)}
              />
              <button type="submit" disabled={!quickMsg.trim()} title="Enviar">
                <Icon name="send-gift" size={15} />
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
