import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { tokenMiddleware } from "./server.ts";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: "airlink-token",
      // Vitest starts a dev server too, and its tests sign their own tokens.
      apply: (_config, env) => env.mode !== "test",
      configureServer(server) {
        const secret = loadEnv(mode, process.cwd(), "").LIVE_JWT_SECRET;
        if (!secret) {
          throw new Error(
            "Set LIVE_JWT_SECRET in .env: docker compose gives live-server the same value."
          );
        }
        server.middlewares.use(tokenMiddleware(secret));
      },
    },
  ],
}));
