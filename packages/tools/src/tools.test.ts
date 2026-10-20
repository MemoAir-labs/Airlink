import type { LiveAgentClient } from "@memo-air/agent";
import { LiveRequestError } from "@memo-air/agent";
import type {
  BrowserOpsRequest,
  SheetOpsRequest,
  SheetReadResponse,
  SlidesOpsRequest,
} from "@memo-air/protocol";
import { describe, expect, it } from "vitest";
import { roomToolAccess, roomTools, runRoomTool } from "./index.ts";

const unused = () => {
  throw new Error("not used by this test");
};

function fakeClient(overrides: Partial<LiveAgentClient>): LiveAgentClient {
  return {
    outline: unused,
    markdown: unused,
    ops: unused,
    history: unused,
    version: unused,
    restore: unused,
    comment: unused,
    sheetOps: unused,
    readSheet: unused,
    xlsx: unused,
    canvasOps: unused,
    readCanvas: unused,
    chatOps: unused,
    readChat: unused,
    spaceOps: unused,
    readSpace: unused,
    pptx: unused,
    slidesOps: unused,
    readDeck: unused,
    browserOps: unused,
    readBrowser: unused,
    browserVideo: unused,
    frames: unused,
    frame: unused,
    desktopOps: unused,
    readDesktop: unused,
    mediaToken: unused,
    transcript: unused,
    addTranscript: unused,
    speak: unused,
    ...overrides,
  };
}

const sheet: SheetReadResponse = {
  range: "A1:B2",
  rowCount: 2,
  colCount: 2,
  columns: [{ column: "B", format: "currency" }],
  rows: [
    {
      row: 1,
      cells: [
        { cell: "A1", input: "Vendor", value: "Vendor", editor: null },
        { cell: "B1", input: "Price", value: "Price", editor: null },
      ],
    },
    {
      row: 2,
      cells: [
        {
          cell: "A2",
          input: "Acme",
          value: "Acme",
          editor: { kind: "human", name: "Ana" },
        },
        { cell: "B2", input: "=10*2", value: 20, editor: null },
      ],
    },
  ],
  suggestions: [],
};

const sheetObject = { id: "ldoc_s", title: "Prices", kind: "sheet" };

