import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { createLiveAgentClient } from "@memo-air/agent";
import { agentsNamedIn, routeSpoken } from "@memo-air/agents";
import type { Bridge } from "@memo-air/bridge";
import {
  agentMemory,
  createBridge,
  detectHarnesses,
  serveRoomMcp,
} from "@memo-air/bridge";
import {
  cdpEndpointProvider,
  createPinningProxy,
  nekoPoolProvider,
  parseNekoInstances,
} from "@memo-air/browser/session";
import { readMessages } from "@memo-air/chat";
import type { Decide } from "@memo-air/decide";
import {
  e2bDesktopProvider,
  selfHostedDesktopProvider,
} from "@memo-air/desktop/session";
import { createMediaTokens } from "@memo-air/media/server";
import type { TranscriptRequest } from "@memo-air/protocol";
import { systemActor } from "@memo-air/protocol";
import { signLiveToken } from "@memo-air/protocol/tokens";
import { createLiveServer } from "@memo-air/server";
import type { VoiceActor } from "@memo-air/voice";
import { createVoice } from "@memo-air/voice";
import pg from "pg";
import pino from "pino";
import type * as Y from "yjs";

import { createApi } from "./api.ts";
import { createBriefs } from "./brief.ts";
import { loadSecret, readConfig } from "./config.ts";
import { createRoom, workspaceId } from "./room.ts";
import { controlClient, createRunner, docStateWriter } from "./runner.ts";
import { createSearchIndex } from "./search.ts";
import {
  availableModels,
  closeKept,
  completeFor,
  createSettingsFiles,
  decideFor,
  draftInstructions,
  harnessesFor,
  keptHarnesses,
  publicSettings,
  scribeTokenFor,
} from "./settings.ts";
import { createStore } from "./store.ts";
import { previewVoice, voicesFor } from "./voice-preview.ts";

const logger = pino({ name: "airlink" });
const config = readConfig(process.env);
const secret = loadSecret(config.dataDir);
const files = createSettingsFiles(config.dataDir);
const appRoot = join(import.meta.dirname, "..");

const memoryRootOf = (settings: { memoryRoot: string }) =>
  settings.memoryRoot || join(config.dataDir, "memory");

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const store = createStore(pool);
const predatingMembers = await store.init();

// Reads a doc as the server, for work outside any person's connection.
const readDoc = async <T>(
  docName: string,
  read: (document: Y.Doc) => T | Promise<T>
): Promise<T> => {
  const connection = await live.hocuspocus.openDirectConnection(docName, {
    actor: { kind: "human", id: "airlink", name: "AirLink" },
    access: "read",
    workspaceId,
  });
  try {
    if (!connection.document) {
      throw new Error(`${docName} did not load`);
    }
    return await read(connection.document);
  } finally {
    await connection.disconnect();
  }
};
const searchIndex = createSearchIndex({ store, readDoc });
const briefs = createBriefs({
  store,
  complete: () => completeFor(files.settings(), config.envApiKeys),
  logger,
});

const browserProvider = config.browserCdpUrl
  ? cdpEndpointProvider({ url: config.browserCdpUrl })
  : config.browsers
    ? nekoPoolProvider({
        instances: parseNekoInstances(config.browsers.json),
        password: config.browsers.password,
        apiToken: config.browsers.apiToken,
      })
    : null;

// Settings change while the server runs, so live-server gets a decide that reads them per call
// and the bridge is rebuilt behind one stable onTurn.
let decide: Decide = await decideFor(files.settings(), config.envApiKeys);
let bridge: Bridge | null = null;

const mediaTokens = config.liveKit
  ? createMediaTokens({
      apiKey: config.liveKit.apiKey,
      apiSecret: config.liveKit.apiSecret,
    })
  : null;

