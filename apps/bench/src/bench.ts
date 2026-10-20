import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { signLiveToken } from "@memo-air/protocol/tokens";
import * as Y from "yjs";

import type { Percentiles } from "./stats.ts";
import { percentiles } from "./stats.ts";

const { values: args } = parseArgs({
  options: {
    server: { type: "string", default: "ws://localhost:3020" },
    rooms: { type: "string", default: "1" },
    clients: { type: "string", default: "2" },
    rate: { type: "string", default: "5" },
    seconds: { type: "string", default: "30" },
    awareness: { type: "string", default: "on" },
    json: { type: "string" },
    redis: { type: "boolean", default: false },
  },
});
const secret = process.env.LIVE_JWT_SECRET ?? "";
if (!secret) {
  process.stderr.write("LIVE_JWT_SECRET is required\n");
  process.exit(1);
}
const rooms = Number(args.rooms);
const clientsPerRoom = Number(args.clients);
const rate = Number(args.rate);
const seconds = Number(args.seconds);
const awarenessOn = args.awareness !== "off";
const wsUrl = args.server;
const httpUrl = wsUrl.replace(/^ws/, "http");
const workspaceId = "bench";
const agentOpSamples = 20;
const coldStartUpdates = 10_000;
const unloadWaitMs = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await sleep(2);
  }
}

function token(docName: string, kind: "human" | "agent", id: string) {
  return signLiveToken(
    { actor: { kind, id, name: id }, workspaceId, docName, access: "write" },
    secret,
    3600
  );
}

async function connect(docName: string, id: string) {
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: docName,
    document: new Y.Doc(),
    token: token(docName, "human", id),
  });
  await waitFor(() => provider.synced);
  return provider;
}

// Every client writes `now` under its own key at `rate` per second; every other client in the
// room records how long that value took to arrive. One host, one clock, so the difference is
// the fan-out latency. Awareness runs the same way through a local awareness field.
async function measureFanout() {
  const keystroke: number[] = [];
  const awareness: number[] = [];
  const providers = await Promise.all(
    Array.from({ length: rooms }, (_, r) => {
      const docName = `bench:room-${r}-${crypto.randomUUID()}`;
      return Promise.all(
        Array.from({ length: clientsPerRoom }, (_, c) =>
          connect(docName, `c${c}`).catch(() => null)
        )
      );
    })
  );
  for (const room of providers) {
    for (const [c, provider] of room.entries()) {
      if (!provider) {
        continue;
      }
      const ownPrefix = `c${c}:`;
      const seenKeys = new Map<string, number>();
      provider.document.getMap<number>("bench").observe((event) => {
        const now = Date.now();
        for (const key of event.keysChanged) {
          if (key.startsWith(ownPrefix)) {
            continue;
          }
          const sentAt = provider.document.getMap<number>("bench").get(key);
          if (sentAt !== undefined && seenKeys.get(key) !== sentAt) {
            seenKeys.set(key, sentAt);
            keystroke.push(now - sentAt);
          }
        }
      });
      const seenAwareness = new Map<number, number>();
      provider.awareness?.on("change", () => {
        const now = Date.now();
        for (const [clientId, state] of provider.awareness?.getStates() ?? []) {
          if (clientId === provider.document.clientID) {
            continue;
          }
          const sentAt = state.bench;
          if (
            typeof sentAt === "number" &&
            seenAwareness.get(clientId) !== sentAt
          ) {
            seenAwareness.set(clientId, sentAt);
            awareness.push(now - sentAt);
          }
        }
      });
    }
  }
  const connected = providers.flat().filter((p) => p !== null).length;
  const intervalMs = 1000 / rate;
  const endAt = Date.now() + seconds * 1000;
  // Each client keeps its own phase, as people do; sending every client in one tick would
  // measure how long the server takes to drain a synchronized burst instead.
  const runClient = async (c: number, provider: HocuspocusProvider) => {
    await sleep(Math.random() * intervalMs);
    let tick = 0;
    while (Date.now() < endAt) {
      const sentAt = Date.now();
      provider.document.getMap<number>("bench").set(`c${c}:${tick}`, sentAt);
      if (awarenessOn) {
        provider.setAwarenessField("bench", sentAt);
      }
      tick += 1;
      await sleep(Math.max(0, sentAt + intervalMs - Date.now()));
    }
    return tick;
  };
  const ticks = await Promise.all(
    providers.flatMap((room) =>
      room.flatMap((provider, c) => (provider ? [runClient(c, provider)] : []))
    )
  );
  const sent = ticks.reduce((sum, n) => sum + n, 0);
  await sleep(500);
  for (const provider of providers.flat()) {
    provider?.destroy();
  }
  return {
    connected,
    updatesPerSecond: Math.round(sent / seconds),
    keystroke: percentiles(keystroke),
    awareness: percentiles(awareness),
  };
}

