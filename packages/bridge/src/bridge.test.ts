import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentConfig } from "@memo-air/agents";
import { agentConfigSchema } from "@memo-air/agents";
import type { Decide } from "@memo-air/decide";
import { noOpinion } from "@memo-air/decide";
import { verifyLiveToken } from "@memo-air/protocol/tokens";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeRoom, BridgeTool, BridgeTurn } from "./index.ts";
import {
  acpHarness,
  createBridge,
  detectHarnesses,
  piDecide,
  piHarness,
  serveRoomMcp,
} from "./index.ts";

const jwtSecret = "bridge-test-secret";

type Call = {
  docName: string;
  route: string;
  actor: string;
  access: string;
  body: unknown;
};

const calls: Call[] = [];
let chatLog: unknown[] = [];
let server: Server;
let liveUrl = "";

const sheet = {
  range: "A1:B1",
  rowCount: 1,
  colCount: 2,
  columns: [],
  rows: [
    {
      row: 1,
      cells: [
        { cell: "A1", input: "Total", value: "Total", editor: null },
        { cell: "B1", input: "=2+3", value: 5, editor: null },
      ],
    },
  ],
  suggestions: [],
};

// Stands in for live-server: answers the two routes the test drives and records who called
// them with which token.
beforeAll(async () => {
  server = createServer((req, res) => {
    const match = /^\/v1\/docs\/([^/]+)\/([a-z-]+)/.exec(req.url ?? "");
    const claims = verifyLiveToken(
      (req.headers.authorization ?? "").replace("Bearer ", ""),
      jwtSecret
    );
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!match || !claims) {
        res.writeHead(401).end();
        return;
      }
      const parsed = body ? JSON.parse(body) : null;
      // The typing heartbeat is timing, not behaviour; the assertions below are about the work.
      if (parsed?.ops?.[0]?.type === "typing") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ results: [{ ok: true, id: "" }] }));
        return;
      }
      // Every turn reads the latest messages; that read is context, not what a test asserts.
      if (match[2] === "chat") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ messages: chatLog }));
        return;
      }
      calls.push({
        docName: decodeURIComponent(match[1]),
        route: match[2],
        actor: claims.actor.id,
        access: claims.access,
        body: parsed,
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          match[2] === "sheet"
            ? sheet
            : match[2] === "space"
              ? { objects: [spaceWindow] }
              : match[2] === "speak"
                ? { id: "l1", spoken: "clients" }
                : { results: [{ ok: true, id: "m2" }], suggestionId: null }
        )
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  liveUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

const agent = (overrides: Partial<AgentConfig>): AgentConfig =>
  agentConfigSchema.parse({ id: "pi", name: "Pi", ...overrides });

const spaceWindow = {
  id: "win1",
  docName: "ldoc_s",
  kind: "sheet",
  title: "Q3",
  x: 0,
  y: 0,
  w: 720,
  h: 480,
  z: 1,
  state: "open",
  by: { kind: "human", id: "hana", name: "Hana" },
};

const room: BridgeRoom = {
  chatDocOf: async (docName) => (docName === "ldoc_s" ? "chat1" : docName),
  objectsOf: async () => [{ id: "ldoc_s", title: "Q3", kind: "sheet" }],
  createObject: async () => ({ ok: false, text: "not in this test" }),
};

const logger = { info: () => {}, error: () => {} };

const messageTurn = (text: string, mentions: string[] = []): BridgeTurn => ({
  docName: "chat1",
  workspaceId: "w1",
  event: {
    type: "message",
    actor: { kind: "human", id: "hana", name: "Hana" },
    payload: {
      messageId: "m1",
      text,
      mentions: mentions.map((id) => ({ kind: "agent", id, name: id })),
    },
    summary: text,
  },
  decision: null,
});

describe("createBridge with Pi", () => {
  it("answers a mentioned message with the room's tools and posts the reply in the agent's name", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_live_sheet", { doc_id: "ldoc_s" }),
        {
          stopReason: "toolUse",
        }
      ),
      fauxAssistantMessage(fauxText("B1 totals 5.")),
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({}), agent({ id: "other", name: "Other" })],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });

    await bridge.onTurn(messageTurn("@Pi what is the total?", ["pi"]));

    expect(calls).toEqual([
      {
        docName: "ldoc_s",
        route: "sheet",
        actor: "pi",
        access: "read",
        body: null,
      },
      {
        docName: "chat1",
        route: "chat-ops",
        actor: "pi",
        access: "write",
        body: { ops: [{ type: "post_message", text: "B1 totals 5." }] },
      },
    ]);
  });

  it("runs code through the host in a runner of this room only, and schedules it", async () => {
    calls.length = 0;
    const ran: unknown[] = [];
    const scheduled: unknown[] = [];
    const results: string[] = [];
    const lastResult = (context: TranscriptContext) =>
      JSON.stringify(context.messages.at(-1)?.content);
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("run_code", {
          language: "python",
          code: "print(1)",
          title: "Q3",
        }),
        { stopReason: "toolUse" }
      ),
      (context) => {
        results.push(lastResult(context));
        return fauxAssistantMessage(
          fauxToolCall("run_code", {
            language: "python",
            code: "print(2)",
            title: "Q3",
            runner_id: "ldoc_s",
          }),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        results.push(lastResult(context));
        return fauxAssistantMessage(
          fauxToolCall("schedule_runner", {
            runner_id: "runner_1",
            refresh_minutes: 5,
          }),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        results.push(lastResult(context));
        return fauxAssistantMessage(fauxText("It refreshes every 5 minutes."));
      },
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room: {
        ...room,
        objectsOf: async () => [
          { id: "ldoc_s", title: "Q3", kind: "sheet" },
          { id: "runner_1", title: "Q3", kind: "runner" },
        ],
        runCode: async ({ language, code, title, runnerId }) => {
          ran.push({ language, code, title, runnerId });
          return { ok: true, text: 'Runner runner_1 ("Q3"): ok, exit code 0.' };
        },
        scheduleRunner: async ({ runnerId, refreshMinutes }) => {
          scheduled.push({ runnerId, refreshMinutes });
          return { ok: true, text: "The runner re-runs every 5 minutes." };
        },
      },
      logger,
    });

    await bridge.onTurn(messageTurn("@Pi chart Q3 and keep it fresh", ["pi"]));

    expect(ran).toEqual([
      { language: "python", code: "print(1)", title: "Q3", runnerId: null },
    ]);
    expect(scheduled).toEqual([{ runnerId: "runner_1", refreshMinutes: 5 }]);
    expect(results[0]).toContain("Runner runner_1");
    expect(results[1]).toContain("No runner ldoc_s is in this room.");
    expect(results[2]).toContain("re-runs every 5 minutes");
  });

  it("offers the code tools only when the host can run code", async () => {
    const seen: string[] = [];
    const faux = createFauxCore({});
    // The model's context carries every tool declaration it was given.
    const capture = (context: TranscriptContext) => {
      seen.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText("ok"));
    };
    faux.setResponses([capture, capture]);
    const build = (canRun: boolean) =>
      createBridge({
        liveUrl,
        jwtSecret,
        agents: [agent({})],
        decide: noOpinion,
        harnesses: {
          pi: piHarness({
            model: faux.getModel(),
            streamFn: faux.streamSimple,
          }),
        },
        room: canRun
          ? {
              ...room,
              runCode: async () => ({ ok: true, text: "" }),
              scheduleRunner: async () => ({ ok: true, text: "" }),
            }
          : room,
        logger,
      });
    await build(false).onTurn(messageTurn("@Pi hello", ["pi"]));
    await build(true).onTurn(messageTurn("@Pi hello", ["pi"]));
    expect(seen[0]).not.toContain("run_code");
    expect(seen[1]).toContain("run_code");
    expect(seen[1]).toContain("schedule_runner");
  });

  it("keeps the conversation when a host rebuilds Pi on new settings with the same sessions", async () => {
    calls.length = 0;
    const sessions = new Map();
    const faux = createFauxCore({});
    let seen = "";
    faux.setResponses([
      fauxAssistantMessage(fauxText("first")),
      (context) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText("second"));
      },
    ]);
    const build = () =>
      createBridge({
        liveUrl,
        jwtSecret,
        agents: [agent({})],
        decide: noOpinion,
        harnesses: {
          pi: piHarness({
            model: faux.getModel(),
            streamFn: faux.streamSimple,
            sessions,
          }),
        },
        room,
        logger,
      });
    await build().onTurn(messageTurn("@Pi one", ["pi"]));
    await build().onTurn(messageTurn("@Pi two", ["pi"]));
    expect(seen).toContain('"first"');
  });

  it("refuses an object outside the room without calling live-server", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    let toolResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_live_sheet", { doc_id: "ldoc_elsewhere" }),
        {
          stopReason: "toolUse",
        }
      ),
      (context) => {
        const last = context.messages.at(-1);
        toolResult =
          last?.role === "toolResult"
            ? last.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("")
            : "";
        return fauxAssistantMessage(fauxText("I cannot reach that sheet."));
      },
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    await bridge.onTurn(messageTurn("@Pi read the other sheet", ["pi"]));
    expect(toolResult).toBe("No live sheet ldoc_elsewhere is in this room.");
    expect(calls.map((call) => call.route)).toEqual(["chat-ops"]);
  });

  it("runs two messages for one agent in order, and tells an unsure default so", async () => {
    calls.length = 0;
    const prompts: string[] = [];
    const faux = createFauxCore({});
    const answer =
      (text: string) =>
      (context: { messages: { role: string; content: unknown }[] }) => {
        const last = context.messages.at(-1);
        prompts.push(
          typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content)
        );
        return fauxAssistantMessage(fauxText(text));
      };
    faux.setResponses([answer("first"), answer("second")]);
    const unsureDecide: Decide = async () => ({
      provider: "fake",
      ms: 1,
      answers: { agent: { type: "choice", choice: "pi", confidence: 0.3 } },
    });
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({}), agent({ id: "other", name: "Other" })],
      decide: unsureDecide,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    await Promise.all([
      bridge.onTurn(messageTurn("one")),
      bridge.onTurn(messageTurn("two")),
    ]);
    expect(
      calls.map(
        (call) => (call.body as { ops: { text: string }[] }).ops[0].text
      )
    ).toEqual(["first", "second"]);
    expect(prompts[0]).toContain(
      "The room was not sure this was meant for you."
    );
  });

  it("reads an uploaded file through the host, and only a file in this room", async () => {
    calls.length = 0;
    const read: string[] = [];
    const results: string[] = [];
    const faux = createFauxCore({});
    const toolResult = (context: {
      messages: { role: string; content: unknown }[];
    }) => {
      results.push(JSON.stringify(context.messages.at(-1)?.content));
      return fauxAssistantMessage(fauxText("Acme renews in March."));
    };
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_live_file", { doc_id: "ldoc_s" }),
        {
          stopReason: "toolUse",
        }
      ),
      (context) => {
        results.push(JSON.stringify(context.messages.at(-1)?.content));
        return fauxAssistantMessage(
          fauxToolCall("read_live_file", { doc_id: "file_1" }),
          { stopReason: "toolUse" }
        );
      },
      toolResult,
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room: {
        ...room,
        objectsOf: async () => [
          { id: "ldoc_s", title: "Q3", kind: "sheet" },
          { id: "file_1", title: "contract.pdf", kind: "file" },
        ],
        readFile: async (docName) => {
          read.push(docName);
          return { ok: true, text: "Acme renews in March" };
        },
      },
      logger,
    });

    await bridge.onTurn(messageTurn("@Pi when does Acme renew?", ["pi"]));

    expect(read).toEqual(["file_1"]);
    expect(results[0]).toContain("No file ldoc_s is in this room.");
    expect(results[1]).toContain("Acme renews in March");
  });

  it("starts a turn from the channel's latest messages and finds older ones by search", async () => {
    const said = (id: string, name: string, text: string, ts: number) => ({
      id,
      actor: { kind: "human", id: name.toLowerCase(), name },
      text,
      mentions: [],
      attachments: [],
      ts,
      reactions: {},
    });
    chatLog = [
      said("m0", "Lin", "Acme wants net 45 on invoices", 1),
      ...Array.from({ length: 6 }, (_, i) =>
        said(`r${i}`, "Lin", `chatter ${i}`, 10 + i)
      ),
      said("m1", "Hana", "@Pi what terms did Acme want?", 20),
    ];
    const contexts: string[] = [];
    const searched: string[] = [];
    const faux = createFauxCore({});
    const record = (context: { messages: { content: unknown }[] }) =>
      contexts.push(JSON.stringify(context.messages.at(-1)?.content));
    faux.setResponses([
      (context) => {
        record(context);
        return fauxAssistantMessage(
          fauxToolCall("search_room", { query: "acme terms" }),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        record(context);
        return fauxAssistantMessage(
          fauxToolCall("read_chat", { around_id: "m0", limit: 2 }),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        record(context);
        return fauxAssistantMessage(fauxText("Net 45."));
      },
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room: {
        ...room,
        searchRoom: async (_chatDoc, query) => {
          searched.push(query);
          return [
            {
              kind: "message",
              source: "m0",
              part: 0,
              title: "Lin",
              atMs: 1,
              excerpt: "**Acme** wants net 45",
            },
          ];
        },
      },
      logger,
    });

    await bridge.onTurn(messageTurn("@Pi what terms did Acme want?", ["pi"]));
    chatLog = [];

    expect(contexts[0]).toContain("[r5] Lin: chatter 5");
    expect(contexts[0]).toContain("[r1] Lin: chatter 1");
    expect(contexts[0]).not.toContain("chatter 0");
    expect(contexts[0]).not.toContain("[m1]");
    expect(searched).toEqual(["acme terms"]);
    expect(contexts[1]).toContain("message m0 by Lin");
    expect(contexts[2]).toContain("[m0] Lin: Acme wants net 45 on invoices");
    expect(contexts[2]).toContain("[r0] Lin: chatter 0");
  });

  it("leaves a message addressed only to a person to that person", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxText("I'll take it."))]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    const turn = messageTurn("@Lin can you check this?");
    await bridge.onTurn({
      ...turn,
      event: {
        ...turn.event,
        payload: {
          messageId: "m1",
          text: "@Lin can you check this?",
          mentions: [{ kind: "human", id: "lin", name: "Lin" }],
        },
      },
    });
    expect(calls).toEqual([]);
  });

  it("leaves an unnamed message unanswered in a channel whose agents answer only when tagged", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxText("Hello!"))]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room: { ...room, taggedOnly: async () => true },
      logger,
    });
    await bridge.onTurn(messageTurn("hi"));
    expect(calls).toEqual([]);
  });

  it("answers a line said in a call in the channel's chat, only by the agent it names", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxText("It totals five."))]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({}), agent({ id: "other", name: "Other" })],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    const spoken = (text: string): BridgeTurn => ({
      docName: "ldoc_s",
      workspaceId: "w1",
      event: {
        type: "spoken",
        actor: { kind: "human", id: "hana", name: "Hana" },
        payload: { text },
        summary: text,
      },
      decision: null,
    });

    await bridge.onTurn(spoken("so we ship on friday"));
    await bridge.onTurn(spoken("Pi, what is the total?"));

    expect(calls).toEqual([
      {
        docName: "chat1",
        route: "chat-ops",
        actor: "pi",
        access: "write",
        body: { ops: [{ type: "post_message", text: "It totals five." }] },
      },
    ]);
  });

  it("mints a suggest token when the agent's access is suggest", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("edit_live_sheet", {
          doc_id: "ldoc_s",
          mode: "edit",
          ops: [{ type: "set_range", range: "C1", values: [["7"]] }],
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxText("Proposed C1.")),
    ]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({ access: "suggest" })],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    await bridge.onTurn(messageTurn("@Pi set C1 to 7", ["pi"]));
    expect(calls.find((call) => call.route === "sheet-ops")?.access).toBe(
      "suggest"
    );
  });

  it("runs a voice's task on the agent's harness, posts the result in chat and returns it", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxText("Q3 is in the sheet."))]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    const result = await bridge.work({
      agent: agent({}),
      chatDoc: "chat1",
      workspaceId: "w1",
      task: "pull Q3 into the sheet",
    });
    expect(result).toBe("Q3 is in the sheet.");
    expect(calls.at(-1)).toMatchObject({
      docName: "chat1",
      route: "chat-ops",
      body: { ops: [{ type: "post_message", text: "Q3 is in the sheet." }] },
    });
  });

  it("runs a voice's task and a chat turn for the same agent one after the other", async () => {
    calls.length = 0;
    const runs: string[] = [];
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: {
          run: async ({ prompt }) => {
            const kind = prompt.startsWith("Someone asked you in the call")
              ? "work"
              : "turn";
            runs.push(`${kind} start`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            runs.push(`${kind} end`);
            return kind;
          },
        },
      },
      room,
      logger,
    });
    const [result] = await Promise.all([
      bridge.work({
        agent: agent({}),
        chatDoc: "chat1",
        workspaceId: "w1",
        task: "pull Q3 into the sheet",
      }),
      bridge.onTurn(messageTurn("and the totals?", ["pi"])),
    ]);
    expect(result).toBe("work");
    expect(runs).toEqual(["work start", "work end", "turn start", "turn end"]);
  });

  it("posts a line in chat in the agent's name without running its harness", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    await bridge.post({
      agent: agent({}),
      chatDoc: "chat1",
      workspaceId: "w1",
      text: "Q3 is in the sheet.",
    });
    expect(calls).toEqual([
      {
        docName: "chat1",
        route: "chat-ops",
        actor: "pi",
        access: "write",
        body: { ops: [{ type: "post_message", text: "Q3 is in the sheet." }] },
      },
    ]);
  });

  it("answers a spoken line in chat, never through the call, when no voice is running", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxText("Four."))]);
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    });
    await bridge.onTurn({
      ...messageTurn("Pi, two plus two?"),
      event: {
        type: "spoken",
        actor: { kind: "human", id: "hana", name: "Hana" },
        payload: { text: "Pi, two plus two?" },
        summary: "Pi, two plus two?",
      },
    });
    expect(calls.map((call) => call.route)).toEqual(["chat-ops"]);
  });
});

