# AirLink in one image: the server (live-server runs inside it) and its built web app, run from
# TypeScript source with Node's type stripping. Settings, agents, memory and the signing secret live
# in /data. Build context: this repository's root, which must hold package-lock.json.
FROM node:24.16.0-slim AS build

WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
  && npm run build -w @memo-air/app \
  && npm prune --omit=dev --ignore-scripts \
  && find packages apps -name "*.test.ts" -delete

FROM node:24.16.0-slim

WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV AIRLINK_HOST=0.0.0.0
ENV AIRLINK_DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
WORKDIR /app/apps/airlink
EXPOSE 3030 3031 3033
USER node
# Healthy when the web app answers and its live server reports in.
HEALTHCHECK CMD ["node", "-e", "const port = (name, fallback) => process.env[name] ?? fallback; Promise.all([`http://127.0.0.1:${port('AIRLINK_PORT', 3030)}/`, `http://127.0.0.1:${port('AIRLINK_LIVE_PORT', 3031)}/healthz`].map((url) => fetch(url))).then((rs) => process.exit(rs.every((r) => r.ok) ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.ts"]
