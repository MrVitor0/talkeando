// Real Discord icon set, copied into client/ui/icons/ as authentic SVGs.
// They are rendered as CSS masks (not <img>) so a single `color` value
// recolors any of them — including the Lottie-exported ones whose paths
// carry hard-coded fills — and hover/active states are just a color change.
const iconUrls = import.meta.glob("../icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const byName: Record<string, string> = {};
for (const path in iconUrls) {
  const name = path.split("/").pop()!.replace(/\.svg$/, "");
  byName[name] = iconUrls[path];
}

export type IconName =
  | "activities"
  | "add-media"
  | "camera"
  | "camera-closed"
  | "config"
  | "crisp-nois-cenaceling-on"
  | "crisp-off"
  | "discord-icon"
  | "events"
  | "friends"
  | "hangout-call"
  | "headphone-muted"
  | "headphone"
  | "inbox"
  | "members"
  | "mic-muted"
  | "mic-open"
  | "notifications"
  | "pin-messages"
  | "question"
  | "send-gif"
  | "send-gift"
  | "send-sticker"
  | "share-screen"
  | "sound-effects"
  | "voice-chat-private"
  | "voice-chat"
  | "wifi-connect";

export function Icon({
  name,
  size = 20,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  const url = byName[name];
  return (
    <span
      className={className ? `tk-icon ${className}` : "tk-icon"}
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
      }}
    />
  );
}
