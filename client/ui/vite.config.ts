import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    // Keep every icon as a real file on disk. They are used as CSS
    // `mask-image` URLs (see Icon.tsx); inlined `data:image/svg+xml` masks
    // render inconsistently in Chromium, and the native client copies
    // `dist/**` verbatim, so predictable asset paths matter more than
    // shaving a few requests.
    assetsInlineLimit: 0,
  },
});
