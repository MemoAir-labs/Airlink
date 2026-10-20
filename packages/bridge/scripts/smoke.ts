import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createLiveAgentClient } from "@memo-air/agent";
import type { AgentConfig } from "@memo-air/agents";
import { noOpinion } from "@memo-air/decide";
import { signLiveToken } from "@memo-air/protocol/tokens";

import type { BridgeTurn, Harness } from "../src/index.ts";
import {
  acpHarness,
  createBridge,
  detectHarnesses,
  piHarness,
  serveRoomMcp,
} from "../src/index.ts";

// Drives the bridge against a running live-server with real models: a channel and a sheet, Pi
// asked to fill the sheet, and — when Claude Code is on PATH — Claude asked to read it back over
// ACP, then Pi asked to remember a contact and Claude to recall it from the folder they share. Needs LIVE_JWT_SECRET and ANTHROPIC_API_KEY; LIVE_URL defaults to the dev live-server.

const liveUrl = process.env.LIVE_URL ?? "http://localhost:3020";
const jwtSecret = process.env.LIVE_JWT_SECRET ?? "";
const modelId = process.env.PI_MODEL ?? "claude-haiku-5-5";
if (!jwtSecret || !process.env.ANTHROPIC_API_KEY) {
  process.stderr.write("Set LIVE_JWT_SECRET and ANTHROPIC_API_KEY.\n");
  process.exit(1);
}

const run = crypto.randomUUID().slice(0, 8);
const workspaceId = "airlink-smoke";
const chatDoc = `airlink-smoke-chat-${run}`;
const sheetDoc = `airlink-smoke-sheet-${run}`;
const say = (line: string) => process.stdout.write(`${line}\n`);

const seed = (docName: string) =>
  createLiveAgentClient({
    baseUrl: liveUrl,
    docName,
    token: signLiveToken(
      {
        actor: { kind: "agent", id: "smoke", name: "Smoke" },
        workspaceId,
        docName,
        access: "write",
      },
      jwtSecret
    ),
  });

await seed(sheetDoc).sheetOps({
  ops: [{ type: "set_range", range: "A1", values: [["Vendor", "Price"]] }],
});
await seed(chatDoc).chatOps({
  ops: [{ type: "post_message", text: "Smoke channel open." }],
});

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", modelId);
if (!model) {
  throw new Error(`pi-ai has no anthropic model ${modelId}`);
}
const mcp = serveRoomMcp();
await mcp.listen();
const claude = (await detectHarnesses()).find((found) => found.id === "claude");
const harnesses: Record<string, Harness> = {
  pi: piHarness({ model, streamFn: models.streamSimple.bind(models) }),
  ...(claude
    ? {
        claude: acpHarness({
          command: claude.command,
          cwd: mkdtempSync(join(tmpdir(), "airlink-smoke-")),
          mcp,
        }),
      }
    : {}),
};
const agents: AgentConfig[] = [
  {
    id: "pi",
    name: "Pi",
    role: "Fills in sheets and docs.",
    tags: [],
    access: "write",
    harness: "pi",

    memoryDir: "team",
  },
  ...(claude
    ? [
        {
          id: "claude",
          name: "Claude",
          role: "Reviews what is in the room.",
          tags: [],
          access: "write" as const,
          harness: "claude",
          memoryDir: "team",
        },
      ]
    : []),
];
const memoryRoot = mkdtempSync(join(tmpdir(), "airlink-smoke-memory-"));
const bridge = createBridge({
  memoryRoot,
  liveUrl,
  jwtSecret,
  agents,
  decide: noOpinion,
  harnesses,
  room: {
    chatDocOf: async () => chatDoc,
    objectsOf: async () => [{ id: sheetDoc, title: "Vendors", kind: "sheet" }],
    createObject: async () => ({
      ok: false,
      text: "Creating objects is not part of this smoke run.",
    }),
  },
  logger: {
    info: (obj, msg) => say(`  ${msg} ${JSON.stringify(obj)}`),
    error: (obj, msg) =>
      say(`  ${msg} ${String(Reflect.get(obj, "err") ?? JSON.stringify(obj))}`),
  },
});

const ask = async (text: string, agentId: string) => {
  const turn: BridgeTurn = {
    docName: chatDoc,
    workspaceId,
    event: {
      type: "message",
      actor: { kind: "human", id: "hana", name: "Hana" },
      payload: {
        messageId: crypto.randomUUID(),
        text,
        mentions: [{ kind: "agent", id: agentId, name: agentId }],
      },
      summary: text,
    },
    decision: null,
  };
  const startedAt = performance.now();
  await bridge.onTurn(turn);
  say(`${agentId}: ${Math.round(performance.now() - startedAt)} ms`);
};

await ask(
  "@Pi add three vendors with prices to the Vendors sheet, then a Total row with a SUM formula.",
  "pi"
);
if (claude) {
  await ask("@Claude read the Vendors sheet and tell me the total.", "claude");
}
await ask(
  "@Pi please remember for later: Acme's pricing contact is Dana Ruiz, dana@acme.test.",
  "pi"
);
if (claude) {
  await ask("@Claude who is Acme's pricing contact?", "claude");
}
mcp.close();
say(`[memory] ${readdirSync(join(memoryRoot, "team")).join(", ")}`);

const chat = await seed(chatDoc).readChat();
for (const message of chat.messages) {
  say(`[chat] ${message.actor.name}: ${message.text}`);
}
const sheet = await seed(sheetDoc).readSheet();
for (const row of sheet.rows) {
  say(
    `[sheet] ${row.cells.map((cell) => `${cell.cell}=${cell.input}`).join(" ")}`
  );
}
process.exit(0);
