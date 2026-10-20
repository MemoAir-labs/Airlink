import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { connectCdp } from "@memo-air/browser/session";
import type { BrowserMessage } from "@memo-air/protocol";
import {
  browserMessageSchema,
  browserVideoResponseSchema,
} from "@memo-air/protocol";
import { signLiveToken } from "@memo-air/protocol/tokens";
import { build } from "esbuild";
import * as Y from "yjs";

import { percentiles } from "./stats.ts";

// Input → pixels for the shared browser, read where it matters: a real Chrome. The bench sends
// scrolls on the doc socket and a harness page (src/video-harness.ts) on the browser container's
// own video reports when the presented picture moved. Scrolls alternate direction so a short page
// always has something to move; a 5 s continuous scroll reads the frame rate.
const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "ws://localhost:3020" },
    url: {
      type: "string",
      default:
        "https://en.wikipedia.org/wiki/Conflict-free_replicated_data_type",
    },
    samples: { type: "string", default: "20" },
    chrome: {
      type: "string",
      default: [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].find((path) => existsSync(path)),
    },
    json: { type: "string" },
  },
});
const secret = process.env.LIVE_JWT_SECRET ?? "";
if (!secret) {
  process.stderr.write("LIVE_JWT_SECRET is required\n");
  process.exit(1);
}
const chromePath = args.chrome;
if (!chromePath) {
  process.stderr.write("no Chrome found; pass --chrome <path>\n");
  process.exit(1);
}
const wsUrl = args.server;
const httpUrl = wsUrl.replace(/^ws/, "http");
const sampleCount = Number(args.samples);
const docName = `bench:video-${crypto.randomUUID()}`;
const settleMs = 600;
const sampleTimeoutMs = 4000;
const startTimeoutMs = 45_000;
const scrollSeconds = 5;
const scrollEveryMs = 50;
const chromeDebugPort = 9555;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const token = signLiveToken(
  {
    actor: { kind: "human", id: "bench-driver", name: "Bench" },
    workspaceId: "bench",
    docName,
    access: "write",
  },
  secret,
  3600
);

let status: Extract<BrowserMessage, { type: "browser_status" }> | null = null;

const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docName,
  document: new Y.Doc(),
  token,
  onStateless: ({ payload }) => {
    const parsed = browserMessageSchema.safeParse(JSON.parse(payload));
    if (parsed.success && parsed.data.type === "browser_status") {
      status = parsed.data;
    }
  },
});

const waitUntil = async (
  check: () => boolean,
  timeoutMs: number,
  what: string
) => {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(20);
  }
};

const wheel = (deltaY: number) =>
  provider.sendStateless(
    JSON.stringify({ type: "wheel", x: 640, y: 400, deltaX: 0, deltaY })
  );

await waitUntil(() => provider.synced, 10_000, "sync");
provider.sendStateless(JSON.stringify({ type: "navigate", url: args.url }));
await waitUntil(
  () => status?.status === "running" && status.video,
  startTimeoutMs,
  "the browser to run with video"
);

