import {
  cdpEndpointProvider,
  createPinningProxy,
  nekoPoolProvider,
  parseNekoInstances,
} from "@memo-air/browser/session";
import { e2bDesktopProvider } from "@memo-air/desktop/session";
import {
  createMediaTokens,
  liveKitSpeaker,
  openAiTts,
} from "@memo-air/media/server";
import {
  createLiveServer,
  systemOneProvider,
  turnWebhook,
} from "@memo-air/server";
import pino from "pino";

const logger = pino({ name: "live-server" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.fatal({ name }, "live-server: missing environment variable");
    process.exit(1);
  }
  return value;
}

const liveKitUrl = process.env.LIVEKIT_URL;
const liveKitApiKey = process.env.LIVEKIT_API_KEY;
const liveKitApiSecret = process.env.LIVEKIT_API_SECRET;
const openAiApiKey = process.env.OPENAI_API_KEY;
const media =
  liveKitUrl && liveKitApiKey && liveKitApiSecret
    ? {
        url: liveKitUrl,
        tokens: createMediaTokens({
          apiKey: liveKitApiKey,
          apiSecret: liveKitApiSecret,
        }),
        speaker: openAiApiKey
          ? liveKitSpeaker({
              tts: openAiTts({ apiKey: openAiApiKey }),
            })
          : null,
      }
    : null;

// A pool of neko browsers with video, or one headless Chromium shared by every room, or none.
const browserProvider = process.env.LIVE_BROWSERS
  ? nekoPoolProvider({
      instances: parseNekoInstances(process.env.LIVE_BROWSERS),
      password: requireEnv("LIVE_NEKO_PASSWORD"),
      apiToken: requireEnv("LIVE_NEKO_API_TOKEN"),
    })
  : process.env.LIVE_BROWSER_CDP_URL
    ? cdpEndpointProvider({ url: process.env.LIVE_BROWSER_CDP_URL })
    : null;

// The decision node speaks the System One wire: Laya locally (no key) or Jev by key. Turns a
// person's room events earn are pushed to the host at LIVE_TURN_HOOK_URL, signed with the shared
// secret; without a hook nothing is decided.
const decideUrl = process.env.LIVE_DECIDE_URL;
const jwtSecret = requireEnv("LIVE_JWT_SECRET");
const turnHookUrl = process.env.LIVE_TURN_HOOK_URL;

const live = createLiveServer({
  databaseUrl: requireEnv("LIVE_DATABASE_URL"),
  jwtSecret,
  redisUrl: process.env.REDIS_URL || undefined,
  decide: decideUrl
    ? systemOneProvider({
        name: process.env.LIVE_DECIDE_NAME || new URL(decideUrl).hostname,
        url: decideUrl,
        apiKey: process.env.LIVE_DECIDE_API_KEY || undefined,
        model: process.env.LIVE_DECIDE_MODEL || undefined,
      })
    : undefined,
  onTurn: turnHookUrl ? turnWebhook({ url: turnHookUrl, jwtSecret }) : null,
  browserProvider,
  desktopProvider: process.env.E2B_API_KEY
    ? e2bDesktopProvider({
        apiKey: process.env.E2B_API_KEY,
        template: process.env.LIVE_DESKTOP_TEMPLATE || undefined,
      })
    : null,
  media,
  port: Number(process.env.PORT ?? 3020),
  logger,
});

const port = await live.listen();
logger.info(
  {
    port,
    decide: decideUrl
      ? process.env.LIVE_DECIDE_NAME || new URL(decideUrl).hostname
      : "none",
    turnHook: Boolean(turnHookUrl),
  },
  "live-server: listening"
);

// The shared Chromium is launched with --proxy-server pointing at this port, so every page
// connection is dialed here to an address live-server resolved and checked itself.
const browserProxyPort = Number(process.env.LIVE_BROWSER_PROXY_PORT ?? 3021);
const browserProxy = browserProvider
  ? createPinningProxy({
      onRefused: (host) =>
        logger.warn({ host }, "live: browser proxy refused a connection"),
    }).listen(
      browserProxyPort,
      process.env.LIVE_BROWSER_PROXY_HOST ?? "0.0.0.0",
      () =>
        logger.info(
          { port: browserProxyPort },
          "live-server: browser proxy listening"
        )
    )
  : null;

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, "live-server: shutting down");
  browserProxy?.close();
  await live.destroy();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal));
}
