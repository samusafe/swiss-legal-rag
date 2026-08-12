/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Pre-bundle the heavy dependencies eagerly on dev-server start instead of
  // on the first page request — cuts the cold-start blank window in
  // `pnpm tauri dev` (Vite otherwise discovers and optimizes these lazily).
  optimizeDeps: {
    include: [
      "@heroui/react",
      "framer-motion",
      "react",
      "react-dom",
      "@tauri-apps/api/core",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-notification",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-sql",
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/setupTests.ts"],
    // HeroUI's react-aria/react-stately deps ship an ESM entry that
    // re-exports from a CJS file; letting Vite's SSR pipeline process
    // (rather than externalize) them fixes named-export interop under
    // Vitest. See https://github.com/adobe/react-spectrum interop notes.
    server: {
      deps: {
        inline: [/@heroui/, /@react-aria/, /@react-stately/, /@internationalized/],
      },
    },
  },
});
