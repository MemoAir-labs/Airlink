import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  acceptSheetSuggestion,
  addRows,
  deleteRows,
  diffSheets,
  docFromState,
  evaluate,
  humanWrittenCells,
  pendingSheetSuggestions,
  readGrid,
  rejectSheetSuggestion,
  restoreSheet,
  setRange,
  sheetEditors,
} from "./index.ts";
import { toXlsx } from "./xlsx.ts";

const suggest = {
  suggest: {
    id: "s1",
    actor: { id: "agent-1", name: "Analyst" },
    approverId: "u1",
  },
};

function sheet(values: string[][]) {
  const doc = new Y.Doc();
  setRange(doc, "A1", values);
  return doc;
}

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("sheet ops", () => {
  it("keeps a concurrent row insert and an agent write in the right rows", () => {
    const human = sheet([
      ["Vendor", "Price"],
      ["Acme", "100"],
      ["Globex", "200"],
    ]);
    const agentDoc = new Y.Doc();
    sync(human, agentDoc);

    addRows(human, 1, [["Initech", "300"]]);
    setRange(agentDoc, "B3", [["250"]]);
    sync(human, agentDoc);

    const expected = [
      ["Vendor", "Price"],
      ["Initech", "300"],
      ["Acme", "100"],
      ["Globex", "250"],
    ];
    expect(readGrid(human).inputs).toEqual(expected);
    expect(readGrid(agentDoc).inputs).toEqual(expected);
  });

  it("rejects a mismatched range instead of writing part of it", () => {
    const doc = sheet([["a"]]);
    expect(setRange(doc, "A1:B2", [["1", "2", "3"]]).ok).toBe(false);
    expect(readGrid(doc).inputs).toEqual([["a"]]);
  });

  it("suggests without touching cells, and reject restores the grid exactly", () => {
    const doc = sheet([
      ["Item", "Price"],
      ["Pilot", "15000"],
    ]);
    const before = readGrid(doc);

    setRange(doc, "B2", [["13500"]], suggest);
    addRows(doc, null, [["Support", "2000"]], {
      suggest: { ...suggest.suggest, id: "s2" },
    });
    expect(readGrid(doc).inputs[1]).toEqual(["Pilot", "15000"]);
    expect(pendingSheetSuggestions(doc).map((s) => [s.id, s.cellRefs])).toEqual(
      [
        ["s1", ["B2"]],
        ["s2", ["A3", "B3"]],
      ]
    );

    rejectSheetSuggestion(doc, "s1");
    rejectSheetSuggestion(doc, "s2");
    expect(readGrid(doc)).toEqual(before);
    expect(pendingSheetSuggestions(doc)).toEqual([]);
  });

  it("accepts suggested values and suggested row deletions", () => {
    const doc = sheet([
      ["Item", "Price"],
      ["Pilot", "15000"],
      ["Old", "1"],
    ]);
    setRange(doc, "B2", [["13500"]], suggest);
    deleteRows(doc, 3, 3, { suggest: { ...suggest.suggest, id: "s2" } });
    acceptSheetSuggestion(doc, "s1");
    acceptSheetSuggestion(doc, "s2");
    expect(readGrid(doc).inputs).toEqual([
      ["Item", "Price"],
      ["Pilot", "13500"],
    ]);
  });

  it("marks a suggestion stale when its cell changed after it was made", () => {
    const doc = sheet([["Price"], ["100"]]);
    setRange(doc, "A2", [["90"]], suggest);
    setRange(doc, "A2", [["110"]]);
    expect(pendingSheetSuggestions(doc)[0].stale).toBe(true);
  });

  it("restores a version forward and diffs it by cell", () => {
    const doc = sheet([["Price"], ["100"]]);
    const version = docFromState(Y.encodeStateAsUpdate(doc));
    setRange(doc, "A2", [["120"]]);
    addRows(doc, null, [["5"]]);
    expect(diffSheets(version, doc)).toEqual([
      { cell: "A2", before: "100", after: "120" },
      { cell: "A3", before: "", after: "5" },
    ]);
    restoreSheet(doc, version);
    expect(readGrid(doc).inputs).toEqual([["Price"], ["100"]]);
  });
});

describe("cell editors", () => {
  const hana = { kind: "human" as const, id: "u1", name: "Hana" };
  const analyst = { kind: "agent" as const, id: "a1", name: "Analyst" };

  it("records who last wrote a cell and finds the human cells an op would change", () => {
    const doc = new Y.Doc();
    setRange(
      doc,
      "A1",
      [
        ["Item", "Price"],
        ["Pilot", "100"],
      ],
      { actor: analyst }
    );
    setRange(doc, "B2", [["120"]], { actor: hana });

    expect(sheetEditors(doc).size).toBe(4);
    expect(
      humanWrittenCells(doc, {
        type: "set_range",
        range: "A2",
        values: [["Pilot", "100"]],
      })
    ).toEqual(["B2"]);
    expect(
      humanWrittenCells(doc, {
        type: "set_range",
        range: "B2",
        values: [["120"]],
      })
    ).toEqual([]);
    expect(
      humanWrittenCells(doc, { type: "delete_rows", fromRow: 1, toRow: 2 })
    ).toEqual(["B2"]);
  });

  it("makes the accepting person the editor of accepted cells", () => {
    const doc = new Y.Doc();
    setRange(doc, "A1", [["100"]], { actor: analyst });
    setRange(doc, "A1", [["90"]], suggest);
    acceptSheetSuggestion(doc, "s1", hana);
    expect([...sheetEditors(doc).values()].map((e) => e.name)).toEqual([
      "Hana",
    ]);
  });
});

describe("evaluate", () => {
  it("computes formulas across references in dependency order", () => {
    expect(
      evaluate([
        ["=A2*2", "=SUM(A2:A4)", "=B1/0"],
        ["$1,000", "12%", "TRUE"],
        ["=A1+1", "", ""],
        ["3", "x", ""],
      ])
    ).toEqual([
      [2000, 3004, { error: "#DIV/0!" }],
      [1000, 0.12, true],
      [2001, null, null],
      [3, "x", null],
    ]);
  });

  it("reports cycles and syntax errors as cell errors", () => {
    expect(evaluate([["=B1", "=A1", "=SUM(", "=C9"]])).toEqual([
      [{ error: "#CYCLE!" }, { error: "#CYCLE!" }, { error: "#ERROR!" }, 0],
    ]);
  });
});

describe("toXlsx", () => {
  it("writes formulas with cached results", async () => {
    const doc = sheet([
      ["Price", "Qty", "Total"],
      ["10", "3", "=A2*B2"],
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(await toXlsx(doc, "Quote")).buffer);
    const cell = workbook.getWorksheet("Quote")?.getCell("C2");
    expect(cell?.value).toEqual({ formula: "A2*B2", result: 30 });
  });
});