// The model's last step echoes the tool result it got, so the posted reply shows what the tool said.
const echoToolResult = (context: TranscriptContext) => {
  const result = context.messages.findLast(
    (message) => message.role === "toolResult"
  );
  return fauxAssistantMessage(
    fauxText(
      result?.role === "toolResult"
        ? result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("")
        : "no tool result"
    )
  );
};

const answering =
  (noul: number): Decide =>
  async () => ({
    provider: "test",
    ms: 0,
    answers: { remember: { type: "noul", noul } },
  });

describe("createBridge memory", () => {
  const memoryBridge = ({
    memoryRoot,
    agents,
    decide,
    toolCall,
  }: {
    memoryRoot: string;
    agents: AgentConfig[];
    decide: Decide;
    toolCall: ReturnType<typeof fauxToolCall>;
  }) => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
      echoToolResult,
    ]);
    return createBridge({
      liveUrl,
      jwtSecret,
      agents,
      decide,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
      memoryRoot,
    });
  };

  const lastReply = () => {
    const body = calls.at(-1)?.body;
    return JSON.stringify(body);
  };

  const remembered = fauxToolCall("remember", {
    type: "fact",
    title: "Acme price",
    body: "Acme quoted 1,200 per seat.",
  });
  const recall = fauxToolCall("recall_memory", { query: "acme" });

  it("keeps what an agent remembers in its own folder, across bridges, and from other agents", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "bridge-memory-"));
    const agents = [agent({}), agent({ id: "other", name: "Other" })];
    calls.length = 0;
    await memoryBridge({
      memoryRoot,
      agents,
      decide: answering(0.9),
      toolCall: remembered,
    }).onTurn(messageTurn("@Pi remember the Acme price", ["pi"]));
    expect(lastReply()).toContain("Remembered as acme-price.");
    expect(
      readFileSync(join(memoryRoot, "pi", "acme-price.md"), "utf8")
    ).toContain("resource: room:chat1");

    await memoryBridge({
      memoryRoot,
      agents,
      decide: noOpinion,
      toolCall: recall,
    }).onTurn(messageTurn("@Pi what did Acme quote?", ["pi"]));
    expect(lastReply()).toContain("Acme quoted 1,200 per seat.");

    await memoryBridge({
      memoryRoot,
      agents,
      decide: noOpinion,
      toolCall: recall,
    }).onTurn(messageTurn("@Other what did Acme quote?", ["other"]));
    expect(lastReply()).toContain('Nothing you remember matches \\"acme\\"');
  });

  it("shares memory between agents given one folder", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "bridge-memory-"));
    const agents = [
      agent({ memoryDir: "team" }),
      agent({ id: "other", name: "Other", memoryDir: "team" }),
    ];
    await memoryBridge({
      memoryRoot,
      agents,
      decide: answering(0.9),
      toolCall: remembered,
    }).onTurn(messageTurn("@Pi remember", ["pi"]));
    await memoryBridge({
      memoryRoot,
      agents,
      decide: noOpinion,
      toolCall: recall,
    }).onTurn(messageTurn("@Other recall", ["other"]));
    expect(lastReply()).toContain("Acme quoted 1,200 per seat.");
  });

  it("saves nothing the room judges short-lived, and saves when the decision fails", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "bridge-memory-"));
    const agents = [agent({})];
    await memoryBridge({
      memoryRoot,
      agents,
      decide: answering(0.2),
      toolCall: remembered,
    }).onTurn(messageTurn("@Pi remember", ["pi"]));
    expect(lastReply()).toContain(
      "Not saved: the room judged this useful only"
    );
    expect(existsSync(join(memoryRoot, "pi"))).toBe(false);

    await memoryBridge({
      memoryRoot,
      agents,
      decide: noOpinion,
      toolCall: remembered,
    }).onTurn(messageTurn("@Pi remember", ["pi"]));
    expect(existsSync(join(memoryRoot, "pi", "acme-price.md"))).toBe(true);
  });

  it("offers no memory tools when the host gives no memory root", async () => {
    calls.length = 0;
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(recall, { stopReason: "toolUse" }),
      echoToolResult,
    ]);
    await createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room,
      logger,
    }).onTurn(messageTurn("@Pi recall", ["pi"]));
    expect(lastReply()).not.toContain("remember");
  });
});