const live = createLiveServer({
  databaseUrl: config.databaseUrl,
  jwtSecret: secret,
  port: config.livePort,
  address: config.host,
  decide: (input) => decide(input),
  onTurn: async (turn) => bridge?.onTurn(turn),
  onSpoken: async (turn) => bridge?.onTurn(turn),
  // Nothing in AirLink reads screenshot history: people watch live over LiveKit, and agents read
  // the page itself.
  browserHistoryFrames: 0,
  onStored: async (docName, document) => {
    await searchIndex.stored(docName, document);
    await briefs.stored(docName, document);
  },
  browserProvider,
  desktopProvider: config.e2bApiKey
    ? e2bDesktopProvider({ apiKey: config.e2bApiKey })
    : config.desktop
      ? selfHostedDesktopProvider(config.desktop)
      : null,
  media:
    config.liveKit && mediaTokens
      ? {
          url: config.liveKit.url,
          tokens: mediaTokens,
          speaker: null,
        }
      : null,
  logger: logger.child({ part: "live" }),
});
const livePort = await live.listen();
void searchIndex
  .backfill()
  .catch((err) => logger.error({ err }, "airlink: search backfill failed"));

// Who has written in a channel, read from its chat: each person once, under the name and time of
// their latest message, with how many they wrote.
const chatWriters = async (chatDoc: string) => {
  const connection = await live.hocuspocus.openDirectConnection(chatDoc, {
    actor: { kind: "human", id: "airlink", name: "AirLink" },
    access: "read",
    workspaceId,
  });
  const writers = new Map<
    string,
    { id: string; name: string; seenAtMs: number; messages: number }
  >();
  for (const message of connection.document
    ? readMessages(connection.document)
    : []) {
    if (message.actor.kind === "human") {
      writers.set(message.actor.id, {
        id: message.actor.id,
        name: message.actor.name,
        seenAtMs: message.ts,
        messages: (writers.get(message.actor.id)?.messages ?? 0) + 1,
      });
    }
  }
  await connection.disconnect();
  return [...writers.values()];
};

// The workspace's people include everyone who has written in a channel, not only whoever has
// opened AirLink since people were recorded; each channel's history is read once at start.
// ponytail: one pass over every chat at boot; read incrementally when channels hold years of it.
for (const channel of await store.listChannels()) {
  await store.rememberPeople(await chatWriters(channel.chatDoc));
}
// Channels from before membership keep who they had: everyone who wrote there, and every agent.
for (const channel of predatingMembers) {
  await store.addMembers(
    channel.id,
    [
      ...(await chatWriters(channel.chatDoc)).map((writer) => ({
        kind: "human" as const,
        id: writer.id,
      })),
      ...files
        .agents()
        .map((agent) => ({ kind: "agent" as const, id: agent.id })),
    ],
    "airlink"
  );
}
const untouched = async (docName: string) => {
  const connection = await live.hocuspocus.openDirectConnection(docName, {
    actor: { kind: "human", id: "airlink", name: "AirLink" },
    access: "read",
    workspaceId,
  });
  const empty = (connection.document?.store.clients.size ?? 0) === 0;
  await connection.disconnect();
  return empty;
};
const liveUrl = `http://127.0.0.1:${livePort}`;

const browserProxy = browserProvider
  ? createPinningProxy({
      onRefused: (host) =>
        logger.warn({ host }, "airlink: browser proxy refused a connection"),
    }).listen(config.browserProxyPort, "0.0.0.0")
  : null;

const mcp = serveRoomMcp();
await mcp.listen();
const postSystemNote = async (chatDoc: string, text: string) => {
  await createLiveAgentClient({
    baseUrl: liveUrl,
    docName: chatDoc,
    token: signLiveToken(
      { actor: systemActor, workspaceId, docName: chatDoc, access: "write" },
      secret
    ),
  }).chatOps({ ops: [{ type: "post_message", text }] });
};
const runner = createRunner({
  store,
  control: config.runner ? controlClient(config.runner) : null,
  writeState: docStateWriter(live.hocuspocus),
  postNote: postSystemNote,
  callTool: async (input) =>
    bridge
      ? bridge.callTool({ ...input, workspaceId })
      : { ok: false, text: "The agents are not ready yet." },
  logger: logger.child({ part: "runner" }),
});
await runner.start();
const room = createRoom({
  store,
  liveUrl,
  jwtSecret: secret,
  runner,
  searchIndex,
  briefs,
});
let detected = await detectHarnesses();

