export interface BannerPreset {
  id: string;
  name: string;
  category: string;
  cssBackground: string;
  accentColor: string;
  previewGradient: string;
}

export const BANNER_PRESETS: BannerPreset[] = [
  {
    id: "sakura",
    name: "Sakura Blossom",
    category: "Natureza & Anime",
    accentColor: "#ee4540",
    previewGradient: "linear-gradient(135deg, #2d132c 0%, #801336 50%, #ee4540 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(45, 19, 44, 0.94) 0%, rgba(128, 19, 54, 0.85) 50%, rgba(238, 69, 64, 0.75) 100%),
      radial-gradient(circle at 85% 30%, rgba(255, 183, 197, 0.35) 0%, transparent 50%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 120' width='400' height='120'%3E%3Cpath d='M380,10 Q340,30 300,20 Q260,10 220,35 Q180,60 140,50' stroke='%23ffb7c5' stroke-width='2.5' fill='none' opacity='0.35'/%3E%3Ccircle cx='360' cy='20' r='5' fill='%23ff758c' opacity='0.7'/%3E%3Ccircle cx='330' cy='35' r='4' fill='%23ff7eb3' opacity='0.6'/%3E%3Ccircle cx='300' cy='18' r='6' fill='%23ff4b72' opacity='0.75'/%3E%3Ccircle cx='270' cy='22' r='4.5' fill='%23ff758c' opacity='0.6'/%3E%3Ccircle cx='230' cy='40' r='5.5' fill='%23ff7eb3' opacity='0.7'/%3E%3Ccircle cx='190' cy='52' r='4' fill='%23ffb7c5' opacity='0.8'/%3E%3C/svg%3E")
    `,
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk 2077",
    category: "Sci-Fi & Futurista",
    accentColor: "#00f0ff",
    previewGradient: "linear-gradient(135deg, #09090e 0%, #1a0826 40%, #0d2b45 75%, #00f0ff 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(9, 9, 14, 0.94) 0%, rgba(26, 8, 38, 0.88) 40%, rgba(13, 43, 69, 0.82) 75%, rgba(0, 240, 255, 0.6) 100%),
      radial-gradient(circle at 90% 20%, rgba(0, 240, 255, 0.4) 0%, transparent 60%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath d='M0,20 L40,20 M20,0 L20,40' stroke='%2300f0ff' stroke-width='0.5' opacity='0.25'/%3E%3C/svg%3E")
    `,
  },
  {
    id: "synthwave",
    name: "Synthwave Neon",
    category: "Retrowave",
    accentColor: "#ff007f",
    previewGradient: "linear-gradient(135deg, #1b003a 0%, #58007a 40%, #ff007f 80%, #ffaa00 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(27, 0, 58, 0.95) 0%, rgba(88, 0, 122, 0.88) 40%, rgba(255, 0, 127, 0.75) 80%, rgba(255, 170, 0, 0.65) 100%),
      radial-gradient(circle at 80% 80%, rgba(255, 0, 127, 0.4) 0%, transparent 60%)
    `,
  },
  {
    id: "nebula",
    name: "Dark Nebula",
    category: "Cosmos & Espaço",
    accentColor: "#a855f7",
    previewGradient: "linear-gradient(135deg, #050510 0%, #150a2a 40%, #301048 75%, #6b21a8 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(5, 5, 16, 0.95) 0%, rgba(21, 10, 42, 0.9) 40%, rgba(48, 16, 72, 0.82) 75%, rgba(107, 33, 168, 0.7) 100%),
      radial-gradient(circle at 75% 25%, rgba(168, 85, 247, 0.35) 0%, transparent 50%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Ccircle cx='15' cy='20' r='1' fill='%23fff' opacity='0.7'/%3E%3Ccircle cx='80' cy='35' r='1.5' fill='%23c084fc' opacity='0.8'/%3E%3Ccircle cx='45' cy='75' r='1' fill='%23fff' opacity='0.6'/%3E%3Ccircle cx='90' cy='85' r='0.8' fill='%23e9d5ff' opacity='0.7'/%3E%3C/svg%3E")
    `,
  },
  {
    id: "sunset",
    name: "Midnight Sunset",
    category: "Gradiente & Estética",
    accentColor: "#f97316",
    previewGradient: "linear-gradient(135deg, #120c24 0%, #381b4e 35%, #7e2a56 70%, #d85c4b 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(18, 12, 36, 0.95) 0%, rgba(56, 27, 78, 0.9) 35%, rgba(126, 42, 86, 0.82) 70%, rgba(216, 92, 75, 0.72) 100%),
      radial-gradient(circle at 85% 40%, rgba(249, 115, 22, 0.35) 0%, transparent 60%)
    `,
  },
  {
    id: "forest",
    name: "Emerald Forest",
    category: "Natureza",
    accentColor: "#10b981",
    previewGradient: "linear-gradient(135deg, #051610 0%, #0b291e 40%, #134634 75%, #10b981 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(5, 22, 16, 0.95) 0%, rgba(11, 41, 30, 0.9) 40%, rgba(19, 70, 52, 0.85) 75%, rgba(16, 185, 129, 0.65) 100%),
      radial-gradient(circle at 80% 30%, rgba(16, 185, 129, 0.3) 0%, transparent 55%)
    `,
  },
  {
    id: "crimson",
    name: "Crimson Dragon",
    category: "Dark & Gamer",
    accentColor: "#ef4444",
    previewGradient: "linear-gradient(135deg, #100608 0%, #29080c 45%, #5a0c14 80%, #ef4444 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(16, 6, 8, 0.96) 0%, rgba(41, 8, 12, 0.9) 45%, rgba(90, 12, 20, 0.82) 80%, rgba(239, 68, 68, 0.65) 100%),
      radial-gradient(circle at 85% 25%, rgba(239, 68, 68, 0.4) 0%, transparent 50%)
    `,
  },
  {
    id: "obsidian",
    name: "Obsidian Carbon",
    category: "Minimalista",
    accentColor: "#64748b",
    previewGradient: "linear-gradient(135deg, #0d0f12 0%, #181b22 50%, #242933 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(13, 15, 18, 0.97) 0%, rgba(24, 27, 34, 0.92) 50%, rgba(36, 41, 51, 0.85) 100%),
      radial-gradient(circle at 90% 10%, rgba(255, 255, 255, 0.08) 0%, transparent 50%)
    `,
  },
  {
    id: "sky",
    name: "Twilight Clouds",
    category: "Anime & Pastel",
    accentColor: "#38bdf8",
    previewGradient: "linear-gradient(135deg, #1e1b4b 0%, #312e81 40%, #4338ca 75%, #38bdf8 100%)",
    cssBackground: `
      linear-gradient(135deg, rgba(30, 27, 75, 0.95) 0%, rgba(49, 46, 129, 0.88) 40%, rgba(67, 56, 202, 0.8) 75%, rgba(56, 189, 248, 0.6) 100%),
      radial-gradient(circle at 80% 30%, rgba(56, 189, 248, 0.35) 0%, transparent 60%)
    `,
  },
];

export function getBannerPreset(id: string | null | undefined): BannerPreset {
  return BANNER_PRESETS.find(b => b.id === id) ?? BANNER_PRESETS[0];
}
