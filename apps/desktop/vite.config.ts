/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
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
