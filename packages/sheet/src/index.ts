/// <reference path="./fast-formula-parser.d.ts" />
import FormulaParser from "fast-formula-parser";
import * as Y from "yjs";

export const cellFormats = [
  "text",
  "number",
  "currency",
  "percent",
  "date",
] as const;

export type CellFormat = (typeof cellFormats)[number];

export type ColumnMeta = { width?: number; format?: CellFormat };

export type SheetSuggestion = {
  id: string;
  actorId: string;
  actorName: string;
  approver?: string;
  approverId?: string;
  status: "pending" | "accepted" | "rejected";
  // cell key → proposed input, and the input it replaces as it was when proposed.
  cells: Record<string, string>;
  before: Record<string, string>;
  insertRowIds: string[];
  deleteRowIds: string[];
  createdAt: string;
};

export type CellEditor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type SheetOpOptions = {
  // Who writes; recorded per cell so agents can tell a person's numbers from their own.
  actor?: CellEditor;
  suggest?: {
    id: string;
    actor: { id: string; name: string };
    approver?: string;
    approverId?: string;
  };
};

export type SheetOpResult =
  | { ok: true; range: string }
  | { ok: false; error: string };

export type CellValue = number | string | boolean | null | { error: string };

export type SheetGrid = {
  rowIds: string[];
  colIds: string[];
  inputs: string[][];
  columns: ColumnMeta[];
};

// A1-addressed, 0-based and inclusive.
export type CellRange = {
  top: number;
  left: number;
  bottom: number;
  right: number;
};

export const sheetRows = (doc: Y.Doc) => doc.getArray<string>("sheetRows");
export const sheetCols = (doc: Y.Doc) => doc.getArray<string>("sheetCols");
export const sheetCells = (doc: Y.Doc) => doc.getMap<string>("sheetCells");
export const sheetColumns = (doc: Y.Doc) =>
  doc.getMap<ColumnMeta>("sheetColumns");
export const sheetSuggestions = (doc: Y.Doc) =>
  doc.getMap<SheetSuggestion>("sheetSuggestions");

export const sheetEditors = (doc: Y.Doc) =>
  doc.getMap<CellEditor>("sheetEditors");

export const cellKey = (rowId: string, colId: string) => `${rowId}:${colId}`;

const newId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

export function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

export function columnIndex(letters: string): number {
  return (
    [...letters.toUpperCase()].reduce(
      (sum, char) => sum * 26 + char.charCodeAt(0) - 64,
      0
    ) - 1
  );
}

const cellPattern = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/;

function parseCell(a1: string): { row: number; col: number } | null {
  const match = cellPattern.exec(a1.trim());
  return match
    ? { row: Number(match[2]) - 1, col: columnIndex(match[1]) }
    : null;
}

export function parseRange(a1: string): CellRange | null {
  const [from, to = from] = a1.split(":");
  const start = parseCell(from);
  const end = parseCell(to);
  if (!start || !end) {
    return null;
  }
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.col, end.col),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.col, end.col),
  };
}

export function formatRange({ top, left, bottom, right }: CellRange): string {
  const start = `${columnLetter(left)}${top + 1}`;
  const end = `${columnLetter(right)}${bottom + 1}`;
  return start === end ? start : `${start}:${end}`;
}

export function readGrid(doc: Y.Doc): SheetGrid {
  const rowIds = sheetRows(doc).toArray();
  const colIds = sheetCols(doc).toArray();
  const cells = sheetCells(doc);
  const columns = sheetColumns(doc);
  return {
    rowIds,
    colIds,
    inputs: rowIds.map((rowId) =>
      colIds.map((colId) => cells.get(cellKey(rowId, colId)) ?? "")
    ),
    columns: colIds.map((colId) => columns.get(colId) ?? {}),
  };
}

function grow(
  doc: Y.Doc,
  rowCount: number,
  colCount: number
): { rowIds: string[]; colIds: string[] } {
  const rows = sheetRows(doc);
  const cols = sheetCols(doc);
  const newRowIds = Array.from(
    { length: Math.max(0, rowCount - rows.length) },
    () => newId("r")
  );
  const newColIds = Array.from(
    { length: Math.max(0, colCount - cols.length) },
    () => newId("c")
  );
  rows.push(newRowIds);
  cols.push(newColIds);
  return { rowIds: newRowIds, colIds: newColIds };
}