const kept = keptHarnesses();
const queues = new Map<string, Promise<void>>();

// Saves arrive one after another; each rebuild waits for the last so the newest settings win.
let rebuilding: Promise<void> = Promise.resolve();
const rebuild = () => {
  rebuilding = rebuilding.then(build, build);
  return rebuilding;
};
const build = async () => {
  const settings = files.settings();
  const { harnesses, error } = await harnessesFor({
    settings,
    envApiKeys: config.envApiKeys,
    detected,
    mcp,
    cwd: config.dataDir,
    kept,
  });
  decide = await decideFor(settings, config.envApiKeys);
  bridge = createBridge({
    liveUrl,
    jwtSecret: secret,
    agents: files.agents(),
    decide,
    harnesses,
    room,
    memoryRoot: memoryRootOf(settings),
    queues,
    logger: logger.child({ part: "bridge" }),
  });
  logger.info(
    { harnesses: Object.keys(harnesses), error },
    "airlink: agents ready"
  );
};
await rebuild();

const voiceKeys = () => {
  const settings = files.settings();
  return {
    elevenlabs:
      settings.speech.elevenLabsApiKey || config.envApiKeys.elevenlabs || null,
    cartesia:
      settings.speech.cartesiaApiKey || config.envApiKeys.cartesia || null,
    deepgram:
      settings.speech.deepgramApiKey || config.envApiKeys.deepgram || null,
    openai: settings.keys.openai || config.envApiKeys.openai || null,
    anthropic: settings.keys.anthropic || config.envApiKeys.anthropic || null,
  };
};

