import { HocuspocusProvider } from "@hocuspocus/provider";
import type {
  ActivityMessage,
  BrowserMessage,
  LiveAccess,
  MediaMessage,
} from "@memo-air/protocol";
import {
  activityMessageSchema,
  browserMessageSchema,
  mediaMessageSchema,
} from "@memo-air/protocol";
import {
  signLiveServiceToken,
  signLiveToken,
  signLiveWatchToken,
} from "@memo-air/protocol/tokens";
import ExcelJS from "exceljs";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createLiveAgentClient,
  fetchLiveSummaries,
} from "../../agent/src/index.ts";
import { readBrowserState, readVisits } from "../../browser/src/index.ts";
import {
  cdpEndpointProvider,
  nekoPoolProvider,
  parseNekoInstances,
} from "../../browser/src/session.ts";
import {
  canvasElements,
  canvasSuggestions,
  rejectCanvasSuggestion,
  writeLocalElements,
} from "../../canvas/src/index.ts";
import {
  editMessage,
  postMessage,
  readMessages,
} from "../../chat/src/index.ts";
import type { Decide } from "../../decide/src/index.ts";
import { readTranscript } from "../../media/src/index.ts";
import { createMediaTokens } from "../../media/src/server.ts";
import {
  acceptSuggestion,
  docFragment,
  readOutline,
  rejectSuggestion,
} from "../../richtext/src/index.ts";
import {
  readGrid,
  rejectSheetSuggestion,
  setRange,
  sheetSuggestions,
} from "../../sheet/src/index.ts";
import {
  deckSuggestions,
  readDeck,
  rejectSlideSuggestion,
  setElementByHand,
} from "../../slides/src/index.ts";
import { moveObject, readSpace, slotSize } from "../../space/src/index.ts";
import { createLiveServer } from "./index.ts";
import { createPersistence } from "./persistence.ts";
import type { Turn } from "./turns.ts";

const databaseUrl = process.env.TEST_LIVE_DATABASE_URI;
const jwtSecret = "test-secret";

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Date.now() - startedAt;
}