describe("tool schemas", () => {
  it("serves every tool's parameters as draft 2020-12 JSON Schema, with no tuple anywhere", async () => {
    let served: BridgeTool[] = [];
    const bridge = createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: {
          run: async ({ tools }) => {
            served = tools;
            return "";
          },
        },
      },
      room,
      logger,
    });
    await bridge.onTurn(messageTurn("@Pi hi", ["pi"]));
    const all = JSON.stringify(served.map((tool) => tool.parameters));
    expect(served).toHaveLength(21);
    expect(all).not.toContain('"items":[');
    expect(all).not.toContain("$schema");
  });
});

describe("piDecide", () => {
  it("puts the questions to a chat model and reads its JSON onto the decision wire", async () => {
    const faux = createFauxCore({});
    const reply = fauxAssistantMessage(
      fauxText(
        '{"agent": {"choice": "pi", "confidence": 0.9}, "turn": {"probability": 0.7}, "odd": {"choice": "nobody-listed", "confidence": 1}}'
      )
    );
    const prompts: string[] = [];
    const decide = piDecide({
      models: {
        completeSimple: async (_model, context) => {
          const last = context.messages.at(-1);
          prompts.push(typeof last?.content === "string" ? last.content : "");
          return reply;
        },
      },
      model: faux.getModel(),
    });
    const decision = await decide({
      state: "hi",
      questions: {
        agent: {
          type: "choice",
          instructions: "who?",
          criteria: { pi: "Pi", none: "nobody" },
        },
        turn: { type: "noul", instructions: "act?" },
        odd: { type: "choice", instructions: "which?", criteria: { a: "A" } },
      },
    });
    expect(decision.answers).toEqual({
      agent: { type: "choice", choice: "pi", confidence: 0.9 },
      turn: { type: "noul", noul: 0.7 },
    });
    expect(prompts[0]).toContain("- pi: Pi");

    const failing = piDecide({
      models: {
        completeSimple: async () => {
          throw new Error("no key");
        },
      },
      model: faux.getModel(),
    });
    expect(await failing({ state: "hi", questions: {} })).toMatchObject({
      answers: null,
      error: "no key",
    });
  });
});

