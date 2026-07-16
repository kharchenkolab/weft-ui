import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // relative base: the built app works from any mount point ("/", or
  // "/weft/proj-a/" under an ASGI mount — docs/embedding.md). Safe because
  // hash routing means the document is only served from the mount root.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // the dev server proxies to the running weft-ui server; SSE streams through
      "/api": { target: "http://127.0.0.1:8999", changeOrigin: false },
    },
  },
  resolve: {
    alias: { "@shared": new URL("../shared", import.meta.url).pathname },
  },
});