describe.skipIf(!databaseUrl)("live server", () => {
  const live = createLiveServer({
    databaseUrl: databaseUrl ?? "",
    jwtSecret,
    port: 0,
    logger: pino({ level: "silent" }),
  });
  const docName = `test:${crypto.randomUUID()}`;
  const providers: HocuspocusProvider[] = [];
  let url = "";

  const connect = async (id: string, access: LiveAccess) => {
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document: new Y.Doc(),
      token: signLiveToken(
        {
          actor: { kind: "human", id, name: id },
          workspaceId: "w1",
          docName,
          access,
        },
        jwtSecret
      ),
    });
    providers.push(provider);
    await waitFor(() => provider.synced);
    return provider;
  };

  beforeAll(async () => {
    const port = await live.listen();
    url = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const provider of providers) {
      provider.destroy();
    }
    await live.destroy();
  });

  it("serves /healthz", async () => {
    const response = await fetch(`${url.replace("ws", "http")}/healthz`);
    expect(await response.text()).toBe("ok");
  });

  it("fans out edits and awareness between writers", async () => {
    const a = await connect("ada", "write");
    const b = await connect("bob", "write");

    a.setAwarenessField("user", { name: "ada" });
    a.document.getText("t").insert(0, "hello");

    const elapsedMs = await waitFor(
      () => b.document.getText("t").toString() === "hello"
    );
    expect(elapsedMs).toBeLessThan(100);
    await waitFor(() =>
      [...(b.awareness?.getStates().values() ?? [])].some(
        (state) => state.user?.name === "ada"
      )
    );
  });

  it("serves /metrics with op, load and connection series", async () => {
    const response = await fetch(`${url.replace("ws", "http")}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("live_agent_op_ms_count");
    expect(body).toContain("live_fanout_ms_count");
    expect(body).toContain("live_connections 2");
  });

  it("drops updates from a read-only connection", async () => {
    const reader = await connect("rita", "read");
    await waitFor(() => reader.document.getText("t").toString() === "hello");

    reader.document.getText("t").insert(0, "XX");
    await new Promise((resolve) => setTimeout(resolve, 200));

    const serverDoc = live.hocuspocus.documents.get(docName);
    expect(serverDoc?.getText("t").toString()).toBe("hello");
  });

  it("rejects a token minted for another doc", async () => {
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document: new Y.Doc(),
      token: signLiveToken(
        {
          actor: { kind: "human", id: "eve", name: "eve" },
          workspaceId: "w1",
          docName: "other",
          access: "write",
        },
        jwtSecret
      ),
    });
    providers.push(provider);
    let failed = false;
    provider.on("authenticationFailed", () => {
      failed = true;
    });
    await waitFor(() => failed);
    expect(provider.synced).toBe(false);
  });

  it("persists edits with the writer as actor", async () => {
    await live.persistence.flush();
    const state = await live.persistence.load(docName);
    const reloaded = new Y.Doc();
    if (state) {
      Y.applyUpdate(reloaded, state);
    }
    expect(reloaded.getText("t").toString()).toBe("hello");

    const pool = new pg.Pool({ connectionString: databaseUrl });
    const updates = await pool.query(
      "SELECT DISTINCT actor->>'id' AS id FROM live_doc_updates WHERE doc_name = $1",
      [docName]
    );
    const joins = await pool.query(
      "SELECT DISTINCT actor->>'id' AS id FROM live_events WHERE doc_name = $1 AND type = 'join' ORDER BY id",
      [docName]
    );
    await pool.end();
    expect(updates.rows).toEqual([{ id: "ada" }]);
    expect(joins.rows).toEqual([{ id: "ada" }, { id: "bob" }, { id: "rita" }]);
  });

  describe("agent peer", () => {
    const agentDoc = `test:${crypto.randomUUID()}`;
    const token = (
      actor: { kind: "human" | "agent"; id: string; name: string },
      access: LiveAccess,
      name = agentDoc
    ) =>
      signLiveToken(
        { actor, workspaceId: "w1", docName: name, access },
        jwtSecret
      );
    const analyst = { kind: "agent" as const, id: "analyst", name: "Analyst" };
    const agentClient = (access: LiveAccess) =>
      createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: agentDoc,
        token: token(analyst, access),
      });

    it("streams an agent insert with a visible caret to a human", async () => {
      const human = new HocuspocusProvider({
        url,
        name: agentDoc,
        document: new Y.Doc(),
        token: token({ kind: "human", id: "hana", name: "hana" }, "write"),
      });
      providers.push(human);
      await waitFor(() => human.synced);

      let sawAgentCaret = false;
      human.awareness?.on("change", () => {
        sawAgentCaret ||= [
          ...(human.awareness?.getStates().values() ?? []),
        ].some((state) => state.user?.kind === "agent" && state.cursor);
      });

      const body = "z".repeat(80);
      const response = await agentClient("write").ops({
        ops: [
          { type: "insert", afterBlockId: null, markdown: `# Plan\n\n${body}` },
        ],
      });
      expect(response.results).toMatchObject([{ ok: true }]);
      expect(response.suggestionId).toBeNull();
      expect(sawAgentCaret).toBe(true);

      await waitFor(() =>
        readOutline(docFragment(human.document)).some(
          (block) => block.text === body
        )
      );
      expect(
        (await agentClient("read").outline()).blocks.map((b) => b.text)
      ).toEqual(["Plan", body]);
    });

    it("shows an agent reading to a human, and a re-read right after a write keeps its caret", async () => {
      const readDoc = `test:${crypto.randomUUID()}`;
      const reader = (access: LiveAccess) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: readDoc,
          token: token(analyst, access, readDoc),
        });
      const human = new HocuspocusProvider({
        url,
        name: readDoc,
        document: new Y.Doc(),
        token: token(
          { kind: "human", id: "hana", name: "hana" },
          "write",
          readDoc
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      const agentStates = () =>
        [...(human.awareness?.getStates().values() ?? [])].filter(
          (state) => state.user?.kind === "agent"
        );

      await reader("read").outline();
      await waitFor(() => agentStates().some((state) => state.reading));

      await reader("write").ops({
        ops: [{ type: "insert", afterBlockId: null, markdown: "Next step" }],
      });
      await waitFor(() => agentStates().some((state) => state.cursor));
      // Re-reading what it just wrote is still writing: the caret stays and "reading" does not.
      await reader("read").outline();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(agentStates().some((state) => state.cursor)).toBe(true);
      expect(agentStates().some((state) => state.reading)).toBe(false);
    });

    it("forces suggest mode for a suggest token and exports the accepted view", async () => {
      const client = agentClient("suggest");
      const response = await client.ops({
        ops: [{ type: "insert", afterBlockId: null, markdown: "Proposed" }],
        approver: "hana",
      });
      expect(response.suggestionId).toEqual(expect.any(String));
      const { suggestions } = await client.outline();
      expect(suggestions).toMatchObject([
        {
          id: response.suggestionId,
          kind: "insert",
          actorId: "analyst",
          approver: "hana",
        },
      ]);
      expect(await client.markdown()).toBe(`# Plan\n\n${"z".repeat(80)}`);
    });

    it("rejects ops from read tokens, humans and other docs", async () => {
      const post = (bearer: string) =>
        fetch(
          `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(agentDoc)}/ops`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${bearer}` },
            body: JSON.stringify({ ops: [{ type: "delete", blockId: "x" }] }),
          }
        );
      expect((await post(token(analyst, "read"))).status).toBe(403);
      expect(
        (await post(token({ kind: "human", id: "h", name: "h" }, "write")))
          .status
      ).toBe(403);
      expect((await post(token(analyst, "write", "other"))).status).toBe(401);
    });
  });

  describe("history, suggestion ledger and comments", () => {
    const doc = `test:${crypto.randomUUID()}`;
    let rejectedId = "";
    const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
    const hana = { kind: "human" as const, id: "hana", name: "Hana" };
    const clientFor = (actor: typeof juno | typeof hana, access: LiveAccess) =>
      createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: doc,
        token: signLiveToken(
          { actor, workspaceId: "w1", docName: doc, access },
          jwtSecret
        ),
      });
    const ledger = async (id: string) => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      const rows = await pool.query(
        "SELECT status, approver_id, settled_by->>'id' AS settled_by FROM live_suggestions WHERE id = $1",
        [id]
      );
      await pool.end();
      return rows.rows[0] ?? null;
    };
    const waitForAsync = async (check: () => Promise<boolean>) => {
      const startedAt = Date.now();
      while (!(await check())) {
        if (Date.now() - startedAt > 8000) {
          throw new Error("waitForAsync timed out");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    it("records suggestions, settles them by outcome, and summarises the doc", async () => {
      const agent = clientFor(juno, "write");
      await agent.ops({
        ops: [{ type: "insert", afterBlockId: null, markdown: "Price: $10." }],
      });
      const [price] = (await agent.outline()).blocks;

      const human = new HocuspocusProvider({
        url,
        name: doc,
        document: new Y.Doc(),
        token: signLiveToken(
          { actor: hana, workspaceId: "w1", docName: doc, access: "write" },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);

      const suggest = async (markdown: string) => {
        const { suggestionId } = await agent.ops({
          ops: [{ type: "replace", blockId: price.blockId, markdown }],
          mode: "suggest",
          approver: "Hana",
          approverId: "hana",
        });
        if (!suggestionId) {
          throw new Error("expected a suggestion");
        }
        await waitForAsync(
          async () => (await ledger(suggestionId))?.status === "pending"
        );
        await waitFor(() =>
          readOutline(docFragment(human.document)).some(
            (block) => block.suggestion?.id === suggestionId
          )
        );
        return suggestionId;
      };

      const rejected = await suggest("Price: $11.");
      rejectedId = rejected;
      expect(await ledger(rejected)).toMatchObject({ approver_id: "hana" });
      const [summary] = await fetchLiveSummaries({
        baseUrl: url.replace("ws", "http"),
        serviceToken: signLiveServiceToken("w1", jwtSecret),
        docNames: [doc],
      });
      expect(summary.pending).toMatchObject([
        { id: rejected, approverId: "hana" },
      ]);
      expect(summary.present.map((actor) => actor.id)).toEqual(["hana"]);
      expect(summary.lastEditor?.id).toBe("juno");

      rejectSuggestion(docFragment(human.document), rejected);
      await waitForAsync(
        async () => (await ledger(rejected))?.status === "rejected"
      );
      expect((await ledger(rejected))?.settled_by).toBe("hana");

      const accepted = await suggest("Price: $12.");
      acceptSuggestion(docFragment(human.document), accepted);
      await waitForAsync(
        async () => (await ledger(accepted))?.status === "accepted"
      );
      expect(
        (
          await fetchLiveSummaries({
            baseUrl: url.replace("ws", "http"),
            serviceToken: signLiveServiceToken("other", jwtSecret),
            docNames: [doc],
          })
        )[0].pending
      ).toEqual([]);
    }, 20_000);

    it("refuses sheet ops on a rich-text doc with 409 and names the kind", async () => {
      const textDoc = `test:${crypto.randomUUID()}`;
      const token = signLiveToken(
        { actor: juno, workspaceId: "w1", docName: textDoc, access: "write" },
        jwtSecret
      );
      await createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: textDoc,
        token,
      }).ops({
        ops: [{ type: "insert", afterBlockId: null, markdown: "Notes" }],
      });
      const response = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(textDoc)}/sheet-ops`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            ops: [{ type: "set_range", range: "A1", values: [["1"]] }],
          }),
        }
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "kind_mismatch",
        kind: "doc",
        route: "sheet-ops",
      });
    });

    it("streams sheet edits, settles a sheet suggestion, and exports xlsx", async () => {
      const sheetDoc = `test:${crypto.randomUUID()}`;
      const sheetClient = (
        actor: typeof juno | typeof hana,
        access: LiveAccess
      ) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: sheetDoc,
          token: signLiveToken(
            { actor, workspaceId: "w1", docName: sheetDoc, access },
            jwtSecret
          ),
        });
      const human = new HocuspocusProvider({
        url,
        name: sheetDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          {
            actor: hana,
            workspaceId: "w1",
            docName: sheetDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      let sawAgentCell = false;
      human.awareness?.on("change", () => {
        sawAgentCell ||= [
          ...(human.awareness?.getStates().values() ?? []),
        ].some((state) => state.user?.kind === "agent" && state.cell);
      });

      const agent = sheetClient(juno, "write");
      const written = await agent.sheetOps({
        ops: [
          {
            type: "set_range",
            range: "A1",
            values: [
              ["Item", "Price"],
              ["Pilot", "15000"],
              ["Total", "=SUM(B2)"],
            ],
          },
        ],
      });
      expect(written.results).toEqual([{ ok: true, range: "A1:B3" }]);
      expect(sawAgentCell).toBe(true);
      await waitFor(() => readGrid(human.document).inputs.length === 3);

      const { suggestionId } = await sheetClient(juno, "suggest").sheetOps({
        ops: [{ type: "set_range", range: "B2", values: [["13500"]] }],
        approverId: "hana",
      });
      expect(suggestionId).toEqual(expect.any(String));
      const view = await sheetClient(hana, "read").readSheet();
      expect(
        view.rows.map((row) => row.cells.map((cell) => cell.value))
      ).toEqual([
        ["Item", "Price"],
        ["Pilot", 15000],
        ["Total", 15000],
      ]);
      expect(view.suggestions).toMatchObject([
        {
          id: suggestionId,
          cells: [{ cell: "B2", before: "15000", after: "13500" }],
        },
      ]);
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "pending"
      );

      await waitFor(() =>
        sheetSuggestions(human.document).has(suggestionId ?? "")
      );
      rejectSheetSuggestion(human.document, suggestionId ?? "");
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "rejected"
      );
      expect((await ledger(suggestionId ?? ""))?.settled_by).toBe("hana");

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        new Uint8Array(await sheetClient(hana, "read").xlsx("Quote")).buffer
      );
      expect(workbook.getWorksheet("Quote")?.getCell("B3").value).toEqual({
        formula: "SUM(B2)",
        result: 15000,
      });

      setRange(human.document, "C2", [["1600"]], { actor: hana });
      await waitFor(
        () =>
          live.hocuspocus.documents.get(sheetDoc)?.getMap("sheetCells").size ===
          readGrid(human.document).inputs.flat().filter(Boolean).length
      );
      const guarded = await agent.sheetOps({
        ops: [
          { type: "set_range", range: "C2", values: [["1500"]] },
          { type: "set_range", range: "D2", values: [["note"]] },
        ],
      });
      expect(guarded.results).toEqual([
        { ok: true, range: "C2", suggested: true, humanCells: ["C2"] },
        { ok: true, range: "D2" },
      ]);
      expect(guarded.suggestionId).toEqual(expect.any(String));
      const afterGuard = await sheetClient(hana, "read").readSheet("C2:D2");
      expect(afterGuard.rows[0].cells).toMatchObject([
        { input: "1600", editor: { kind: "human", name: "Hana" } },
        { input: "note", editor: { kind: "agent", name: "Juno" } },
      ]);

      const forbidden = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(sheetDoc)}/sheet-ops`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${signLiveToken({ actor: juno, workspaceId: "w1", docName: sheetDoc, access: "read" }, jwtSecret)}`,
          },
          body: JSON.stringify({
            ops: [{ type: "set_range", range: "A1", values: [["x"]] }],
          }),
        }
      );
      expect(forbidden.status).toBe(403);
    }, 20_000);

    it("streams canvas shapes and settles a canvas suggestion", async () => {
      const canvasDoc = `test:${crypto.randomUUID()}`;
      const canvasClient = (
        actor: typeof juno | typeof hana,
        access: LiveAccess
      ) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: canvasDoc,
          token: signLiveToken(
            { actor, workspaceId: "w1", docName: canvasDoc, access },
            jwtSecret
          ),
        });
      const human = new HocuspocusProvider({
        url,
        name: canvasDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          {
            actor: hana,
            workspaceId: "w1",
            docName: canvasDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      let sawAgentPointer = false;
      human.awareness?.on("change", () => {
        sawAgentPointer ||= [
          ...(human.awareness?.getStates().values() ?? []),
        ].some((state) => state.user?.kind === "agent" && state.pointer);
      });

      const agent = canvasClient(juno, "write");
      const drawn = await agent.canvasOps({
        ops: [
          {
            type: "add_shapes",
            shapes: [
              { id: "lead", type: "rectangle", x: 0, y: 0, label: "Lead" },
              { id: "deal", type: "rectangle", x: 400, y: 0, label: "Deal" },
            ],
          },
          {
            type: "connect",
            arrows: [{ id: "flow", from: "lead", to: "deal" }],
          },
        ],
      });
      expect(drawn.results).toEqual([
        { ok: true, ids: ["lead", "deal"] },
        { ok: true, ids: ["flow"] },
      ]);
      expect(sawAgentPointer).toBe(true);
      await waitFor(() => canvasElements(human.document).has("flow"));

      const { suggestionId } = await canvasClient(juno, "suggest").canvasOps({
        ops: [
          { type: "update_shapes", updates: [{ id: "deal", label: "Won" }] },
        ],
        approverId: "hana",
      });
      expect(suggestionId).toEqual(expect.any(String));
      const view = await canvasClient(hana, "read").readCanvas();
      expect(view.shapes.map((shape) => shape.label)).toEqual(["Lead", "Deal"]);
      expect(view.connections).toMatchObject([{ from: "lead", to: "deal" }]);
      expect(view.suggestions).toMatchObject([
        {
          id: suggestionId,
          changes: [{ id: "deal", label: "Won", kind: "changed" }],
        },
      ]);
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "pending"
      );
      await waitFor(() =>
        canvasSuggestions(human.document).has(suggestionId ?? "")
      );
      rejectCanvasSuggestion(human.document, suggestionId ?? "");
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "rejected"
      );
      expect((await ledger(suggestionId ?? ""))?.settled_by).toBe("hana");

      const lead = canvasElements(human.document).get("lead");
      if (!lead) {
        throw new Error("lead missing");
      }
      writeLocalElements(
        human.document,
        [{ ...lead, x: 50, version: lead.version + 1 }],
        hana
      );
      await waitFor(
        () =>
          live.hocuspocus.documents
            .get(canvasDoc)
            ?.getMap("canvasEditors")
            .get("lead") !== undefined
      );
      const guarded = await agent.canvasOps({
        ops: [
          {
            type: "update_shapes",
            updates: [{ id: "lead", label: "Prospect" }],
          },
          { type: "update_shapes", updates: [{ id: "deal", fill: "#dbeafe" }] },
        ],
      });
      expect(guarded.results).toEqual([
        { ok: true, ids: ["lead"], suggested: true, humanShapes: ["lead"] },
        { ok: true, ids: ["deal"] },
      ]);

      const forbidden = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(canvasDoc)}/canvas-ops`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${signLiveToken({ actor: juno, workspaceId: "w1", docName: canvasDoc, access: "read" }, jwtSecret)}`,
          },
          body: JSON.stringify({
            ops: [{ type: "delete_shapes", ids: ["lead"] }],
          }),
        }
      );
      expect(forbidden.status).toBe(403);
    }, 20_000);

    it("streams a chat post by appending, never suggests, and checks the kind", async () => {
      const chatDoc = `test:${crypto.randomUUID()}`;
      const chatClient = (
        actor: typeof juno | typeof hana,
        access: LiveAccess
      ) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: chatDoc,
          token: signLiveToken(
            { actor, workspaceId: "w1", docName: chatDoc, access },
            jwtSecret
          ),
        });
      const human = new HocuspocusProvider({
        url,
        name: chatDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          { actor: hana, workspaceId: "w1", docName: chatDoc, access: "write" },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      postMessage(human.document, { text: "hi", mentions: [juno] }, hana);

      const lengths = new Set<number>();
      let sawTyping = false;
      human.document.on("update", () => {
        for (const message of readMessages(human.document)) {
          if (message.actor.id === "juno") {
            lengths.add(message.text.length);
          }
        }
      });
      human.awareness?.on("change", () => {
        sawTyping ||= [...(human.awareness?.getStates().values() ?? [])].some(
          (state) => state.user?.kind === "agent" && state.messageId
        );
      });

      const text = "x".repeat(200);
      const posted = await chatClient(juno, "write").chatOps({
        ops: [{ type: "post_message", id: "m-juno", text, mentions: [hana] }],
      });
      expect(posted).toEqual({
        results: [{ ok: true, id: "m-juno" }],
        suggestionId: null,
      });
      expect(sawTyping).toBe(true);
      await waitFor(
        () =>
          readMessages(human.document).find((m) => m.id === "m-juno")?.text ===
          text
      );
      expect(lengths.size).toBeGreaterThanOrEqual(3);

      const { messages } = await chatClient(hana, "read").readChat();
      expect(messages.map((m) => [m.actor.id, m.text])).toEqual([
        ["hana", "hi"],
        ["juno", text],
      ]);
      expect(messages[0].mentions).toEqual([juno]);
      expect(
        (
          await chatClient(hana, "read").readChat({ since: messages[0].ts })
        ).messages.map((m) => m.id)
      ).toEqual(["m-juno"]);

      const suggested = await chatClient(juno, "suggest").chatOps({
        ops: [
          { type: "edit_message", id: "m-juno", text: "edited" },
          { type: "edit_message", id: messages[0].id, text: "hijack" },
          { type: "react", id: messages[0].id, emoji: "👍" },
        ],
      });
      expect(suggested).toEqual({
        results: [
          { ok: true, id: "m-juno" },
          { ok: false, error: "not_author" },
          { ok: true, id: messages[0].id },
        ],
        suggestionId: null,
      });
      await waitFor(
        () =>
          readMessages(human.document).find((m) => m.id === "m-juno")?.text ===
          "edited"
      );

      const forbidden = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(chatDoc)}/chat-ops`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${signLiveToken({ actor: juno, workspaceId: "w1", docName: chatDoc, access: "read" }, jwtSecret)}`,
          },
          body: JSON.stringify({ ops: [{ type: "post_message", text: "x" }] }),
        }
      );
      expect(forbidden.status).toBe(403);

      const sheetDoc = `test:${crypto.randomUUID()}`;
      const sheetToken = signLiveToken(
        { actor: juno, workspaceId: "w1", docName: sheetDoc, access: "write" },
        jwtSecret
      );
      await createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: sheetDoc,
        token: sheetToken,
      }).sheetOps({
        ops: [{ type: "set_range", range: "A1", values: [["1"]] }],
      });
      const mismatch = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(sheetDoc)}/chat-ops`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sheetToken}` },
          body: JSON.stringify({ ops: [{ type: "post_message", text: "x" }] }),
        }
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: "kind_mismatch",
        kind: "sheet",
        route: "chat-ops",
      });
    }, 20_000);

    it("places objects for an agent, lets a person arrange them, refuses the agent after", async () => {
      const spaceDoc = `test:${crypto.randomUUID()}`;
      const spaceClient = (
        actor: typeof juno | typeof hana,
        access: LiveAccess
      ) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: spaceDoc,
          token: signLiveToken(
            { actor, workspaceId: "w1", docName: spaceDoc, access },
            jwtSecret
          ),
        });
      const human = new HocuspocusProvider({
        url,
        name: spaceDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          {
            actor: hana,
            workspaceId: "w1",
            docName: spaceDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      let sawPointer = false;
      human.awareness?.on("change", () => {
        sawPointer ||= [...(human.awareness?.getStates().values() ?? [])].some(
          (state) => state.user?.kind === "agent" && state.objectId
        );
      });

      const placed = await spaceClient(juno, "write").spaceOps({
        ops: [
          {
            type: "place",
            docName: "ldoc_a",
            kind: "doc",
            title: "Brief",
            x: 40,
            y: 40,
          },
          { type: "place", docName: "ldoc_b", kind: "sheet", title: "Numbers" },
        ],
      });
      expect(placed.results.map((result) => result.ok)).toEqual([true, true]);
      expect(placed.suggestionId).toBe(null);
      expect(sawPointer).toBe(true);
      await waitFor(() => readSpace(human.document).length === 2);
      const [brief, numbers] = readSpace(human.document);
      expect(brief).toMatchObject({
        docName: "ldoc_a",
        x: 40,
        y: 40,
        by: { id: "juno" },
      });
      expect(numbers).toMatchObject({
        docName: "ldoc_b",
        x: slotSize.gap + slotSize.w + slotSize.gap,
        y: slotSize.gap,
      });

      expect(moveObject(human.document, brief.id, 500, 500, hana).ok).toBe(
        true
      );
      let seen = await spaceClient(hana, "read").readSpace();
      for (let i = 0; i < 40 && seen.objects[0]?.x !== 500; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        seen = await spaceClient(hana, "read").readSpace();
      }
      expect(
        seen.objects.map((object) => [object.docName, object.x, object.by.id])
      ).toEqual([
        ["ldoc_a", 500, "hana"],
        ["ldoc_b", numbers.x, "juno"],
      ]);

      const refused = await spaceClient(juno, "suggest").spaceOps({
        ops: [
          { type: "move", id: brief.id, x: 0, y: 0 },
          { type: "bring_to_front", id: brief.id },
          { type: "resize", id: numbers.id, w: 400, h: 300 },
        ],
      });
      expect(refused).toEqual({
        results: [
          { ok: false, error: "arranged_by_person", by: "Hana" },
          { ok: true, id: brief.id },
          { ok: true, id: numbers.id },
        ],
        suggestionId: null,
      });
      await waitFor(() => readSpace(human.document).at(-1)?.id === brief.id);

      const forbidden = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(spaceDoc)}/space-ops`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${signLiveToken({ actor: juno, workspaceId: "w1", docName: spaceDoc, access: "read" }, jwtSecret)}`,
          },
          body: JSON.stringify({ ops: [{ type: "remove", id: brief.id }] }),
        }
      );
      expect(forbidden.status).toBe(403);

      const sheetDoc = `test:${crypto.randomUUID()}`;
      const sheetToken = signLiveToken(
        { actor: juno, workspaceId: "w1", docName: sheetDoc, access: "write" },
        jwtSecret
      );
      await createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: sheetDoc,
        token: sheetToken,
      }).sheetOps({
        ops: [{ type: "set_range", range: "A1", values: [["1"]] }],
      });
      const mismatch = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(sheetDoc)}/space-ops`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${sheetToken}` },
          body: JSON.stringify({
            ops: [
              { type: "place", docName: "ldoc_c", kind: "doc", title: "C" },
            ],
          }),
        }
      );
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: "kind_mismatch",
        kind: "sheet",
        route: "space-ops",
      });
    }, 20_000);

    it("drafts a deck, settles a slide suggestion, guards a person's box, exports pptx", async () => {
      const deckDoc = `test:${crypto.randomUUID()}`;
      const deckClient = (
        actor: typeof juno | typeof hana,
        access: LiveAccess
      ) =>
        createLiveAgentClient({
          baseUrl: url.replace("ws", "http"),
          docName: deckDoc,
          token: signLiveToken(
            { actor, workspaceId: "w1", docName: deckDoc, access },
            jwtSecret
          ),
        });
      const human = new HocuspocusProvider({
        url,
        name: deckDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          { actor: hana, workspaceId: "w1", docName: deckDoc, access: "write" },
          jwtSecret
        ),
      });
      providers.push(human);
      await waitFor(() => human.synced);
      let sawAgentFocus = false;
      human.awareness?.on("change", () => {
        sawAgentFocus ||= [
          ...(human.awareness?.getStates().values() ?? []),
        ].some((state) => state.user?.kind === "agent" && state.slideFocus);
      });

      const agent = deckClient(juno, "write");
      const drafted = await agent.slidesOps({
        ops: [
          {
            type: "add_slide",
            id: "s1",
            layout: "title",
            title: "Q3 pipeline",
          },
          {
            type: "add_slide",
            id: "s2",
            layout: "chart_takeaway",
            title: "By stage",
            bullets: ["Proposals doubled"],
            chart: {
              chart: "bar",
              labels: ["Lead", "Proposal"],
              series: [{ name: "Deals", values: [12, 8] }],
            },
          },
        ],
      });
      expect(drafted.results).toEqual([
        { ok: true, ids: ["s1"] },
        { ok: true, ids: ["s2"] },
      ]);
      expect(sawAgentFocus).toBe(true);
      await waitFor(() => readDeck(human.document).slides.length === 2);

      const { suggestionId } = await deckClient(juno, "suggest").slidesOps({
        ops: [
          { type: "update_slide", slide: "s1", title: "Q3 pipeline review" },
        ],
        approverId: "hana",
      });
      const view = await deckClient(hana, "read").readDeck();
      expect(view.slides[0].title).toBe("Q3 pipeline");
      expect(view.suggestions).toMatchObject([
        {
          id: suggestionId,
          lines: [{ kind: "changed", label: "Q3 pipeline review" }],
        },
      ]);
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "pending"
      );
      await waitFor(() =>
        deckSuggestions(human.document).has(suggestionId ?? "")
      );
      rejectSlideSuggestion(human.document, suggestionId ?? "");
      await waitForAsync(
        async () => (await ledger(suggestionId ?? ""))?.status === "rejected"
      );
      expect((await ledger(suggestionId ?? ""))?.settled_by).toBe("hana");

      setElementByHand(human.document, "s2-body", { x: 1300 }, hana);
      await waitFor(
        () =>
          live.hocuspocus.documents
            .get(deckDoc)
            ?.getMap("slideEditors")
            .get("s2-body") !== undefined
      );
      const guarded = await agent.slidesOps({
        ops: [
          { type: "update_slide", slide: "s2", bullets: ["Proposals tripled"] },
          { type: "update_slide", slide: "s2", title: "Pipeline by stage" },
        ],
      });
      expect(guarded.results).toEqual([
        {
          ok: true,
          ids: ["s2", "s2-body"],
          suggested: true,
          humanElements: ["s2-body"],
        },
        { ok: true, ids: ["s2", "s2-title"] },
      ]);

      const pptx = Buffer.from(
        await deckClient(hana, "read").pptx("Q3")
      ).toString("latin1");
      expect(pptx).toContain("ppt/slides/slide2.xml");
      expect(pptx).toContain("Pipeline by stage");

      const forbidden = await fetch(
        `${url.replace("ws", "http")}/v1/docs/${encodeURIComponent(deckDoc)}/slides-ops`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${signLiveToken({ actor: juno, workspaceId: "w1", docName: deckDoc, access: "read" }, jwtSecret)}`,
          },
          body: JSON.stringify({
            ops: [{ type: "delete_slide", slide: "s1" }],
          }),
        }
      );
      expect(forbidden.status).toBe(403);
    }, 20_000);

    it("migrates a P4 Excalidraw deck when it is first loaded", async () => {
      const oldDoc = `test:${crypto.randomUUID()}`;
      const seed = new Y.Doc();
      const old = seed.getMap<unknown>("canvasElements");
      old.set("f1", {
        id: "f1",
        type: "frame",
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        index: "a0",
        isDeleted: false,
        frameId: null,
        customData: { slide: true, layout: "title_bullets", notes: "" },
      });
      old.set("t1", {
        id: "t1",
        type: "text",
        x: 120,
        y: 90,
        width: 400,
        height: 80,
        index: "a1",
        isDeleted: false,
        frameId: "f1",
        originalText: "Old plan",
        customData: { role: "title" },
      });
      const pool = new pg.Pool({ connectionString: databaseUrl });
      const seeding = createPersistence({
        pool,
        logger: pino({ level: "silent" }),
      });
      seeding.append(oldDoc, Y.encodeStateAsUpdate(seed), hana);
      await seeding.close();
      await pool.end();

      const view = await createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: oldDoc,
        token: signLiveToken(
          { actor: hana, workspaceId: "w1", docName: oldDoc, access: "read" },
          jwtSecret
        ),
      }).readDeck();
      expect(view.slides.map((slide) => slide.title)).toEqual(["Old plan"]);
    }, 20_000);

    it("diffs a version, restores it as the restorer, and reopens its suggestion", async () => {
      const reader = clientFor(hana, "read");
      const { sessions, events } = await reader.history();
      const first = sessions.at(-1);
      if (!first) {
        throw new Error("expected history");
      }
      expect(first.actor.id).toBe("juno");
      expect(events.map((event) => event.type)).toContain(
        "suggestion_accepted"
      );

      const version = await reader.version(first.uptoId);
      expect(version.markdown).toBe("Price: $10.");
      expect(
        version.diff.map((entry) => [entry.change, entry.after?.text])
      ).toEqual([
        ["added", "Price: $10."],
        ["added", "Price: $11."],
      ]);

      await expect(reader.restore(first.uptoId)).rejects.toMatchObject({
        status: 403,
      });
      await clientFor(hana, "write").restore(first.uptoId);
      expect((await reader.outline()).blocks.map((b) => b.text)).toEqual([
        "Price: $10.",
        "Price: $11.",
      ]);
      await live.persistence.flush();
      expect((await reader.history()).sessions[0].actor.id).toBe("hana");
      await waitForAsync(
        async () => (await ledger(rejectedId))?.status === "pending"
      );
    }, 20_000);

    it("lets an agent open and answer comment threads", async () => {
      const agent = clientFor(juno, "suggest");
      const [block] = (await agent.outline()).blocks;
      const { threadId } = await agent.comment({
        blockId: block.blockId,
        quote: "$10",
        body: "Should this be $12?",
      });
      await agent.comment({ threadId, body: "Checked: $12." });
      expect((await agent.outline()).threads).toMatchObject([
        {
          id: threadId,
          blockId: block.blockId,
          messages: [
            { body: "Should this be $12?" },
            { body: "Checked: $12." },
          ],
        },
      ]);
      await expect(
        clientFor(juno, "read").comment({ threadId, body: "x" })
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("turns", () => {
    const turnsDoc = `test:${crypto.randomUUID()}`;
    const turns: Turn[] = [];
    const spokenTurns: Turn[] = [];
    const yes: Decide = async (input) => ({
      provider: "fake",
      ms: 1,
      answers: Object.fromEntries(
        Object.entries(input.questions).map(([id, question]) => [
          id,
          question.type === "noul"
            ? { type: "noul", noul: 0.9 }
            : { type: "choice", choice: "none", confidence: 1 },
        ])
      ),
    });
    const turnServer = createLiveServer({
      databaseUrl: databaseUrl ?? "",
      jwtSecret,
      port: 0,
      logger: pino({ level: "silent" }),
      decide: yes,
      onTurn: async (turn) => {
        turns.push(turn);
      },
      onSpoken: async (turn) => {
        spokenTurns.push(turn);
      },
      turnSettleMs: 300,
    });
    let turnUrl = "";
    const turnProviders: HocuspocusProvider[] = [];

    beforeAll(async () => {
      turnUrl = `ws://127.0.0.1:${await turnServer.listen()}`;
    });

    afterAll(async () => {
      for (const provider of turnProviders) {
        provider.destroy();
      }
      await turnServer.destroy();
    });

    it("turns a person's settled edits into one decided turn, and never an agent's ops", async () => {
      const token = signLiveToken(
        {
          actor: { kind: "human", id: "hana", name: "Hana" },
          workspaceId: "w1",
          docName: turnsDoc,
          access: "write",
        },
        jwtSecret
      );
      const provider = new HocuspocusProvider({
        url: turnUrl,
        name: turnsDoc,
        document: new Y.Doc(),
        token,
      });
      turnProviders.push(provider);
      await waitFor(() => provider.synced);
      const fragment = provider.document.getXmlFragment("default");
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.setAttribute("blockId", "b1");
      paragraph.insert(0, [new Y.XmlText("Q3 numbers: 12, 14, 19")]);
      fragment.insert(0, [paragraph]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      paragraph.insert(1, [new Y.XmlText(" (draft)")]);

      await waitFor(() => turns.length === 1, 3000);
      expect(turns[0]).toMatchObject({
        docName: turnsDoc,
        workspaceId: "w1",
        event: {
          type: "edit_settled",
          actor: { kind: "human", id: "hana", name: "Hana" },
        },
        decision: { provider: "fake", answers: { turn: { noul: 0.9 } } },
      });
      expect(turns[0].event.summary).toContain("Q3 numbers");
      const rows = await turnServer.persistence.listDecisions(turnsDoc);
      expect(rows).toMatchObject([{ point: "turn", provider: "fake", ms: 1 }]);

      const agent = createLiveAgentClient({
        baseUrl: turnUrl.replace("ws", "http"),
        docName: turnsDoc,
        token: signLiveToken(
          {
            actor: { kind: "agent", id: "juno", name: "Juno" },
            workspaceId: "w1",
            docName: turnsDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      await agent.ops({
        ops: [{ type: "insert", afterBlockId: null, markdown: "Noted." }],
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(turns).toHaveLength(1);

      const metricsBody = await (
        await fetch(`${turnUrl.replace("ws", "http")}/metrics`)
      ).text();
      expect(metricsBody).toContain('live_decide_ms_count{provider="fake"}');
    });

    it("fires a spoken turn for a person's line, but not for one the host routes itself", async () => {
      const callDoc = `test:${crypto.randomUUID()}`;
      const hanaClient = createLiveAgentClient({
        baseUrl: turnUrl.replace("ws", "http"),
        docName: callDoc,
        token: signLiveToken(
          {
            actor: { kind: "human", id: "hana", name: "Hana" },
            workspaceId: "w1",
            docName: callDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      const before = spokenTurns.length;
      await hanaClient.addTranscript({
        id: "v1",
        text: "written by the voice package",
        final: true,
        turn: false,
      });
      await hanaClient.addTranscript({
        id: "v2",
        text: "said in a browser",
        final: true,
      });
      await waitFor(() => spokenTurns.length === before + 1, 1000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(spokenTurns.length).toBe(before + 1);
      expect(spokenTurns.at(-1)?.event.summary).toBe("said in a browser");
    });

    it("hands a person's chat message to the host at once, undecided, and nothing else in a chat", async () => {
      const chatDoc = `test:${crypto.randomUUID()}`;
      const provider = new HocuspocusProvider({
        url: turnUrl,
        name: chatDoc,
        document: new Y.Doc(),
        token: signLiveToken(
          {
            actor: { kind: "human", id: "hana", name: "Hana" },
            workspaceId: "w1",
            docName: chatDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      turnProviders.push(provider);
      await waitFor(() => provider.synced);
      const before = turns.length;
      const postedAt = Date.now();
      postMessage(
        provider.document,
        {
          id: "m1",
          text: "@Juno can you total column B?",
          mentions: [{ kind: "agent", id: "juno", name: "Juno" }],
        },
        { kind: "human", id: "hana", name: "Hana" }
      );

      await waitFor(() => turns.length === before + 1, 1000);
      expect(Date.now() - postedAt).toBeLessThan(500);
      expect(turns[before]).toMatchObject({
        docName: chatDoc,
        workspaceId: "w1",
        event: {
          type: "message",
          actor: { kind: "human", id: "hana", name: "Hana" },
          payload: {
            messageId: "m1",
            text: "@Juno can you total column B?",
            mentions: [{ kind: "agent", id: "juno", name: "Juno" }],
          },
        },
        decision: null,
      });

      const agent = createLiveAgentClient({
        baseUrl: turnUrl.replace("ws", "http"),
        docName: chatDoc,
        token: signLiveToken(
          {
            actor: { kind: "agent", id: "juno", name: "Juno" },
            workspaceId: "w1",
            docName: chatDoc,
            access: "write",
          },
          jwtSecret
        ),
      });
      await agent.chatOps({
        ops: [{ type: "post_message", text: "B totals 45." }],
      });
      editMessage(provider.document, "m1", "@Juno total column B please", {
        kind: "human",
        id: "hana",
        name: "Hana",
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(turns).toHaveLength(before + 1);
      expect(await turnServer.persistence.listDecisions(chatDoc)).toEqual([]);
    });

    it("records a host's own decision behind the service token", async () => {
      const record = {
        point: "agent",
        stateHash: "a".repeat(64),
        questions: {
          agent: {
            type: "choice",
            instructions: "who?",
            criteria: { juno: "Juno", none: "nobody" },
          },
        },
        answers: {
          agent: { type: "choice", choice: "juno", confidence: 0.8 },
        },
        provider: "jev",
        ms: 310,
        docName: turnsDoc,
      };
      const post = (token: string) =>
        fetch(`${turnUrl.replace("ws", "http")}/v1/decisions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(record),
        });
      expect(
        (
          await post(
            signLiveToken(
              {
                actor: { kind: "human", id: "hana", name: "Hana" },
                workspaceId: "w1",
                docName: turnsDoc,
                access: "write",
              },
              jwtSecret
            )
          )
        ).status
      ).toBe(401);
      expect((await post(signLiveServiceToken("w1", jwtSecret))).status).toBe(
        204
      );
      let rows = await turnServer.persistence.listDecisions(turnsDoc);
      const startedAt = Date.now();
      while (rows[0]?.point !== "agent" && Date.now() - startedAt < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rows = await turnServer.persistence.listDecisions(turnsDoc);
      }
      expect(rows[0]).toMatchObject({
        point: "agent",
        provider: "jev",
        ms: 310,
      });
    });
  });

  describe("activity push", () => {
    const doc = `test:${crypto.randomUUID()}`;
    const ada = { kind: "human" as const, id: "ada", name: "Ada" };
    const watchToken = (watchId: string, docNames: string[]) =>
      signLiveWatchToken(
        { watchId, workspaceId: "w1", actor: ada, docNames },
        jwtSecret
      );

    it("pushes who is writing which section to watchers, and nothing to others", async () => {
      const watchId = crypto.randomUUID();
      const messages: ActivityMessage[] = [];
      const watcher = new HocuspocusProvider({
        url,
        name: `watch:${watchId}`,
        document: new Y.Doc(),
        token: watchToken(watchId, [doc]),
        onStateless: ({ payload }) => {
          const parsed = activityMessageSchema.safeParse(JSON.parse(payload));
          if (parsed.success) {
            messages.push(parsed.data);
          }
        },
      });
      providers.push(watcher);
      await waitFor(() => watcher.synced);

      const agent = createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName: doc,
        token: signLiveToken(
          {
            actor: { kind: "agent", id: "juno", name: "Juno" },
            workspaceId: "w1",
            docName: doc,
            access: "write",
          },
          jwtSecret
        ),
      });
      await agent.ops({
        ops: [
          {
            type: "insert",
            afterBlockId: null,
            markdown: `# Price\n\n${"x".repeat(200)}`,
          },
        ],
      });

      await waitFor(() =>
        messages.some((message) =>
          message.summary.writing.some(
            (writer) => writer.name === "Juno" && writer.section === "Price"
          )
        )
      );
      const last = messages.at(-1);
      expect(last?.summary.docName).toBe(doc);
      expect(last?.summary.lastEditor?.id).toBe("juno");

      let otherFailed = false;
      const thief = new HocuspocusProvider({
        url,
        name: `watch:${watchId}`,
        document: new Y.Doc(),
        token: watchToken(crypto.randomUUID(), [doc]),
      });
      thief.on("authenticationFailed", () => {
        otherFailed = true;
      });
      providers.push(thief);
      await waitFor(() => otherFailed);

      let docFailed = false;
      const sneaky = new HocuspocusProvider({
        url,
        name: doc,
        document: new Y.Doc(),
        token: watchToken(watchId, [doc]),
      });
      sneaky.on("authenticationFailed", () => {
        docFailed = true;
      });
      providers.push(sneaky);
      await waitFor(() => docFailed);
    });
  });
});

const cdpUrl = process.env.TEST_CDP_URL;

describe.skipIf(!databaseUrl || !cdpUrl)("shared browser", () => {
  const live = createLiveServer({
    databaseUrl: databaseUrl ?? "",
    jwtSecret,
    port: 0,
    browserProvider: cdpUrl ? cdpEndpointProvider({ url: cdpUrl }) : null,
    logger: pino({ level: "silent" }),
  });
  const docName = `test:${crypto.randomUUID()}`;
  const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
  const hana = { kind: "human" as const, id: "hana", name: "Hana" };
  const providers: HocuspocusProvider[] = [];
  let url = "";

  const token = (
    actor: { kind: "human" | "agent"; id: string; name: string },
    access: LiveAccess
  ) => signLiveToken({ actor, workspaceId: "w1", docName, access }, jwtSecret);

  const viewer = async (
    actor: { kind: "human" | "agent"; id: string; name: string },
    access: LiveAccess
  ) => {
    const messages: BrowserMessage[] = [];
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document: new Y.Doc(),
      token: token(actor, access),
      onStateless: ({ payload }) => {
        const parsed = browserMessageSchema.safeParse(JSON.parse(payload));
        if (parsed.success) {
          messages.push(parsed.data);
        }
      },
    });
    providers.push(provider);
    await waitFor(() => provider.synced);
    return { provider, messages };
  };

  beforeAll(async () => {
    const port = await live.listen();
    url = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const provider of providers) {
      provider.destroy();
    }
    await live.destroy();
  });

  it("drives a page for an agent, streams it to a viewer, and yields to a person", async () => {
    const agent = createLiveAgentClient({
      baseUrl: url.replace("ws", "http"),
      docName,
      token: token(juno, "write"),
    });
    const opened = await agent.browserOps({
      ops: [{ type: "navigate", url: "https://example.com/" }],
    });
    expect(opened.results).toEqual([{ ok: true }]);
    expect(opened.page.url).toBe("https://example.com/");
    expect(opened.page.outline).toContain('link "Learn more"');
    expect(opened.page.controller).toEqual(juno);

    const { provider, messages } = await viewer(hana, "write");
    await waitFor(
      () =>
        messages.some((m) => m.type === "browser_frame") &&
        messages.some(
          (m) => m.type === "browser_status" && m.status === "running"
        ),
      5000
    );
    const frame = messages.find((m) => m.type === "browser_frame");
    expect(frame && frame.type === "browser_frame" && frame.width).toBe(1280);
    expect(readBrowserState(provider.document).url).toBe(
      "https://example.com/"
    );

    const ref = /(e\d+) link "Learn more"/.exec(opened.page.outline)?.[1];
    const clicked = await agent.browserOps({
      ops: [
        { type: "click", ref: ref ?? "e1" },
        { type: "wait", ms: 1500 },
      ],
    });
    expect(clicked.results).toEqual([{ ok: true }, { ok: true }]);
    expect(clicked.page.url).toContain("iana.org");
    expect(clicked.page.changed?.removed).toContain('e link "Learn more"');
    await waitFor(
      () =>
        readVisits(provider.document).some((v) => v.url.includes("iana.org")),
      3000
    );
    expect(readVisits(provider.document).at(-1)?.actor).toEqual(juno);

    provider.sendStateless(
      JSON.stringify({ type: "mouse", kind: "move", x: 10, y: 10 })
    );
    await waitFor(
      () =>
        messages.some(
          (m) => m.type === "browser_status" && m.controller?.id === hana.id
        ),
      3000
    );
    const denied = await agent.browserOps({
      ops: [{ type: "navigate", url: "https://example.com/" }],
    });
    expect(denied.results[0]).toMatchObject({ ok: false, heldBy: hana });
    expect(denied.page.url).toContain("iana.org");

    const reader = await viewer({ ...hana, id: "rita", name: "Rita" }, "read");
    reader.provider.sendStateless(
      JSON.stringify({ type: "navigate", url: "https://example.com/" })
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await agent.readBrowser()).url).toContain("iana.org");

    await waitFor(() => false, 2200).catch(() => {});
    const { frames } = await agent.frames();
    expect(frames.length).toBeGreaterThan(0);
    expect((await agent.frame(frames[0].id)).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8])
    );
  }, 30_000);
});

const nekoInstances = process.env.TEST_LIVE_BROWSERS;

describe.skipIf(!databaseUrl || !nekoInstances)(
  "shared browser with video",
  () => {
    const apiToken = process.env.TEST_LIVE_NEKO_API_TOKEN ?? "";
    const instances = parseNekoInstances(nekoInstances ?? "[]");
    const live = createLiveServer({
      databaseUrl: databaseUrl ?? "",
      jwtSecret,
      port: 0,
      browserProvider: nekoPoolProvider({
        instances,
        password: process.env.TEST_LIVE_NEKO_PASSWORD ?? "",
        apiToken,
      }),
      logger: pino({ level: "silent" }),
    });
    const docName = `test:${crypto.randomUUID()}`;
    const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
    let url = "";
    let destroyed = false;

    beforeAll(async () => {
      url = `ws://127.0.0.1:${await live.listen()}`;
    });

    afterAll(async () => {
      if (!destroyed) {
        await live.destroy();
      }
    });

    it("grants a viewer session in the viewer's name once the room runs, and deletes it with the room", async () => {
      const agent = createLiveAgentClient({
        baseUrl: url.replace("ws", "http"),
        docName,
        token: signLiveToken(
          { actor: juno, workspaceId: "w1", docName, access: "write" },
          jwtSecret
        ),
      });
      const opened = await agent.browserOps({
        ops: [{ type: "navigate", url: "https://example.com/" }],
      });
      expect(opened.results).toEqual([{ ok: true }]);

      const grant = await agent.browserVideo();
      expect(grant.url).toBe(instances[0].publicUrl);
      const whoami = await fetch(`${instances[0].neko}/api/whoami`, {
        headers: { authorization: `Bearer ${grant.token}` },
      });
      expect(whoami.status).toBe(200);
      expect(await whoami.json()).toMatchObject({
        profile: { name: "Juno", can_host: false, can_watch: true },
      });

      destroyed = true;
      await live.destroy();
      const sessions = await fetch(`${instances[0].neko}/api/sessions`, {
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect(JSON.stringify(await sessions.json())).not.toContain('"Juno"');
    });
  }
);

describe.skipIf(!databaseUrl)("media room", () => {
  const live = createLiveServer({
    databaseUrl: databaseUrl ?? "",
    jwtSecret,
    port: 0,
    media: {
      url: "ws://livekit.test:7880",
      tokens: createMediaTokens({ apiKey: "devkey", apiSecret: "secret" }),
      speaker: null,
    },
    logger: pino({ level: "silent" }),
  });
  const docName = `test:${crypto.randomUUID()}`;
  const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
  const hana = { kind: "human" as const, id: "hana", name: "Hana" };
  const providers: HocuspocusProvider[] = [];
  let url = "";

  const token = (
    actor: { kind: "human" | "agent"; id: string; name: string },
    access: LiveAccess
  ) => signLiveToken({ actor, workspaceId: "w1", docName, access }, jwtSecret);

  beforeAll(async () => {
    const port = await live.listen();
    url = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const provider of providers) {
      provider.destroy();
    }
    await live.destroy();
  });

  it("mints join tokens capped by access, keeps the transcript, and voices an agent line", async () => {
    const base = url.replace("ws", "http");
    const hanaClient = createLiveAgentClient({
      baseUrl: base,
      docName,
      token: token(hana, "write"),
    });
    const listener = createLiveAgentClient({
      baseUrl: base,
      docName,
      token: token({ ...hana, id: "rita", name: "Rita" }, "read"),
    });
    const joined = await hanaClient.mediaToken();
    expect(joined).toMatchObject({
      url: "ws://livekit.test:7880",
      room: docName,
      identity: "user:hana",
      canPublish: true,
    });
    expect((await listener.mediaToken()).canPublish).toBe(false);
    const verifier = createMediaTokens({
      apiKey: "devkey",
      apiSecret: "secret",
    });
    expect((await verifier.verify(joined.token))?.room).toBe(docName);

    const messages: MediaMessage[] = [];
    const provider = new HocuspocusProvider({
      url,
      name: docName,
      document: new Y.Doc(),
      token: token(hana, "write"),
      onStateless: ({ payload }) => {
        const parsed = mediaMessageSchema.safeParse(JSON.parse(payload));
        if (parsed.success) {
          messages.push(parsed.data);
        }
      },
    });
    providers.push(provider);
    await waitFor(() => provider.synced);

    await hanaClient.addTranscript({ id: "s1", text: "we sho", final: false });
    await hanaClient.addTranscript({
      id: "s1",
      text: "we should ship on Monday",
      final: true,
    });
    await expect(
      listener.addTranscript({ id: "x", text: "no", final: true })
    ).rejects.toMatchObject({ status: 403 });

    const agent = createLiveAgentClient({
      baseUrl: base,
      docName,
      token: token(juno, "write"),
    });
    const spoke = await agent.speak("Monday works for me.");
    expect(spoke.spoken).toBe("clients");
    await waitFor(
      () =>
        messages.some(
          (m) => m.type === "media_speak" && m.text === "Monday works for me."
        ),
      3000
    );

    const transcript = await hanaClient.transcript();
    expect(
      transcript.lines.map((l) => [l.actor.name, l.text, l.final])
    ).toEqual([
      ["Hana", "we should ship on Monday", true],
      ["Juno", "Monday works for me.", true],
    ]);
    expect(transcript.present.map((a) => a.id)).toEqual(["hana"]);
    await waitFor(() => readTranscript(provider.document).length === 2, 3000);

    provider.sendStateless(
      JSON.stringify({
        type: "signal",
        signal: "attention",
        value: "away",
        score: 0.2,
      })
    );
    await waitFor(
      () =>
        messages.some((m) => m.type === "media_signal" && m.value === "away"),
      3000
    );
  }, 20_000);
});
