import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AirlinkConfig = {
  databaseUrl: string;
  port: number;
  livePort: number;
  host: string;
  dataDir: string;
  liveKit: { url: string; apiKey: string; apiSecret: string } | null;
  browsers: { json: string; password: string; apiToken: string } | null;
  browserCdpUrl: string | null;
  browserProxyPort: number;
  e2bApiKey: string | null;
  desktop: {
    controlUrl: string;
    viewerUrl: string;
    viewerPassword: string;
    token: string;
  } | null;
  runner: { controlUrl: string; token: string } | null;
  envApiKeys: {
    anthropic: string | null;
    openai: string | null;
    elevenlabs: string | null;
    cartesia: string | null;
    deepgram: string | null;
  };
  production: boolean;
};

// Defaults match docker-compose.yml, so a fresh clone runs with no .env beyond the LLM key.
export function readConfig(env: NodeJS.ProcessEnv): AirlinkConfig {
  const liveKitUrl = env.LIVEKIT_URL ?? "ws://localhost:7880";
  return {
    databaseUrl:
      env.AIRLINK_DATABASE_URL ??
      "postgres://airlink:airlink@localhost:5434/airlink",
    port: Number(env.AIRLINK_PORT ?? 3030),
    livePort: Number(env.AIRLINK_LIVE_PORT ?? 3031),
    host: env.AIRLINK_HOST ?? "127.0.0.1",
    dataDir: resolve(env.AIRLINK_DATA_DIR ?? ".airlink"),
    liveKit:
      liveKitUrl === "off"
        ? null
        : {
            url: liveKitUrl,
            apiKey: env.LIVEKIT_API_KEY ?? "devkey",
            apiSecret: env.LIVEKIT_API_SECRET ?? "secret",
          },
    browsers:
      env.AIRLINK_BROWSERS === "off"
        ? null
        : {
            json:
              env.AIRLINK_BROWSERS ??
              '[{"cdp":"http://localhost:9232","neko":"http://localhost:3032","publicUrl":"http://localhost:3032"}]',
            password: env.AIRLINK_NEKO_PASSWORD ?? "airlink",
            apiToken: env.AIRLINK_NEKO_API_TOKEN ?? "airlink-neko",
          },
    browserCdpUrl: env.AIRLINK_BROWSER_CDP_URL ?? null,
    browserProxyPort: Number(env.AIRLINK_BROWSER_PROXY_PORT ?? 3033),
    e2bApiKey: env.E2B_API_KEY || null,
    desktop:
      env.AIRLINK_DESKTOP === "off"
        ? null
        : {
            controlUrl:
              env.AIRLINK_DESKTOP_CONTROL_URL ?? "http://localhost:3035",
            viewerUrl:
              env.AIRLINK_DESKTOP_VIEWER_URL ?? "http://localhost:3034",
            viewerPassword: env.AIRLINK_DESKTOP_PASSWORD ?? "airlink",
            token: env.AIRLINK_DESKTOP_TOKEN ?? "airlink-desktop",
          },
    runner:
      env.AIRLINK_RUNNER === "off"
        ? null
        : {
            controlUrl:
              env.AIRLINK_RUNNER_CONTROL_URL ?? "http://localhost:3036",
            token: env.AIRLINK_RUNNER_TOKEN ?? "airlink-runner",
          },
    envApiKeys: {
      anthropic: env.ANTHROPIC_API_KEY || null,
      elevenlabs: env.ELEVENLABS_API_KEY || null,
      cartesia: env.CARTESIA_API_KEY || null,
      deepgram: env.DEEPGRAM_API_KEY || null,
      openai: env.OPENAI_API_KEY || null,
    },
    production: env.NODE_ENV === "production",
  };
}

// The signing secret for live tokens and the person cookie, made on first run and kept with the
// rest of the person's data.
export function loadSecret(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "secret");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    writeFileSync(path, `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}