function writeCells(
  doc: Y.Doc,
  inputs: Record<string, string>,
  actor?: CellEditor
): void {
  const cells = sheetCells(doc);
  const editors = sheetEditors(doc);
  for (const [key, input] of Object.entries(inputs)) {
    if ((cells.get(key) ?? "") === input) {
      continue;
    }
    if (input === "") {
      cells.delete(key);
    } else {
      cells.set(key, input);
    }
    if (actor) {
      editors.set(key, { kind: actor.kind, id: actor.id, name: actor.name });
    }
  }
}

function removeRows(doc: Y.Doc, rowIds: string[]): void {
  const gone = new Set(rowIds);
  const rows = sheetRows(doc);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (gone.has(rows.get(i))) {
      rows.delete(i, 1);
    }
  }
  for (const map of [sheetCells(doc), sheetEditors(doc)]) {
    for (const key of [...map.keys()]) {
      if (gone.has(key.slice(0, key.indexOf(":")))) {
        map.delete(key);
      }
    }
  }
}

function propose(
  doc: Y.Doc,
  suggest: NonNullable<SheetOpOptions["suggest"]>,
  change: Pick<SheetSuggestion, "cells" | "insertRowIds" | "deleteRowIds">
): void {
  const cells = sheetCells(doc);
  sheetSuggestions(doc).set(suggest.id, {
    id: suggest.id,
    actorId: suggest.actor.id,
    actorName: suggest.actor.name,
    ...(suggest.approver ? { approver: suggest.approver } : {}),
    ...(suggest.approverId ? { approverId: suggest.approverId } : {}),
    status: "pending",
    ...change,
    before: Object.fromEntries(
      Object.keys(change.cells).map((key) => [key, cells.get(key) ?? ""])
    ),
    createdAt: new Date().toISOString(),
  });
}

function inputsAt(
  rowIds: string[],
  colIds: string[],
  values: string[][],
  left: number
): Record<string, string> {
  return Object.fromEntries(
    values.flatMap((row, r) =>
      row.map((input, c) => [cellKey(rowIds[r], colIds[left + c]), input])
    )
  );
}

function isRectangular(values: string[][]): boolean {
  return values.length > 0 && values.every((row) => row.length > 0);
}

export function setRange(
  doc: Y.Doc,
  range: string,
  values: string[][],
  opts: SheetOpOptions = {}
): SheetOpResult {
  const parsed = parseRange(range);
  if (!parsed || !isRectangular(values)) {
    return { ok: false, error: `Invalid range ${range} or empty values.` };
  }
  const width = Math.max(...values.map((row) => row.length));
  const target: CellRange = {
    top: parsed.top,
    left: parsed.left,
    bottom: parsed.top + values.length - 1,
    right: parsed.left + width - 1,
  };
  const isSingleCell =
    parsed.top === parsed.bottom && parsed.left === parsed.right;
  if (
    !isSingleCell &&
    (parsed.bottom !== target.bottom || parsed.right !== target.right)
  ) {
    return {
      ok: false,
      error: `Range ${range} does not match ${values.length} row(s) × ${width} column(s) of values; pass only the top-left cell to size it from the values.`,
    };
  }
  doc.transact(() => {
    const grown = grow(doc, target.bottom + 1, target.right + 1);
    const rowIds = sheetRows(doc)
      .toArray()
      .slice(target.top, target.bottom + 1);
    const inputs = inputsAt(
      rowIds,
      sheetCols(doc).toArray(),
      values,
      target.left
    );
    if (opts.suggest) {
      propose(doc, opts.suggest, {
        cells: inputs,
        insertRowIds: grown.rowIds,
        deleteRowIds: [],
      });
    } else {
      writeCells(doc, inputs, opts.actor);
    }
  });
  return { ok: true, range: formatRange(target) };
}

// `afterRow` is the 1-based row the new rows go below; 0 inserts at the top, null appends.
export function addRows(
  doc: Y.Doc,
  afterRow: number | null,
  values: string[][],
  opts: SheetOpOptions = {}
): SheetOpResult {
  const rows = sheetRows(doc);
  const at = afterRow === null ? rows.length : afterRow;
  if (at < 0 || at > rows.length || values.length === 0) {
    return {
      ok: false,
      error: `Row ${afterRow} is outside the sheet (1–${rows.length}).`,
    };
  }
  const width = Math.max(1, ...values.map((row) => row.length));
  doc.transact(() => {
    grow(doc, 0, width);
    const rowIds = values.map(() => newId("r"));
    rows.insert(at, rowIds);
    const inputs = inputsAt(rowIds, sheetCols(doc).toArray(), values, 0);
    if (opts.suggest) {
      propose(doc, opts.suggest, {
        cells: inputs,
        insertRowIds: rowIds,
        deleteRowIds: [],
      });
    } else {
      writeCells(doc, inputs, opts.actor);
    }
  });
  return {
    ok: true,
    range: formatRange({
      top: at,
      left: 0,
      bottom: at + values.length - 1,
      right: width - 1,
    }),
  };
}

