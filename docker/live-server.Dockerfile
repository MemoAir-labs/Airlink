# live-server on its own: Hocuspocus with persistence, agent ops and turns, for an app that brings
# its own UI and auth (the room-react and agent-node templates). It runs its TypeScript source with
# Node's type stripping, so there is no build step. Build context: this repository's root, which
# must hold package-lock.json (the public repository, or a scripts/export.sh tree).
FROM node:24.16.0-slim

WORKDIR /app
COPY . .
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w @memo-air/live-server \
  && find packages apps -name "*.test.ts" -delete

ENV NODE_ENV=production
ENV PORT=3020
WORKDIR /app/apps/live-server
EXPOSE 3020 3021
USER node
HEALTHCHECK CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
