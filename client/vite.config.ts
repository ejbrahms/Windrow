import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// The governance API now requires a bearer token on every request (server/auth.js) — CORS alone
// let any local process self-grant. The dev proxy reads the same token the server generated on
// disk and attaches it server-side, so the browser never needs to know it and nothing changes for
// `npm run dev`.
const TOKEN_PATH = path.resolve(__dirname, "../server/data/api-token");

function readApiToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim();
  } catch {
    return undefined;
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            const token = readApiToken();
            if (token) proxyReq.setHeader("authorization", `Bearer ${token}`);
          });
        },
      },
    },
  },
});