// `fromRow` and `toRow` are 1-based and inclusive.
export function deleteRows(
  doc: Y.Doc,
  fromRow: number,
  toRow: number,
  opts: SheetOpOptions = {}
): SheetOpResult {
  const rows = sheetRows(doc);
  if (fromRow < 1 || toRow < fromRow || toRow > rows.length) {
    return {
      ok: false,
      error: `Rows ${fromRow}–${toRow} are outside the sheet (1–${rows.length}).`,
    };
  }
  const rowIds = rows.toArray().slice(fromRow - 1, toRow);
  doc.transact(() => {
    if (opts.suggest) {
      propose(doc, opts.suggest, {
        cells: {},
        insertRowIds: [],
        deleteRowIds: rowIds,
      });
    } else {
      removeRows(doc, rowIds);
    }
  });
  return {
    ok: true,
    range: `${fromRow}:${toRow}`,
  };
}

// `columns` is "B" or "B:D".
export function formatColumns(
  doc: Y.Doc,
  columns: string,
  meta: ColumnMeta
): SheetOpResult {
  const [from, to = from] = columns.split(":");
  if (!/^[A-Za-z]{1,3}$/.test(from) || !/^[A-Za-z]{1,3}$/.test(to)) {
    return {
      ok: false,
      error: `Invalid columns ${columns}; use "B" or "B:D".`,
    };
  }
  const left = Math.min(columnIndex(from), columnIndex(to));
  const right = Math.max(columnIndex(from), columnIndex(to));
  doc.transact(() => {
    grow(doc, 0, right + 1);
    const colIds = sheetCols(doc).toArray();
    const map = sheetColumns(doc);
    for (const colId of colIds.slice(left, right + 1)) {
      map.set(colId, { ...map.get(colId), ...meta });
    }
  });
  return {
    ok: true,
    range: `${columnLetter(left)}:${columnLetter(right)}`,
  };
}

// The person who accepts becomes the cells' editor: the values are now theirs.
export function acceptSheetSuggestion(
  doc: Y.Doc,
  id: string,
  actor?: CellEditor
): void {
  const suggestion = sheetSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  doc.transact(() => {
    writeCells(doc, suggestion.cells, actor);
    removeRows(doc, suggestion.deleteRowIds);
    sheetSuggestions(doc).set(id, { ...suggestion, status: "accepted" });
  });
}

export function rejectSheetSuggestion(doc: Y.Doc, id: string): void {
  const suggestion = sheetSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  doc.transact(() => {
    removeRows(doc, suggestion.insertRowIds);
    sheetSuggestions(doc).set(id, { ...suggestion, status: "rejected" });
  });
}

export type PendingSheetSuggestion = SheetSuggestion & {
  // A1 cells in the current grid, and whether any of them changed since the proposal.
  cellRefs: string[];
  stale: boolean;
};