describe("createBridge with an ACP harness", () => {
  const fixture = fileURLToPath(
    new URL("./fixtures/fake-acp-agent.ts", import.meta.url)
  );
  const scratch = mkdtempSync(join(tmpdir(), "bridge-acp-"));

  const acpBridge = async (command: string[]) => {
    const mcp = serveRoomMcp();
    await mcp.listen();
    return {
      mcp,
      bridge: createBridge({
        liveUrl,
        jwtSecret,
        agents: [agent({ id: "fake", name: "Fake", harness: "fake" })],
        decide: noOpinion,
        harnesses: { fake: acpHarness({ command, mcp }) },
        room,
        logger,
      }),
    };
  };

  it("gives the harness the room's tools over MCP under the agent's token, and refuses its shell", async () => {
    calls.length = 0;
    const { bridge, mcp } = await acpBridge([process.execPath, fixture]);
    await bridge.onTurn(messageTurn("@Fake what is in Q3?", ["fake"]));
    mcp.close();
    expect(calls).toEqual([
      {
        docName: "ldoc_s",
        route: "sheet",
        actor: "fake",
        access: "read",
        body: null,
      },
      {
        docName: "chat1",
        route: "chat-ops",
        actor: "fake",
        access: "write",
        body: {
          ops: [
            {
              type: "post_message",
              text: 'saw: Live sheet "Q3" (ldoc_s): 1 rows × 2 columns, showing A1:B1. | shell: reject',
            },
          ],
        },
      },
    ]);
  }, 20_000);

  it("says the agent stopped when its harness dies mid-turn, keeps what it did, and restarts it", async () => {
    calls.length = 0;
    const { bridge, mcp } = await acpBridge([
      process.execPath,
      fixture,
      `--exit-once=${join(scratch, "exited")}`,
    ]);
    await bridge.onTurn(messageTurn("@Fake read Q3", ["fake"]));
    expect(calls.map((call) => [call.route, call.actor])).toEqual([
      ["sheet", "fake"],
      ["chat-ops", "fake"],
    ]);
    expect(calls[1].body).toEqual({
      ops: [{ type: "post_message", text: "Fake stopped before finishing." }],
    });

    calls.length = 0;
    await bridge.onTurn(messageTurn("@Fake try again", ["fake"]));
    mcp.close();
    expect(calls.map((call) => call.route)).toEqual(["sheet", "chat-ops"]);
    expect(JSON.stringify(calls[1].body)).toContain("saw: Live sheet");
  }, 20_000);
});

