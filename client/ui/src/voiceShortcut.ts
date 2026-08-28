export type VoiceInputMode = "voice_activity" | "push_to_talk" | "toggle";

export interface VoiceShortcutConfig {
  mode: VoiceInputMode;
  key: string;
}

function normalizeKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === " " || normalized === "espaço") return "space";
  return normalized;
}

export function matchesVoiceShortcut(pressedKey: string, configuredKey: string): boolean {
  const pressed = normalizeKey(pressedKey);
  const configured = normalizeKey(configuredKey);
  if (!pressed || !configured) return false;
  if (pressed === configured) return true;
  if (configured.startsWith("key") && pressed === configured.slice(3)) return true;
  if (pressed.startsWith("key") && configured === pressed.slice(3)) return true;
  return false;
}
