import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

import { signLiveToken } from "@memo-air/protocol/tokens";
import * as Y from "yjs";

import { percentiles } from "./stats.ts";
import {
  authMessage,
  parseFrame,
  stampKeyFor,
  syncStepOneMessage,
  updateMessage,
} from "./wire.ts";

// Load generator for the concurrency row: raw WebSocket clients that send real Yjs updates and
// timestamp what they receive without applying it, spread over worker threads so the generator
// never becomes the bottleneck the way 500 HocuspocusProviders in one process did.
type WorkerConfig = {
  wsUrl: string;
  docNames: string[];
  clients: number;
  rate: number;
  seconds: number;
  secret: string;
};
type Report = {
  samples: number[];
  sent: number;
  expected: number;
  received: number;
  connected: number;
  drainMs: number;
  loopLagMaxMs: number;
};
type WorkerMessage =
  | { type: "ready"; connected: number }
  | { type: "report"; report: Report };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const connectTimeoutMs = 15_000;
const drainStepMs = 500;
const drainMaxMs = 10_000;

function isWorkerConfig(value: unknown): value is WorkerConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "docNames" in value &&
    Array.isArray(value.docNames)
  );
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "ready" || value.type === "report")
  );
}

async function runClients(config: WorkerConfig): Promise<Report> {
  const { wsUrl, docNames, clients, rate, seconds, secret } = config;
  const samples: number[] = [];
  let received = 0;
  const sentByRoom = new Map<string, number>();
  // A stalled worker inflates every sample it holds; its own loop lag says whether a slow
  // percentile is the server's or the generator's.
  const loopLag = monitorEventLoopDelay({ resolution: 5 });
  loopLag.enable();

  const open = (docName: string, client: number) =>
    new Promise<WebSocket | null>((resolve) => {
      const token = signLiveToken(
        {
          actor: { kind: "human", id: `c${client}`, name: `c${client}` },
          workspaceId: "bench",
          docName,
          access: "write",
        },
        secret,
        3600
      );
      const socket = new WebSocket(wsUrl);
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        socket.close();
        resolve(null);
      }, connectTimeoutMs);
      const settle = (value: WebSocket | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      socket.onopen = () => {
        socket.send(authMessage(docName, token));
        socket.send(syncStepOneMessage(docName));
      };
      socket.onerror = () => settle(null);
      socket.onclose = () => settle(null);
      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }
        const frame = parseFrame(new Uint8Array(event.data));
        if (frame.type === "authenticated") {
          settle(socket);
        } else if (frame.type === "denied") {
          socket.close();
          settle(null);
        } else if (frame.type === "update") {
          const now = Date.now();
          for (const stamp of frame.stamps) {
            if (stamp.client !== client) {
              samples.push(now - stamp.sentAtMs);
              received += 1;
            }
          }
        }
      };
    });

  const sockets = await Promise.all(
    docNames.flatMap((docName) =>
      Array.from({ length: clients }, (_, client) =>
        open(docName, client).then((socket) => ({ docName, client, socket }))
      )
    )
  );
  const live = sockets.filter(
    (entry): entry is typeof entry & { socket: WebSocket } =>
      entry.socket !== null
  );
  const liveByRoom = new Map<string, number>();
  for (const { docName } of live) {
    liveByRoom.set(docName, (liveByRoom.get(docName) ?? 0) + 1);
  }
  parentPort?.postMessage({ type: "ready", connected: live.length });
  await new Promise((resolve) => parentPort?.once("message", resolve));

  const intervalMs = 1000 / rate;
  const endAtMs = Date.now() + seconds * 1000;
  await Promise.all(
    live.map(async ({ docName, client, socket }) => {
      const doc = new Y.Doc();
      doc.on("update", (update: Uint8Array) =>
        socket.send(updateMessage(docName, update))
      );
      await sleep(Math.random() * intervalMs);
      let seq = 0;
      while (Date.now() < endAtMs) {
        const sentAtMs = Date.now();
        // A socket the server closed swallows sends silently; only count what left.
        if (socket.readyState === WebSocket.OPEN) {
          doc.getMap("bench").set(stampKeyFor(client, seq, sentAtMs), 1);
          sentByRoom.set(docName, (sentByRoom.get(docName) ?? 0) + 1);
          seq += 1;
        }
        await sleep(Math.max(0, sentAtMs + intervalMs - Date.now()));
      }
    })
  );
  // Drain until nothing more arrives, so a backlog longer than a fixed wait still lands in the
  // samples instead of in `lost`.
  const drainStartedAtMs = Date.now();
  let seen = -1;
  while (seen !== received && Date.now() - drainStartedAtMs < drainMaxMs) {
    seen = received;
    await sleep(drainStepMs);
  }
  for (const { socket } of live) {
    socket.onclose = null;
    socket.close();
  }
  loopLag.disable();
  let sent = 0;
  let expected = 0;
  for (const [docName, count] of sentByRoom) {
    sent += count;
    expected += count * ((liveByRoom.get(docName) ?? 1) - 1);
  }
  return {
    samples,
    sent,
    expected,
    received,
    connected: live.length,
    drainMs: Date.now() - drainStartedAtMs - drainStepMs,
    loopLagMaxMs: Math.round(loopLag.max / 1e6),
  };
}

type Scrape = Map<string, number>;

