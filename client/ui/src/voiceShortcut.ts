export type VoiceInputMode = "voice_activity" | "push_to_talk" | "toggle";

export interface VoiceShortcutConfig {
  mode: VoiceInputMode;
  key: string;
}

interface VoiceShortcutActions {
  onPushToTalkChange: (pressed: boolean) => void;
  onToggle: () => void;
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

/**
 * Converts keyboard events from both the WebView and the native global hook
 * into one logical press/release stream. Native key-repeat and duplicated
 * WebView events therefore never produce extra toggle actions.
 */
export class VoiceShortcutController {
  private pressedKey: string | null = null;

  constructor(private readonly actions: VoiceShortcutActions) {}

  handle(code: string, isDown: boolean, config: VoiceShortcutConfig): void {
    if (isDown) {
      if (this.pressedKey || !matchesVoiceShortcut(code, config.key)) return;
      this.pressedKey = code;
      if (config.mode === "push_to_talk") {
        this.actions.onPushToTalkChange(true);
      } else if (config.mode === "toggle") {
        this.actions.onToggle();
      }
      return;
    }

    // Match key-up against the key that started the action, not the current
    // preference: the shortcut may have been edited while the key was held.
    if (!this.pressedKey || !matchesVoiceShortcut(code, this.pressedKey)) return;
    this.pressedKey = null;
    if (config.mode === "push_to_talk") {
      this.actions.onPushToTalkChange(false);
    }
  }

  reset(): void {
    this.pressedKey = null;
  }
}
