import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies avoid CORS entirely:
//   /fns/*  → Cloud Functions emulator (5001)
//   /fsdb/* → Firestore emulator REST (8080)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    fs: { allow: ["..", "../.."] },
    proxy: {
      "/fns": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/fns/, ""),
      },
      "/fsdb": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/fsdb/, ""),
      },
    },
  },
});