export function pendingSheetSuggestions(doc: Y.Doc): PendingSheetSuggestion[] {
  const cells = sheetCells(doc);
  const rowIndex = new Map(sheetRows(doc).map((id, i) => [id, i]));
  const colIndex = new Map(sheetCols(doc).map((id, i) => [id, i]));
  const refOf = (key: string) => {
    const [rowId, colId] = key.split(":");
    const row = rowIndex.get(rowId);
    const col = colIndex.get(colId);
    return row === undefined || col === undefined
      ? null
      : `${columnLetter(col)}${row + 1}`;
  };
  return [...sheetSuggestions(doc).values()]
    .filter((suggestion) => suggestion.status === "pending")
    .map((suggestion) => ({
      ...suggestion,
      cellRefs: Object.keys(suggestion.cells).flatMap((key) => {
        const ref = refOf(key);
        return ref ? [ref] : [];
      }),
      stale: Object.entries(suggestion.before).some(
        ([key, input]) => (cells.get(key) ?? "") !== input
      ),
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const numberPattern = /^[-+]?\$?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?(e[-+]?\d+)?%?$/i;

export function literalValue(input: string): CellValue {
  const text = input.trim();
  if (text === "") {
    return null;
  }
  if (/\d/.test(text) && numberPattern.test(text)) {
    const value = Number(text.replace(/[$,%]/g, ""));
    return text.endsWith("%") ? value / 100 : value;
  }
  if (/^(true|false)$/i.test(text)) {
    return text.toLowerCase() === "true";
  }
  return input;
}

const isFormula = (input: string) => input.startsWith("=") && input.length > 1;

function isRangeRef(
  ref: { row: number; col: number } | { from: unknown; to: unknown }
): ref is {
  from: { row: number; col: number };
  to: { row: number; col: number };
} {
  return "from" in ref;
}

function toEngineValue(value: CellValue): unknown {
  return value !== null && typeof value === "object"
    ? new FormulaParser.FormulaError(value.error)
    : value;
}

function fromEngineValue(result: unknown): CellValue {
  const value = Array.isArray(result) ? result.flat()[0] : result;
  if (value instanceof FormulaParser.FormulaError) {
    return { error: value.error };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { error: "#NUM!" };
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  // A formula that lands on an empty cell shows 0, as in Excel.
  return value === null || value === undefined ? 0 : String(value);
}

// ponytail: recalculates every formula on each change; upgrade: keep the dependency graph and
// recompute only the cells downstream of an edit once sheets pass ~10k formulas.
export function evaluate(inputs: string[][]): CellValue[][] {
  const values: CellValue[][] = inputs.map((row) =>
    row.map((input) => (isFormula(input) ? null : literalValue(input)))
  );
  const rowCount = inputs.length;
  const colCount = Math.max(0, ...inputs.map((row) => row.length));
  const formulas = inputs.flatMap((row, r) =>
    row.flatMap((input, c) => (isFormula(input) ? [{ r, c, input }] : []))
  );
  const formulaAt = new Map(formulas.map((f) => [`${f.r}:${f.c}`, f]));

  const depParser = new FormulaParser.DepParser();
  const depsOf = (f: (typeof formulas)[number]) => {
    let refs: ReturnType<typeof depParser.parse> = [];
    try {
      refs = depParser.parse(
        f.input.slice(1),
        { row: f.r + 1, col: f.c + 1 },
        true
      );
    } catch {
      refs = [];
    }
    // O(refs × formulas): both are bounded by the sheet's formula count, small for agent-built
    // sheets (< 2k formulas, well under 100 ms).
    return refs.flatMap((ref) =>
      isRangeRef(ref)
        ? formulas.filter(
            (other) =>
              other.r + 1 >= ref.from.row &&
              other.r + 1 <= ref.to.row &&
              other.c + 1 >= ref.from.col &&
              other.c + 1 <= ref.to.col
          )
        : (formulaAt.get(`${ref.row - 1}:${ref.col - 1}`) ?? [])
    );
  };

  const order: typeof formulas = [];
  const state = new Map<string, "visiting" | "done" | "cycle">();
  const visit = (f: (typeof formulas)[number]): boolean => {
    const key = `${f.r}:${f.c}`;
    const seen = state.get(key);
    if (seen === "done") {
      return true;
    }
    if (seen === "visiting" || seen === "cycle") {
      state.set(key, "cycle");
      return false;
    }
    state.set(key, "visiting");
    const ok = depsOf(f).map(visit).every(Boolean);
    if (!ok || state.get(key) === "cycle") {
      state.set(key, "cycle");
      values[f.r][f.c] = { error: "#CYCLE!" };
      return false;
    }
    state.set(key, "done");
    order.push(f);
    return true;
  };
  for (const f of formulas) {
    visit(f);
  }

  const read = (row: number, col: number) =>
    toEngineValue(values[row - 1]?.[col - 1] ?? null);
  const parser = new FormulaParser({
    onCell: ({ row, col }) => read(row, col),
    onRange: ({ from, to }) =>
      Array.from(
        { length: Math.max(0, Math.min(to.row, rowCount) - from.row + 1) },
        (_, r) =>
          Array.from(
            { length: Math.max(0, Math.min(to.col, colCount) - from.col + 1) },
            (_, c) => read(from.row + r, from.col + c)
          )
      ),
  });
  for (const f of order) {
    try {
      values[f.r][f.c] = fromEngineValue(
        parser.parse(f.input.slice(1), { row: f.r + 1, col: f.c + 1 })
      );
    } catch (err) {
      values[f.r][f.c] =
        err instanceof FormulaParser.FormulaError
          ? { error: err.error }
          : { error: "#ERROR!" };
    }
  }
  return values;
}

const excelEpochMs = Date.UTC(1899, 11, 30);
const dayMs = 86_400_000;

export function formatValue(value: CellValue, format?: CellFormat): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "object") {
    return value.error;
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    return value;
  }
  switch (format) {
    case "currency":
      return value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });
    case "percent":
      return value.toLocaleString("en-US", {
        style: "percent",
        maximumFractionDigits: 2,
      });
    case "date":
      return new Date(excelEpochMs + value * dayMs).toISOString().slice(0, 10);
    case "number":
    case "text":
    case undefined:
      return value.toLocaleString("en-US", { maximumFractionDigits: 10 });
  }
}

export function docFromState(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) {
    Y.applyUpdate(doc, state);
  }
  return doc;
}

