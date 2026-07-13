import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