const writeTranscriptLine = async (
  callDoc: string,
  actor: VoiceActor,
  line: TranscriptRequest
) => {
  const token = signLiveToken(
    { actor, workspaceId, docName: callDoc, access: "write" },
    secret
  );
  const response = await fetch(
    `${liveUrl}/v1/docs/${encodeURIComponent(callDoc)}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(line),
    }
  );
  if (!response.ok) {
    logger.error(
      { callDoc, status: response.status },
      "voice: transcript write failed"
    );
  }
};

const chatDocOfCall = async (callDoc: string) =>
  (await room.chatDocOf(callDoc)) ?? callDoc;

const voice =
  config.liveKit && mediaTokens
    ? createVoice(
        {
          liveKitUrl: config.liveKit.url,
          mintToken: (grant, roomName) =>
            mediaTokens.mint({
              room: roomName,
              actor: {
                kind: grant.identity.startsWith("agent:") ? "agent" : "human",
                id: grant.identity,
                name: grant.name,
              },
              canPublish: !grant.hidden,
              canSubscribe: grant.hidden,
              hidden: grant.hidden,
            }),
          keys: voiceKeys,
          talkerModel: () => files.settings().model,
        },
        {
          agentsIn: async (callDoc) => {
            const chatDoc = await room.chatDocOf(callDoc);
            const ids = chatDoc ? await room.agentIdsOf?.(chatDoc) : null;
            return files
              .agents()
              .filter((agent) => !ids || ids.includes(agent.id));
          },
          route: async (text, agents, callDoc) =>
            (await room.taggedOnly?.(await chatDocOfCall(callDoc)))
              ? agentsNamedIn(text, agents).map((agent) => agent.id)
              : routeSpoken(text, agents, { decide }),
          work: async (agent, callDoc, task) =>
            bridge
              ? bridge.work({
                  agent,
                  chatDoc: await chatDocOfCall(callDoc),
                  workspaceId,
                  task,
                })
              : `${agent.name} is not ready yet.`,
          postToChat: async (agent, callDoc, text) => {
            await bridge?.post({
              agent,
              chatDoc: await chatDocOfCall(callDoc),
              workspaceId,
              text,
            });
          },
          writeLine: (callDoc, actor, line) =>
            writeTranscriptLine(callDoc, actor, {
              ...line,
              final: true,
              turn: false,
            }),
          postNotice: async (callDoc, text) =>
            postSystemNote(await chatDocOfCall(callDoc), text),
          voiceCatalog: async () => (await voicesFor(voiceKeys())).voices,
          logger: logger.child({ part: "voice" }),
        }
      )
    : null;

const handleApi = createApi({
  store,
  allowedHosts: ["localhost", "127.0.0.1", "[::1]", config.host],
  secret,
  liveUrl,
  livePort,
  agents: files.agents,
  saveAgents: files.saveAgents,
  settings: () => publicSettings(files.settings(), config.envApiKeys),
  saveSettings: (input) => {
    const result = files.saveSettings(input);
    return result.ok
      ? {
          ok: true,
          settings: publicSettings(result.settings, config.envApiKeys),
        }
      : result;
  },
  models: () => availableModels(files.settings(), config.envApiKeys),
  draftInstructions: (agent) =>
    draftInstructions(files.settings(), config.envApiKeys, agent),
  memoryOf: (agent) => agentMemory(memoryRootOf(files.settings()), agent),
  chatWriters,
  indexFile: (object) =>
    searchIndex
      .indexFile(object)
      .catch((err) =>
        logger.error(
          { err, docName: object.docName },
          "airlink: file index failed"
        )
      ),
  harnesses: async () => {
    detected = await detectHarnesses();
    return detected;
  },
  untouched,
  transcribeToken: () =>
    scribeTokenFor(files.settings(), config.envApiKeys.elevenlabs),
  logger,
  voice: {
    isAvailable: () => voice?.isAvailable() ?? false,
    join: async (callDoc, person) => voice?.join(callDoc, person),
    leave: async (callDoc, identity) => voice?.leave(callDoc, identity),
    voices: () => voicesFor(voiceKeys()),
    preview: (voiceId, speed) => previewVoice(voiceKeys(), voiceId, speed),
  },
  runner,
  onConfigChanged: () => {
    void rebuild().catch((err) =>
      logger.error({ err }, "airlink: rebuilding the agents failed")
    );
  },
});

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

// In development Vite serves the web app from the same port; the dynamic import keeps Vite, a
// dev dependency, out of production.
const vite = config.production
  ? null
  : await (await import("vite")).createServer({
      root: appRoot,
      // Loads vite.config.ts without a temp file, which node --watch would take for a change.
      configLoader: "runner",
      server: { middlewareMode: true },
      appType: "spa",
    });

const distDir = join(appRoot, "dist");
const serveBuilt = async (path: string) => {
  const file = normalize(join(distDir, path));
  const inside = file.startsWith(distDir) && extname(file) !== "";
  const body = await readFile(
    inside ? file : join(distDir, "index.html")
  ).catch(() => readFile(join(distDir, "index.html")));
  return {
    body,
    type:
      contentTypes[inside ? extname(file) : ".html"] ??
      "application/octet-stream",
  };
};

const server = createServer((request, response) => {
  handleApi(request, response)
    .then(async (handled) => {
      if (handled) {
        return;
      }
      if (vite) {
        vite.middlewares(request, response);
        return;
      }
      const { body, type } = await serveBuilt(
        new URL(request.url ?? "/", "http://airlink").pathname
      );
      response.writeHead(200, { "Content-Type": type });
      response.end(body);
    })
    .catch((err) => {
      logger.error({ err, url: request.url }, "airlink: request failed");
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      response.end(JSON.stringify({ error: "Something went wrong." }));
    });
});

server.listen(config.port, config.host, () => {
  logger.info(
    {
      url: `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`,
      livePort,
    },
    "airlink: open this in two browsers"
  );
  if (config.host !== "127.0.0.1" && config.host !== "localhost") {
    logger.warn(
      { host: config.host },
      "airlink: listening beyond this machine; anyone who can reach it can join under any name"
    );
  }
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info({ signal }, "airlink: shutting down");
  server.close();
  browserProxy?.close();
  await vite?.close();
  closeKept(kept);
  mcp.close();
  runner.close();
  await voice?.close();
  await live.destroy();
  await pool.end();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(signal));
}