async function scrape(httpUrl: string): Promise<Scrape | null> {
  const response = await fetch(`${httpUrl}/metrics`).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  const series: Scrape = new Map();
  for (const line of (await response.text()).split("\n")) {
    const match = /^(\S+) (\S+)$/.exec(line);
    if (match && !match[1].startsWith("#")) {
      series.set(match[1], Number(match[2]));
    }
  }
  return series;
}

// Histogram counters only grow, so the run's share is the difference between two scrapes; the
// event-loop lag percentiles reset on every scrape, so the second scrape covers the run.
function serverSummary(before: Scrape, after: Scrape) {
  const delta = (key: string) => (after.get(key) ?? 0) - (before.get(key) ?? 0);
  const count = delta("live_fanout_ms_count");
  const share = (le: number) =>
    count === 0
      ? null
      : Math.round(
          (delta(`live_fanout_ms_bucket{le="${le}"}`) / count) * 1000
        ) / 10;
  const lagMs = (name: string) =>
    Math.round((after.get(`nodejs_eventloop_lag_${name}_seconds`) ?? 0) * 1000);
  return {
    under5ms: share(5),
    under50ms: share(50),
    loopLagP99Ms: lagMs("p99"),
    loopLagMaxMs: lagMs("max"),
  };
}

// Workers connect, report ready, and send only on "go", so the server's lag window covers the
// steady state and not the connection ramp.
function spawnWorker(config: WorkerConfig) {
  const worker = new Worker(new URL(import.meta.url), { workerData: config });
  let ready: () => void = () => {};
  let report: (report: Report) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const reportPromise = new Promise<Report>((resolve, reject) => {
    report = resolve;
    fail = reject;
  });
  worker.on("message", (message: unknown) => {
    if (!isWorkerMessage(message)) {
      return;
    }
    if (message.type === "ready") {
      ready();
    } else {
      report(message.report);
    }
  });
  worker.once("error", fail);
  worker.once("exit", (code) =>
    fail(new Error(`load worker exited with code ${code} before reporting`))
  );
  return { readyPromise, reportPromise, go: () => worker.postMessage("go") };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      server: { type: "string", default: "ws://localhost:3020" },
      rooms: { type: "string", default: "50" },
      clients: { type: "string", default: "10" },
      rate: { type: "string", default: "5" },
      seconds: { type: "string", default: "60" },
      workers: {
        type: "string",
        default: String(Math.max(1, os.availableParallelism() - 2)),
      },
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
  const clients = Number(args.clients);
  const rate = Number(args.rate);
  const seconds = Number(args.seconds);
  const workers = Math.min(Number(args.workers), rooms);
  const httpUrl = args.server.replace(/^ws/, "http");
  const docNames = Array.from(
    { length: rooms },
    (_, r) => `bench:load-${r}-${crypto.randomUUID()}`
  );
  const spawned = Array.from({ length: workers }, (_, w) =>
    spawnWorker({
      wsUrl: args.server,
      docNames: docNames.filter((_, r) => r % workers === w),
      clients,
      rate,
      seconds,
      secret,
    })
  );
  await Promise.all(spawned.map((entry) => entry.readyPromise));
  const before = await scrape(httpUrl);
  for (const entry of spawned) {
    entry.go();
  }
  const reports = await Promise.all(
    spawned.map((entry) => entry.reportPromise)
  );
  const after = await scrape(httpUrl);
  const total = (pick: (report: Report) => number) =>
    reports.reduce((sum, report) => sum + pick(report), 0);
  const samples = reports.flatMap((report) => report.samples);
  const sent = total((report) => report.sent);
  const received = total((report) => report.received);
  const connected = total((report) => report.connected);
  const fanout = percentiles(samples);
  const serverCommit = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      return "unknown";
    }
  })();
  const results = {
    machine: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      node: process.version,
    },
    serverCommit,
    redis: args.redis,
    config: { rooms, clients, rate, seconds, workers, connected },
    updatesPerSecond: Math.round(sent / seconds),
    sent,
    received,
    lost: total((report) => report.expected) - received,
    drainMs: Math.max(...reports.map((report) => report.drainMs)),
    fanout,
    generatorLoopLagMaxMs: Math.max(
      ...reports.map((report) => report.loopLagMaxMs)
    ),
    server: before && after ? serverSummary(before, after) : null,
  };
  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
  }
  process.stdout.write(
    [
      `Server ${serverCommit}, redis ${args.redis ? "on" : "off"}, ${rooms} rooms × ${clients} clients × ${rate}/s for ${seconds} s on ${workers} workers (${connected} connected, ~${results.updatesPerSecond} updates/s, ${received} received, ${results.lost} lost, drained in ${results.drainMs} ms), ${results.machine.cpu}, Node ${process.version}`,
      "",
      "| Measure (ms) | p50 | p95 | p99 | n |",
      "|---|---|---|---|---|",
      `| Keystroke → every other participant | ${fanout.p50} | ${fanout.p95} | ${fanout.p99} | ${fanout.n} |`,
      "",
      results.server
        ? `Server during the run: ${results.server.under5ms} % of updates handled ≤ 5 ms, ${results.server.under50ms} % ≤ 50 ms; event-loop lag p99 ${results.server.loopLagP99Ms} ms, max ${results.server.loopLagMaxMs} ms`
        : "Server /metrics unavailable",
      `Generator event-loop lag max across workers: ${results.generatorLoopLagMaxMs} ms`,
      "",
    ].join("\n")
  );
  process.exit(0);
}

if (isMainThread) {
  await main();
} else if (isWorkerConfig(workerData)) {
  const report = await runClients(workerData);
  parentPort?.postMessage({ type: "report", report });
}