describe("detectHarnesses", () => {
  it("offers a harness only when its CLI is on the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-path-"));
    writeFileSync(join(dir, "gemini"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(dir, "codex"), "not executable", { mode: 0o644 });
    expect(await detectHarnesses(dir)).toEqual([
      { id: "gemini", name: "Gemini CLI", command: ["gemini", "--acp"] },
    ]);
  });
});

describe("createBridge windows", () => {
  it("lets an agent close every window to the desktop and lists what is left", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("arrange_windows", {
          actions: [{ id: "all", action: "close" }],
        }),
        { stopReason: "toolUse" }
      ),
      echoToolResult,
    ]);
    calls.length = 0;
    await createBridge({
      liveUrl,
      jwtSecret,
      agents: [agent({})],
      decide: noOpinion,
      harnesses: {
        pi: piHarness({ model: faux.getModel(), streamFn: faux.streamSimple }),
      },
      room: { ...room, spaceDocOf: async () => "space1" },
      logger,
    }).onTurn(messageTurn("@Pi close all the windows", ["pi"]));
    expect(calls.find((call) => call.route === "space-ops")?.body).toEqual({
      ops: [{ type: "remove", id: "win1" }],
    });
    expect(JSON.stringify(calls.at(-1)?.body)).toContain(
      "Applied 1 of 1 changes."
    );
  });
});