describe("runRoomTool", () => {
  it("maps a sheet tool op to live-server's op and reads the sheet back", async () => {
    const sent: SheetOpsRequest[] = [];
    const client = fakeClient({
      sheetOps: async (request) => {
        sent.push(request);
        return { results: [{ ok: true, range: "A3:B3" }], suggestionId: null };
      },
      readSheet: async () => sheet,
    });
    const result = await runRoomTool(
      client,
      {
        name: "edit_live_sheet",
        args: {
          doc_id: "ldoc_s",
          mode: "edit",
          ops: [{ type: "add_rows", after_row: 2, values: [["Globex", "30"]] }],
        },
      },
      sheetObject
    );
    expect(sent).toEqual([
      {
        ops: [{ type: "add_rows", afterRow: 2, values: [["Globex", "30"]] }],
        mode: "edit",
        approver: undefined,
        approverId: undefined,
      },
    ]);
    expect(result).toEqual({
      ok: true,
      text: '1. add_rows: ok (A3:B3)\n\nLive sheet "Prices" (ldoc_s): 2 rows × 2 columns, showing A1:B2. Column formats: B currency.\n\n1: A1 Vendor | B1 Price\n2: A2 Acme (by Ana) | B2 =10*2 → 20',
    });
  });

  it("turns add_slides into add_slide ops with their layouts and positions", async () => {
    const sent: SlidesOpsRequest[] = [];
    const client = fakeClient({
      slidesOps: async (request) => {
        sent.push(request);
        return {
          results: [
            { ok: true, ids: ["p1"] },
            { ok: true, ids: ["p2"] },
          ],
          suggestionId: null,
        };
      },
      readDeck: async () => ({
        theme: { themeId: "studio", name: "Studio", mode: "light" },
        slides: [],
        suggestions: [],
      }),
    });
    const result = await runRoomTool(
      client,
      {
        name: "edit_live_canvas",
        args: {
          doc_id: "ldoc_d",
          mode: "edit",
          ops: [
            {
              type: "add_slides",
              position: 2,
              slides: [
                { layout: "title", title: "Hi" },
                { layout: "title_bullets", title: "Why", bullets: ["a"] },
              ],
            },
          ],
        },
      },
      { id: "ldoc_d", title: "Pitch", kind: "slides" }
    );
    expect(sent[0].ops).toEqual([
      {
        type: "add_slide",
        id: undefined,
        layout: "title",
        position: 2,
        title: "Hi",
        rightBullets: undefined,
        chart: undefined,
      },
      {
        type: "add_slide",
        id: undefined,
        layout: "title_bullets",
        position: 3,
        title: "Why",
        bullets: ["a"],
        rightBullets: undefined,
        chart: undefined,
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses shape ops on slides as the agent's mistake, without calling the service", async () => {
    const result = await runRoomTool(
      fakeClient({}),
      {
        name: "edit_live_canvas",
        args: {
          doc_id: "ldoc_d",
          mode: "edit",
          ops: [{ type: "delete_shapes", ids: ["a"] }],
        },
      },
      { id: "ldoc_d", title: "Pitch", kind: "slides" }
    );
    expect(result).toMatchObject({ ok: false, cause: "input" });
  });

  it("forwards browser actions untouched", async () => {
    const sent: BrowserOpsRequest[] = [];
    const actions = [
      { type: "type" as const, ref: "e3", text: "memoair", submit: true },
    ];
    const result = await runRoomTool(
      fakeClient({
        browserOps: async (request) => {
          sent.push(request);
          return {
            results: [{ ok: true }],
            page: {
              url: "https://example.com",
              title: "Example",
              controller: null,
              outline: "e1 link",
            },
          };
        },
      }),
      { name: "act_live_browser", args: { doc_id: "ldoc_b", actions } },
      { id: "ldoc_b", title: "Example", kind: "browser" }
    );
    expect(sent).toEqual([{ ops: actions }]);
    expect(result).toEqual({
      ok: true,
      text: "1. type: ok\n\nPage: Example — https://example.com\nNobody is driving right now.\n\ne1 link",
    });
  });

  it("returns a service failure instead of throwing", async () => {
    const result = await runRoomTool(
      fakeClient({
        readSheet: async () => {
          throw new LiveRequestError(403, "forbidden");
        },
      }),
      { name: "read_live_sheet", args: { doc_id: "ldoc_s" } },
      sheetObject
    );
    expect(result).toEqual({
      ok: false,
      error: "The live doc service failed: forbidden",
      cause: "service",
    });
  });

  it("mints a suggest token for suggest-mode edits and comments, a read token for reads", () => {
    expect(
      roomToolAccess({
        name: "edit_live_doc",
        args: { doc_id: "d", mode: "suggest", ops: [] },
      })
    ).toBe("suggest");
    expect(
      roomToolAccess({
        name: "comment_live_doc",
        args: { doc_id: "d", body: "hi", block_id: "b" },
      })
    ).toBe("suggest");
    expect(
      roomToolAccess({ name: "read_live_room", args: { doc_id: "d" } })
    ).toBe("read");
  });

  it("defines all 23 tools with a kind and an effect each", () => {
    const tools = Object.values(roomTools);
    expect(tools).toHaveLength(23);
    expect(
      tools.filter((tool) => tool.effect === "create").map((tool) => tool.name)
    ).toEqual([
      "create_live_doc",
      "create_live_sheet",
      "create_live_canvas",
      "create_live_slides",
      "open_live_browser",
      "open_live_desktop",
      "open_live_room",
    ]);
  });
});