const grantResponse = await fetch(
  `${httpUrl}/v1/docs/${encodeURIComponent(docName)}/browser-video`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` } }
);
if (!grantResponse.ok) {
  throw new Error(`browser-video failed: ${grantResponse.status}`);
}
const grant = browserVideoResponseSchema.parse(await grantResponse.json());

const harness = await build({
  entryPoints: [new URL("./video-harness.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "benchHarness",
  platform: "browser",
  logLevel: "silent",
});

const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${chromeDebugPort}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "bench-chrome-"))}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,960",
    "about:blank",
  ],
  { stdio: "ignore" }
);
const stopChrome = () => {
  chrome.kill();
};
process.on("exit", stopChrome);

let cdpUrl = "";
await waitUntil(
  () => {
    void fetch(`http://127.0.0.1:${chromeDebugPort}/json/version`)
      .then((response) => response.json())
      .then((info: unknown) => {
        if (
          typeof info === "object" &&
          info !== null &&
          "webSocketDebuggerUrl" in info &&
          typeof info.webSocketDebuggerUrl === "string"
        ) {
          cdpUrl = info.webSocketDebuggerUrl;
        }
      })
      .catch(() => {});
    return cdpUrl !== "";
  },
  15_000,
  "Chrome's debugging port"
);
const cdp = await connectCdp(cdpUrl);
const { targetId } = await cdp.send<{ targetId: string }>(
  "Target.createTarget",
  { url: grant.url }
);
const { sessionId } = await cdp.send<{ sessionId: string }>(
  "Target.attachToTarget",
  { targetId, flatten: true }
);
const evaluate = async <T>(expression: string): Promise<T> => {
  const { result, exceptionDetails } = await cdp.send<{
    result: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId
  );
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text
    );
  }
  return result.value as T;
};
await cdp.send("Page.enable", {}, sessionId);
// The harness must run on the browser container's own origin, so wait for that page, not
// about:blank, before injecting it.
let onOrigin = false;
await waitUntil(
  () => {
    void evaluate<boolean>(
      `location.origin === ${JSON.stringify(new URL(grant.url).origin)} && document.readyState === "complete"`
    )
      .then((ready) => {
        onOrigin = ready;
      })
      .catch(() => {});
    return onOrigin;
  },
  15_000,
  "the harness page"
);
await evaluate(`${harness.outputFiles[0].text}; void 0`);
await evaluate(
  `benchHarness.start(${JSON.stringify(grant)}).then((h) => { window.bench = h; return true; })`
);

type Result = {
  changedAt: number;
  idleChanges: number;
  playing: boolean;
  totalFrames: number;
  droppedFrames: number;
};
const read = () => evaluate<Result>("window.bench.result()");
let playing = false;
await waitUntil(
  () => {
    void read().then((r) => {
      playing = r.playing && r.totalFrames > 0;
    });
    return playing;
  },
  20_000,
  "the first video frame in Chrome"
);

const videoMs: number[] = [];
let misses = 0;
for (let i = 0; i < sampleCount; i++) {
  await sleep(settleMs);
  await evaluate("window.bench.arm(), true");
  const sentAtMs = Date.now();
  wheel(i % 2 === 0 ? 400 : -400);
  let changedAt = 0;
  while (changedAt === 0 && Date.now() - sentAtMs < sampleTimeoutMs) {
    await sleep(15);
    changedAt = (await read()).changedAt;
  }
  if (changedAt === 0) {
    misses += 1;
  } else {
    videoMs.push(changedAt - sentAtMs);
  }
}

const before = await read();
const scrollStartedAt = Date.now();
for (let i = 0; Date.now() - scrollStartedAt < scrollSeconds * 1000; i++) {
  wheel(i % 40 < 20 ? 120 : -120);
  await sleep(scrollEveryMs);
}
const after = await read();
const fps = {
  presented: (after.totalFrames - before.totalFrames) / scrollSeconds,
  dropped: after.droppedFrames - before.droppedFrames,
};

const results = {
  url: args.url,
  samples: sampleCount,
  video: { ...percentiles(videoMs), misses, idleChanges: before.idleChanges },
  scroll: fps,
};
if (args.json) {
  writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
}
process.stdout.write(
  [
    `Scroll input → pixels presented in Chrome, ${sampleCount} samples on ${args.url}`,
    "",
    "| Measure (ms) | p50 | p95 | p99 | n |",
    "|---|---|---|---|---|",
    `| Browser input → pixels on a viewer | ${results.video.p50} | ${results.video.p95} | ${results.video.p99} | ${results.video.n}${misses ? ` (${misses} missed)` : ""} |`,
    "",
    `Continuous ${scrollSeconds} s scroll: ${fps.presented.toFixed(1)} fps presented, ${fps.dropped} frames dropped`,
    `Frame changes seen while idle: ${before.idleChanges} (a non-zero count means the detector is noisy)`,
    "",
  ].join("\n")
);
cdp.close();
stopChrome();
provider.destroy();
process.exit(0);