// An agent op is one HTTP insert of one short block; the sample ends when a connected
// provider observes the fragment change.
async function measureAgentOp() {
  const docName = `bench:agent-${crypto.randomUUID()}`;
  const provider = await connect(docName, "watcher");
  const fragment = provider.document.getXmlFragment("default");
  const samples: number[] = [];
  for (let i = 0; i < agentOpSamples; i++) {
    const seen = new Promise<void>((resolve) => {
      const handler = () => {
        fragment.unobserveDeep(handler);
        resolve();
      };
      fragment.observeDeep(handler);
    });
    const startedAt = performance.now();
    const response = await fetch(
      `${httpUrl}/v1/docs/${encodeURIComponent(docName)}/ops`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token(docName, "agent", "bench-agent")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ops: [{ type: "insert", afterBlockId: null, markdown: `Line ${i}` }],
        }),
      }
    );
    if (!response.ok) {
      throw new Error(
        `ops failed: ${response.status} ${await response.text()}`
      );
    }
    await seen;
    samples.push(performance.now() - startedAt);
  }
  provider.destroy();
  return percentiles(samples);
}

// Cold start: a room with 10k logged updates is unloaded, then one client reconnects and the
// sample is the time until it is synced — load from Postgres included.
async function measureColdStart() {
  const docName = `bench:cold-${crypto.randomUUID()}`;
  const writer = await connect(docName, "writer");
  const map = writer.document.getMap<number>("log");
  for (let i = 0; i < coldStartUpdates; i++) {
    map.set(String(i), i);
  }
  await sleep(1000);
  writer.destroy();
  await sleep(unloadWaitMs);
  const startedAt = performance.now();
  const reader = await connect(docName, "reader");
  const elapsedMs = performance.now() - startedAt;
  const loaded = reader.document.getMap("log").size;
  reader.destroy();
  return { ms: Math.round(elapsedMs), loaded };
}

async function serverMetrics() {
  const response = await fetch(`${httpUrl}/metrics`).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("live_fanout_ms"))
    .join("\n");
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

const row = (name: string, p: Percentiles) =>
  `| ${name} | ${p.p50} | ${p.p95} | ${p.p99} | ${p.n} |`;

const fanout = await measureFanout();
const agentOp = await measureAgentOp();
const coldStart = await measureColdStart();
const results = {
  machine: {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  },
  serverCommit: gitCommit(),
  redis: args.redis,
  config: {
    rooms,
    clients: clientsPerRoom,
    rate,
    seconds,
    awareness: awarenessOn,
    connected: fanout.connected,
  },
  results: {
    keystroke: fanout.keystroke,
    awareness: fanout.awareness,
    agentOp,
    coldStart,
    concurrency: {
      rooms,
      clients: clientsPerRoom,
      rate,
      updatesPerSecond: fanout.updatesPerSecond,
      fanout: fanout.keystroke,
    },
  },
  serverMetrics: await serverMetrics(),
};
if (args.json) {
  writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
}
process.stdout.write(
  [
    `Server ${results.serverCommit}, redis ${results.redis ? "on" : "off"}, awareness ${awarenessOn ? "on" : "off"}, ${rooms} room(s) × ${clientsPerRoom} clients × ${rate}/s for ${seconds} s (${fanout.connected} connected, ~${fanout.updatesPerSecond} updates/s), ${results.machine.cpu}, Node ${results.machine.node}`,
    "",
    "| Measure (ms) | p50 | p95 | p99 | n |",
    "|---|---|---|---|---|",
    row("Keystroke → every other participant", fanout.keystroke),
    row("Awareness → others", fanout.awareness),
    row("Agent op applied → human sees it", agentOp),
    `| Room cold start, ${coldStartUpdates} updates (${coldStart.loaded} loaded) | ${coldStart.ms} | | | 1 |`,
    "",
  ].join("\n")
);
process.exit(0);
