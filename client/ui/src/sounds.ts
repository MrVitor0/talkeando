// Discord-style UI sound effects. Files live in client/ui/public/sounds/
// and are copied verbatim into dist/ by Vite, so they load from a stable
// relative URL with no import hashing.

const files = {
  joinCall: "discord-join-call.mp3",
  leaveCall: "discord-leave-noise.mp3",
  notification: "discord-notification.mp3",
  startScreen: "start_screen.mp3",
  stopScreen: "stop_screen.mp3",
  startCamera: "start_camera.mp3",
  stopCamera: "stop_camera.mp3",
  micMuted: "mic-muted.MP3",
  micUnmuted: "mic-unmuted.MP3",
  noiseSuppressionEnabled: "mic-unmuted.MP3",
  noiseSuppressionDisabled: "mic-muted.MP3",
  headphoneMuted: "headphone-muted.MP3",
  headphoneUnmuted: "headphone-umuted.MP3",
} as const;

export type SoundName = keyof typeof files;

const base = import.meta.env.BASE_URL;
const cache = new Map<SoundName, HTMLAudioElement>();
const lastPlayed = new Map<SoundName, number>();
// Collapses the burst you'd otherwise hear on joining a populated call
// (one join blip per existing participant arriving at once).
const MIN_INTERVAL_MS = 600;
let muted = false;

/// Deafening yourself silences the UI sounds too, matching Discord.
export function setSoundsMuted(value: boolean) {
  muted = value;
}

export function playSound(name: SoundName) {
  if (muted) return;
  const now = Date.now();
  if (now - (lastPlayed.get(name) ?? 0) < MIN_INTERVAL_MS) return;
  lastPlayed.set(name, now);
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(`${base}sounds/${files[name]}`);
    audio.volume = 0.35;
    cache.set(name, audio);
  }
  try {
    audio.currentTime = 0;
    // Autoplay can reject until the first user gesture; every caller here is
    // downstream of a click or a live socket the user opened, so a rejection
    // is safe to swallow.
    void audio.play().catch(() => {});
  } catch {
    /* no-op */
  }
}