function syncArray(target: Y.Array<string>, source: string[]): void {
  const current = target.toArray();
  if (
    current.length !== source.length ||
    current.some((id, i) => id !== source[i])
  ) {
    target.delete(0, target.length);
    target.push(source);
  }
}

function syncMap<T>(target: Y.Map<T>, source: Y.Map<T>): void {
  for (const key of [...target.keys()]) {
    if (!source.has(key)) {
      target.delete(key);
    }
  }
  for (const [key, value] of source.entries()) {
    if (JSON.stringify(target.get(key)) !== JSON.stringify(value)) {
      target.set(key, value);
    }
  }
}

// Writes a version forward as one edit, so the restore is attributed like any other change.
export function restoreSheet(doc: Y.Doc, version: Y.Doc): void {
  doc.transact(() => {
    syncArray(sheetRows(doc), sheetRows(version).toArray());
    syncArray(sheetCols(doc), sheetCols(version).toArray());
    syncMap(sheetCells(doc), sheetCells(version));
    syncMap(sheetColumns(doc), sheetColumns(version));
    syncMap(sheetSuggestions(doc), sheetSuggestions(version));
    syncMap(sheetEditors(doc), sheetEditors(version));
  });
}

export type SheetCellChange = { cell: string; before: string; after: string };

export function diffSheets(before: Y.Doc, after: Y.Doc): SheetCellChange[] {
  const position = (doc: Y.Doc) => {
    const rows = new Map(sheetRows(doc).map((id, i) => [id, i]));
    const cols = new Map(sheetCols(doc).map((id, i) => [id, i]));
    return (key: string) => {
      const [rowId, colId] = key.split(":");
      const row = rows.get(rowId);
      const col = cols.get(colId);
      return row === undefined || col === undefined
        ? null
        : { row, col, a1: `${columnLetter(col)}${row + 1}` };
    };
  };
  const beforeCells = sheetCells(before);
  const afterCells = sheetCells(after);
  const afterAt = position(after);
  const beforeAt = position(before);
  const keys = new Set([...beforeCells.keys(), ...afterCells.keys()]);
  return [...keys]
    .flatMap((key) => {
      const was = beforeCells.get(key) ?? "";
      const now = afterCells.get(key) ?? "";
      const at = afterAt(key) ?? beforeAt(key);
      return was === now || !at
        ? []
        : [{ at, change: { cell: at.a1, before: was, after: now } }];
    })
    .sort((a, b) => a.at.row - b.at.row || a.at.col - b.at.col)
    .map(({ change }) => change);
}

export function cellAt(
  doc: Y.Doc,
  a1: string
): { rowId: string; colId: string } | null {
  const cell = parseCell(a1);
  const rowId = cell ? sheetRows(doc).get(cell.row) : undefined;
  const colId = cell ? sheetCols(doc).get(cell.col) : undefined;
  return rowId && colId ? { rowId, colId } : null;
}

export type SheetTarget =
  | { type: "set_range"; range: string; values: string[][] }
  | { type: "delete_rows"; fromRow: number; toRow: number };

// A1 cells a person wrote that this op would change or remove.
export function humanWrittenCells(doc: Y.Doc, target: SheetTarget): string[] {
  const rows = sheetRows(doc).toArray();
  const cols = sheetCols(doc).toArray();
  const cells = sheetCells(doc);
  const editors = sheetEditors(doc);
  const isHuman = (key: string) =>
    (cells.get(key) ?? "") !== "" && editors.get(key)?.kind === "human";
  if (target.type === "delete_rows") {
    return rows
      .slice(target.fromRow - 1, target.toRow)
      .flatMap((rowId, r) =>
        cols.flatMap((colId, c) =>
          isHuman(cellKey(rowId, colId))
            ? [`${columnLetter(c)}${target.fromRow + r}`]
            : []
        )
      );
  }
  const start = parseRange(target.range);
  if (!start) {
    return [];
  }
  return target.values.flatMap((row, r) =>
    row.flatMap((input, c) => {
      const rowId = rows[start.top + r];
      const colId = cols[start.left + c];
      const key = rowId && colId ? cellKey(rowId, colId) : null;
      return key && isHuman(key) && cells.get(key) !== input
        ? [`${columnLetter(start.left + c)}${start.top + r + 1}`]
        : [];
    })
  );
}
