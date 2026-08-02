import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base: the same bundle is served by `floe ui` (http://127.0.0.1:4321)
// and loaded from disk by the Tauri shell.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:4321" } },
});
