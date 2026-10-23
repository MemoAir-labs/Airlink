import type { IncomingMessage, ServerResponse } from "node:http";
import type { Document, Hocuspocus } from "@hocuspocus/server";
import type { CanvasOpOptions, CanvasOpResult } from "@memo-air/canvas";
import {
  addShapes,
  canvasElements,
  connect,
  deleteShapes,
  diffCanvases,
  humanWrittenElements,
  pendingCanvasSuggestions,
  readCanvas,
  restoreCanvas,
  updateShapes,
} from "@memo-air/canvas";
import {
  appendMessageText,
  editMessage,
  postMessage,
  react,
  readMessages,
} from "@memo-air/chat";
import { decisionRecordSchema } from "@memo-air/decide";
import type {
  CanvasOp,
  CanvasOpsResponse,
  ChatOp,
  ChatOpsResponse,
  LiveActor,
  LiveOpsResponse,
  LiveTokenClaims,
  RichTextOp,
  SheetOp,
  SheetOpsResponse,
  SlidesOp,
  SlidesOpsResponse,
  SpaceOp,
  SpaceOpsResponse,
} from "@memo-air/protocol";
import {
  allows,
  canvasOpsRequestSchema,
  chatOpsRequestSchema,
  commentRequestSchema,
  liveOpsRequestSchema,
  mediaTokenRequestSchema,
  restoreRequestSchema,
  sheetOpsRequestSchema,
  slidesOpsRequestSchema,
  spaceOpsRequestSchema,
  summariesRequestSchema,
} from "@memo-air/protocol";
import {
  verifyLiveServiceToken,
  verifyLiveToken,
} from "@memo-air/protocol/tokens";
import type { JSONContent, OpOptions, OpResult } from "@memo-air/richtext";
import {
  addThread,
  caretAtEndOf,
  deleteBlock,
  diffOutlines,
  docFragment,
  exportMarkdown,
  fillBlocks,
  fragmentFromState,
  insertBlocks,
  markdownToNodes,
  pendingSuggestions,
  readOutline,
  readThreads,
  replaceBlock,
  replyToThread,
  restoreBlocks,
  sectionAtPosition,
  streamFrames,
} from "@memo-air/richtext";
import type { SheetOpOptions, SheetOpResult } from "@memo-air/sheet";
import {
  addRows,
  cellAt,
  cellKey,
  columnLetter,
  deleteRows,
  diffSheets,
  docFromState,
  evaluate,
  formatColumns,
  formatRange,
  humanWrittenCells,
  parseRange,
  pendingSheetSuggestions,
  readGrid,
  restoreSheet,
  setRange,
  sheetCols,
  sheetEditors,
} from "@memo-air/sheet";
import { toXlsx } from "@memo-air/sheet/xlsx";
import type { DeckOpOptions, DeckOpResult } from "@memo-air/slides";
import {
  addElement as addDeckElement,
  addSlide as addDeckSlide,
  deckElements,
  docFromState as deckFromState,
  deckSlideMeta,
  deleteSlide as deleteDeckSlide,
  diffSlides,
  editElement as editDeckElement,
  humanWrittenElements as humanWrittenDeckElements,
  isDeckDoc,
  moveSlide as moveDeckSlide,
  pendingSlideSuggestions,
  readDeck,
  restoreSlides,
  setTheme as setDeckTheme,
  slideElementIds,
  slideTitle,
  updateSlide as updateDeckSlide,
} from "@memo-air/slides";
import { toPptx as deckToPptx } from "@memo-air/slides/pptx";
import type { SpaceOpResult } from "@memo-air/space";
import {
  bringToFront,
  diffSpaces,
  moveObject,
  placeObject,
  readSpace,
  removeObject,
  resizeObject,
  restoreSpace,
  setWindowState,
} from "@memo-air/space";
import type { Logger } from "pino";
import * as Y from "yjs";
import type { LiveActivity } from "./activity.ts";
import type { LiveBrowserRooms } from "./browser.ts";
import type { LiveDesktopRooms } from "./desktop.ts";
import type { DocKind } from "./kind.ts";
import { isBlank, kindOf } from "./kind.ts";
import type { LiveMediaRooms } from "./media.ts";
import type { LiveMetrics } from "./metrics.ts";
import type { LivePersistence } from "./persistence.ts";
import type { LivePresence } from "./presence.ts";
import type { LiveTurns } from "./turns.ts";

const routePattern =
  /^\/v1\/docs\/([^/]+)\/(ops|sheet-ops|sheet|xlsx|canvas-ops|canvas|slides-ops|deck|pptx|chat-ops|chat|space-ops|space|browser-ops|browser|browser-video|desktop-ops|desktop|media-token|transcript|speak|frames|outline|markdown|history|restore|comments|versions\/(\d+)|frames\/(\d+))$/;
const maxBodyBytes = 1_000_000;
const frameIntervalMs = 30;
const chatChunkChars = 24;
const chatMaxFrames = 100;

type Stream = { frames: JSONContent[][]; caretBlockId: string };

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

type OpsRequest<Op> = {
  ops: Op[];
  mode: "edit" | "suggest";
  approver?: string;
  approverId?: string;
};

type KindRunner<Op, Result> = {
  kind: DocKind;
  request: {
    safeParse(
      body: unknown
    ):
      | { success: true; data: OpsRequest<Op> }
      | { success: false; error: { message: string } };
  };
  apply: (
    context: OpsRequest<Op> & {
      docName: string;
      claims: LiveTokenClaims;
      connection: DirectConnection;
      suggestionId: string | null;
    }
  ) => Promise<{ results: Result[]; suggestionId: string | null }>;
};

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      return null;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const [scheme, token] = (request.headers.authorization ?? "").split(" ");
  return scheme === "Bearer" && token ? token : null;
}

function authenticate(
  request: IncomingMessage,
  docName: string,
  jwtSecret: string
): LiveTokenClaims | null {
  const token = bearerToken(request);
  const claims = token ? verifyLiveToken(token, jwtSecret) : null;
  return claims && allows(claims, docName, "read") ? claims : null;
}

function applyOp(
  fragment: Y.XmlFragment,
  op: RichTextOp,
  opts: OpOptions
): { result: OpResult; stream: Stream | null } {
  switch (op.type) {
    case "delete":
      return { result: deleteBlock(fragment, op.blockId, opts), stream: null };
    case "insert":
    case "replace": {
      const nodes = markdownToNodes(op.markdown);
      const frames = streamFrames(nodes);
      const result =
        op.type === "insert"
          ? insertBlocks(fragment, op.afterBlockId, frames[0], opts)
          : replaceBlock(fragment, op.blockId, frames[0], opts);
      const caretBlockId = nodes.at(-1)?.attrs?.id;
      return {
        result,
        stream:
          result.ok && caretBlockId
            ? { frames: frames.slice(1), caretBlockId }
            : null,
      };
    }
  }
}

function applySheetOp(
  document: Y.Doc,
  op: SheetOp,
  opts: SheetOpOptions
): SheetOpResult {
  switch (op.type) {
    case "set_range":
      return setRange(document, op.range, op.values, opts);
    case "add_rows":
      return addRows(document, op.afterRow, op.values, opts);
    case "delete_rows":
      return deleteRows(document, op.fromRow, op.toRow, opts);
    case "format_columns":
      return formatColumns(document, op.columns, {
        ...(op.format ? { format: op.format } : {}),
        ...(op.width ? { width: op.width } : {}),
      });
  }
}

// Edits stream one row at a time so people watch the agent fill the sheet; suggestions land whole.
function sheetFrames(op: SheetOp): SheetOp[] {
  if (op.type === "set_range" && op.values.length > 1) {
    const start = parseRange(op.range);
    return start
      ? op.values.map((row, r) => ({
          type: "set_range",
          range: `${columnLetter(start.left)}${start.top + r + 1}`,
          values: [row],
        }))
      : [op];
  }
  if (op.type === "add_rows" && op.values.length > 1) {
    return op.values.map((row, r) => ({
      type: "add_rows",
      afterRow: op.afterRow === null ? null : op.afterRow + r,
      values: [row],
    }));
  }
  return [op];
}

function mergeResults(results: SheetOpResult[]): SheetOpResult {
  const failed = results.find((result) => !result.ok);
  if (failed || results.length === 1) {
    return failed ?? results[0];
  }
  const ranges = results.flatMap((result) =>
    result.ok ? [parseRange(result.range)] : []
  );
  const first = ranges[0];
  const last = ranges.at(-1);
  return first && last
    ? {
        ok: true,
        range: formatRange({
          top: first.top,
          left: Math.min(first.left, last.left),
          bottom: last.bottom,
          right: Math.max(first.right, last.right),
        }),
      }
    : results[0];
}

function applyCanvasOp(
  document: Y.Doc,
  op: CanvasOp,
  opts: CanvasOpOptions
): CanvasOpResult {
  switch (op.type) {
    case "add_shapes":
      return addShapes(document, op.shapes, opts);
    case "connect":
      return connect(document, op.arrows, opts);
    case "update_shapes":
      return updateShapes(document, op.updates, opts);
    case "delete_shapes":
      return deleteShapes(document, op.ids, opts);
  }
}

// Shapes stream in one at a time so people watch the agent draw; suggestions land whole.
function canvasFrames(op: CanvasOp): CanvasOp[] {
  if (op.type === "add_shapes" && op.shapes.length > 1) {
    return op.shapes.map((shape) => ({ type: "add_shapes", shapes: [shape] }));
  }
  if (op.type === "connect" && op.arrows.length > 1) {
    return op.arrows.map((arrow) => ({ type: "connect", arrows: [arrow] }));
  }
  return [op];
}

// Shapes a person wrote that this op would change or remove.
function humanWrittenShapes(document: Y.Doc, op: CanvasOp): string[] {
  switch (op.type) {
    case "update_shapes":
      return humanWrittenElements(
        document,
        op.updates.map((update) => update.id)
      );
    case "delete_shapes":
      return humanWrittenElements(document, op.ids);
    case "add_shapes":
    case "connect":
      return [];
  }
}

function readCanvasView(document: Y.Doc) {
  return {
    ...readCanvas(document),
    suggestions: pendingCanvasSuggestions(document).map((suggestion) => ({
      id: suggestion.id,
      actorName: suggestion.actorName,
      ...(suggestion.approver ? { approver: suggestion.approver } : {}),
      changes: suggestion.changes,
      stale: suggestion.stale,
    })),
  };
}

function applySlidesOp(
  document: Y.Doc,
  op: SlidesOp,
  opts: DeckOpOptions
): DeckOpResult {
  switch (op.type) {
    case "add_slide": {
      const { type: _type, ...spec } = op;
      return addDeckSlide(document, spec, opts);
    }
    case "update_slide": {
      const { type: _type, ...spec } = op;
      return updateDeckSlide(document, spec, opts);
    }
    case "move_slide":
      return moveDeckSlide(document, op.slide, op.position, opts);
    case "delete_slide":
      return deleteDeckSlide(document, op.slide, opts);
    case "set_theme":
      return setDeckTheme(
        document,
        { themeId: op.themeId, overrides: op.overrides },
        opts
      );
    case "edit_element": {
      const { type: _type, ...spec } = op;
      return editDeckElement(document, spec, opts);
    }
    case "add_element": {
      const { type: _type, ...spec } = op;
      return addDeckElement(document, spec, opts);
    }
  }
}

const slotFields = [
  ["title", "title"],
  ["subtitle", "subtitle"],
  ["bullets", "body"],
  ["rightBullets", "right"],
  ["quote", "quote"],
  ["attribution", "attribution"],
  ["chart", "chart"],
  ["image", "image"],
] as const;

// Elements a person wrote that this op would change or remove.
function humanWrittenDeckTargets(document: Y.Doc, op: SlidesOp): string[] {
  switch (op.type) {
    case "update_slide": {
      const ids = op.layout
        ? slideElementIds(document, op.slide)
        : slotFields.flatMap(([field, slot]) =>
            op[field] === undefined ? [] : [`${op.slide}-${slot}`]
          );
      return humanWrittenDeckElements(document, ids);
    }
    case "delete_slide":
      return humanWrittenDeckElements(
        document,
        slideElementIds(document, op.slide)
      );
    case "edit_element":
      return humanWrittenDeckElements(document, [op.element]);
    case "add_slide":
    case "move_slide":
    case "set_theme":
    case "add_element":
      return [];
  }
}

function readDeckView(document: Y.Doc) {
  return {
    ...readDeck(document),
    suggestions: pendingSlideSuggestions(document).map((suggestion) => ({
      id: suggestion.id,
      actorName: suggestion.actorName,
      ...(suggestion.approver ? { approver: suggestion.approver } : {}),
      lines: suggestion.lines.map(({ kind, label }) => ({ kind, label })),
      stale: suggestion.stale,
    })),
  };
}

const maxReadRows = 500;

function readSheetView(document: Y.Doc, range: string | null) {
  const grid = readGrid(document);
  const editors = sheetEditors(document);
  const editorOf = (r: number, c: number) => {
    const editor = editors.get(cellKey(grid.rowIds[r], grid.colIds[c]));
    return editor ? { kind: editor.kind, name: editor.name } : null;
  };
  const values = evaluate(grid.inputs);
  const colCount = grid.colIds.length;
  const bounds = (range ? parseRange(range) : null) ?? {
    top: 0,
    left: 0,
    bottom: grid.rowIds.length - 1,
    right: colCount - 1,
  };
  const bottom = Math.min(
    bounds.bottom,
    grid.rowIds.length - 1,
    bounds.top + maxReadRows - 1
  );
  const right = Math.min(bounds.right, colCount - 1);
  const rows = [];
  for (let r = bounds.top; r <= bottom; r++) {
    const cells = [];
    for (let c = bounds.left; c <= right; c++) {
      cells.push({
        cell: `${columnLetter(c)}${r + 1}`,
        input: grid.inputs[r][c],
        value: values[r][c],
        editor: editorOf(r, c),
      });
    }
    rows.push({ row: r + 1, cells });
  }
  const rowOf = new Map(grid.rowIds.map((id, i) => [id, i]));
  const colOf = new Map(grid.colIds.map((id, i) => [id, i]));
  return {
    range:
      bottom >= bounds.top && right >= bounds.left
        ? formatRange({ top: bounds.top, left: bounds.left, bottom, right })
        : null,
    rowCount: grid.rowIds.length,
    colCount,
    columns: grid.columns.map((meta, c) => ({
      column: columnLetter(c),
      ...meta,
    })),
    rows,
    suggestions: pendingSheetSuggestions(document).map((suggestion) => ({
      id: suggestion.id,
      actorName: suggestion.actorName,
      ...(suggestion.approver ? { approver: suggestion.approver } : {}),
      cells: Object.entries(suggestion.cells).flatMap(([key, after]) => {
        const [rowId, colId] = key.split(":");
        const r = rowOf.get(rowId);
        const c = colOf.get(colId);
        return r === undefined || c === undefined
          ? []
          : [
              {
                cell: `${columnLetter(c)}${r + 1}`,
                before: suggestion.before[key] ?? "",
                after,
              },
            ];
      }),
      insertRows: suggestion.insertRowIds.length,
      deleteRows: suggestion.deleteRowIds.length,
      stale: suggestion.stale,
    })),
  };
}

export function createAgentOps({
  hocuspocus,
  persistence,
  activity,
  presence,
  browserRooms,
  desktopRooms,
  mediaRooms,
  turns,
  jwtSecret,
  metrics,
  logger,
  logEvent,
}: {
  hocuspocus: Hocuspocus;
  persistence: LivePersistence;
  activity: LiveActivity;
  presence: LivePresence;
  browserRooms: LiveBrowserRooms;
  desktopRooms: LiveDesktopRooms;
  mediaRooms: LiveMediaRooms;
  turns: LiveTurns;
  jwtSecret: string;
  metrics: LiveMetrics;
  logger: Logger;
  logEvent: (
    docName: string,
    type: string,
    actor: LiveActor,
    payload: Record<string, unknown>
  ) => void;
}) {
  const showPresence = presence.show;

  const showCaret = (
    document: Document,
    docName: string,
    actor: LiveActor,
    blockId: string
  ) => {
    const cursor = caretAtEndOf(docFragment(document), blockId);
    showPresence(
      document,
      docName,
      actor,
      { cursor },
      cursor ? sectionAtPosition(document, cursor.head) : null
    );
  };

  // A sheet caret is the cell being written; the section is that column's header.
  const showCell = (
    document: Document,
    docName: string,
    actor: LiveActor,
    range: string
  ) => {
    const start = range.split(":")[0];
    const cell = cellAt(document, start);
    if (!cell) {
      return;
    }
    const header =
      readGrid(document).inputs[0]?.[
        sheetCols(document).toArray().indexOf(cell.colId)
      ];
    showPresence(
      document,
      docName,
      actor,
      { cell },
      header || start.replace(/\d+$/, "")
    );
  };

  // A canvas caret is a pointer at the shape being drawn; the section is its slide or label.
  const showShape = (
    document: Document,
    docName: string,
    actor: LiveActor,
    id: string
  ) => {
    const elements = canvasElements(document);
    const element = elements.get(id);
    if (!element) {
      return;
    }
    const frame = element.frameId ? elements.get(element.frameId) : undefined;
    const label = element.boundElements?.find((b) => b.type === "text");
    const section =
      (frame ?? element).name ??
      (label ? elements.get(label.id)?.originalText : element.originalText) ??
      null;
    showPresence(
      document,
      docName,
      actor,
      {
        pointer: {
          x: element.x + element.width / 2,
          y: element.y + element.height / 2,
        },
      },
      typeof section === "string" ? section.slice(0, 80) : null
    );
  };

  // A deck caret is the slide (and element) being written; the section is the slide's title.
  const showSlideFocus = (
    document: Document,
    docName: string,
    actor: LiveActor,
    ids: string[]
  ) => {
    const elementId = ids.find((id) => deckElements(document).has(id)) ?? null;
    const slideId =
      ids.find((id) => deckSlideMeta(document).has(id)) ??
      (elementId
        ? String(deckElements(document).get(elementId)?.get("slideId") ?? "")
        : null);
    if (!slideId) {
      return;
    }
    showPresence(
      document,
      docName,
      actor,
      { slideFocus: { slideId, elementId } },
      slideTitle(document, slideId)
    );
  };

  const runKindOps = async <Op extends { type: string }, Result>(
    route: string,
    runner: KindRunner<Op, Result>,
    docName: string,
    claims: LiveTokenClaims,
    body: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const parsed = runner.request.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.message } };
    }
    const mode = claims.access === "suggest" ? "suggest" : parsed.data.mode;
    const startedAt = performance.now();
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: claims.access,
      workspaceId: claims.workspaceId,
    });
    try {
      const document = connection.document;
      const kind = document ? kindOf(document) : runner.kind;
      if (document && kind !== runner.kind && !isBlank(document)) {
        return { status: 409, body: { error: "kind_mismatch", kind, route } };
      }
      const { results, suggestionId } = await runner.apply({
        ...parsed.data,
        mode,
        docName,
        claims,
        connection,
        suggestionId: mode === "suggest" ? crypto.randomUUID() : null,
      });
      metrics.agentOpMs.observe(performance.now() - startedAt);
      logEvent(docName, "agent_ops", claims.actor, {
        mode,
        suggestionId,
        ops: parsed.data.ops.map((op) => op.type),
      });
      return { status: 200, body: { results, suggestionId } };
    } finally {
      await connection.disconnect();
    }
  };

  const richTextRunner: KindRunner<
    RichTextOp,
    LiveOpsResponse["results"][number]
  > = {
    kind: "doc",
    request: liveOpsRequestSchema,
    apply: async ({
      ops,
      approver,
      approverId,
      docName,
      claims,
      connection,
      suggestionId,
    }) => {
      const opts: OpOptions = suggestionId
        ? {
            suggest: {
              id: suggestionId,
              actor: claims.actor,
              approver,
              approverId,
            },
          }
        : {};
      const applied: { result: OpResult; stream: Stream | null }[] = [];
      await connection.transact((document) => {
        const fragment = docFragment(document);
        for (const op of ops) {
          applied.push(applyOp(fragment, op, opts));
        }
      });
      for (const { stream } of applied) {
        if (!stream) {
          continue;
        }
        for (const frame of stream.frames) {
          if (connection.document) {
            showCaret(
              connection.document,
              docName,
              claims.actor,
              stream.caretBlockId
            );
          }
          await new Promise((resolve) => setTimeout(resolve, frameIntervalMs));
          await connection.transact((document) =>
            fillBlocks(docFragment(document), frame)
          );
        }
        if (connection.document) {
          showCaret(
            connection.document,
            docName,
            claims.actor,
            stream.caretBlockId
          );
        }
      }
      return { results: applied.map(({ result }) => result), suggestionId };
    },
  };

  const sheetRunner: KindRunner<SheetOp, SheetOpsResponse["results"][number]> =
    {
      kind: "sheet",
      request: sheetOpsRequestSchema,
      apply: async ({
        ops,
        approver,
        approverId,
        docName,
        claims,
        connection,
        suggestionId: presetId,
      }) => {
        let suggestionId = presetId;
        const suggestOpts = (id: string): SheetOpOptions => ({
          actor: claims.actor,
          suggest: { id, actor: claims.actor, approver, approverId },
        });
        const opts: SheetOpOptions = suggestionId
          ? suggestOpts(suggestionId)
          : { actor: claims.actor };
        const results: SheetOpsResponse["results"] = [];
        // Suggestions land whole, without streaming; the caret still marks where the agent proposed.
        const showSuggested = (applied: SheetOpResult[]) => {
          const last = applied.findLast((result) => result.ok);
          if (last?.ok && connection.document) {
            showCell(connection.document, docName, claims.actor, last.range);
          }
        };
        if (suggestionId) {
          await connection.transact((document) => {
            for (const op of ops) {
              results.push(applySheetOp(document, op, opts));
            }
          });
          showSuggested(results);
          return { results, suggestionId };
        }
        for (const op of ops) {
          // An agent never overwrites a person's cell: that op lands as a suggestion instead.
          const humanCells =
            connection.document &&
            (op.type === "set_range" || op.type === "delete_rows")
              ? humanWrittenCells(connection.document, op)
              : [];
          if (humanCells.length > 0) {
            suggestionId ??= crypto.randomUUID();
            const id = suggestionId;
            const suggested: SheetOpResult[] = [];
            await connection.transact((document) => {
              suggested.push(applySheetOp(document, op, suggestOpts(id)));
            });
            results.push(
              ...suggested.map((result) =>
                result.ok ? { ...result, suggested: true, humanCells } : result
              )
            );
            showSuggested(suggested);
            continue;
          }
          const frames: SheetOpResult[] = [];
          for (const [i, frame] of sheetFrames(op).entries()) {
            if (i > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, frameIntervalMs)
              );
            }
            await connection.transact((document) => {
              frames.push(applySheetOp(document, frame, opts));
            });
            const last = frames.at(-1);
            if (!last?.ok) {
              break;
            }
            if (connection.document && frame.type !== "format_columns") {
              showCell(connection.document, docName, claims.actor, last.range);
            }
          }
          results.push(mergeResults(frames));
        }
        return { results, suggestionId };
      },
    };

  const canvasRunner: KindRunner<
    CanvasOp,
    CanvasOpsResponse["results"][number]
  > = {
    kind: "canvas",
    request: canvasOpsRequestSchema,
    apply: async ({
      ops,
      approver,
      approverId,
      docName,
      claims,
      connection,
      suggestionId: presetId,
    }) => {
      let suggestionId = presetId;
      const suggestOpts = (id: string): CanvasOpOptions => ({
        actor: claims.actor,
        suggest: { id, actor: claims.actor, approver, approverId },
      });
      const opts: CanvasOpOptions = suggestionId
        ? suggestOpts(suggestionId)
        : { actor: claims.actor };
      const results: CanvasOpsResponse["results"] = [];
      const point = (result: CanvasOpResult) => {
        const id = result.ok ? result.ids.at(-1) : undefined;
        if (id && connection.document) {
          showShape(connection.document, docName, claims.actor, id);
        }
      };
      if (suggestionId) {
        await connection.transact((document) => {
          for (const op of ops) {
            results.push(applyCanvasOp(document, op, opts));
          }
        });
        const last = results.findLast((result) => result.ok);
        if (last) {
          point(last);
        }
        return { results, suggestionId };
      }
      for (const op of ops) {
        // An agent never overwrites a person's shape: that op lands as a suggestion instead.
        const humanShapes = connection.document
          ? humanWrittenShapes(connection.document, op)
          : [];
        if (humanShapes.length > 0) {
          suggestionId ??= crypto.randomUUID();
          const id = suggestionId;
          const suggested: CanvasOpResult[] = [];
          await connection.transact((document) => {
            suggested.push(applyCanvasOp(document, op, suggestOpts(id)));
          });
          const [result] = suggested;
          results.push(
            result.ok ? { ...result, suggested: true, humanShapes } : result
          );
          point(result);
          continue;
        }
        const ids: string[] = [];
        let failure: CanvasOpResult | null = null;
        for (const [i, frame] of canvasFrames(op).entries()) {
          if (i > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, frameIntervalMs * 4)
            );
          }
          const frames: CanvasOpResult[] = [];
          await connection.transact((document) => {
            frames.push(applyCanvasOp(document, frame, opts));
          });
          const [applied] = frames;
          if (!applied.ok) {
            failure = applied;
            break;
          }
          ids.push(...applied.ids);
          point(applied);
        }
        results.push(failure ?? { ok: true, ids });
      }
      return { results, suggestionId };
    },
  };

  const slidesRunner: KindRunner<
    SlidesOp,
    SlidesOpsResponse["results"][number]
  > = {
    kind: "slides",
    request: slidesOpsRequestSchema,
    apply: async ({
      ops,
      mode,
      approver,
      approverId,
      docName,
      claims,
      connection,
      suggestionId: presetId,
    }) => {
      let suggestionId = presetId;
      const suggestOpts = (id: string): DeckOpOptions => ({
        actor: claims.actor,
        suggest: { id, actor: claims.actor, approver, approverId },
      });
      const results: SlidesOpsResponse["results"] = [];
      for (const [i, op] of ops.entries()) {
        // An agent never overwrites what a person wrote: that op lands as a suggestion instead.
        const humanElements =
          mode === "suggest" || !connection.document
            ? []
            : humanWrittenDeckTargets(connection.document, op);
        if (humanElements.length > 0) {
          suggestionId ??= crypto.randomUUID();
        }
        const opts: DeckOpOptions =
          suggestionId && (mode === "suggest" || humanElements.length > 0)
            ? suggestOpts(suggestionId)
            : { actor: claims.actor };
        if (i > 0 && !opts.suggest) {
          // Slides appear one at a time so people watch the deck being built.
          await new Promise((resolve) =>
            setTimeout(resolve, frameIntervalMs * 6)
          );
        }
        const applied: DeckOpResult[] = [];
        await connection.transact((document) => {
          applied.push(applySlidesOp(document, op, opts));
        });
        const [result] = applied;
        results.push(
          result.ok && humanElements.length > 0
            ? { ...result, suggested: true, humanElements }
            : result
        );
        if (result.ok && connection.document) {
          showSlideFocus(
            connection.document,
            docName,
            claims.actor,
            result.ids
          );
        }
      }
      return { results, suggestionId };
    },
  };

  // Chat is never binding: a suggest token posts like a write token and nothing becomes a
  // suggestion. A post streams by appending to the message's Y.Text, never by rewriting it.
  const chatRunner: KindRunner<ChatOp, ChatOpsResponse["results"][number]> = {
    kind: "chat",
    request: chatOpsRequestSchema,
    apply: async ({ ops, docName, claims, connection }) => {
      const results: ChatOpsResponse["results"] = [];
      const showTyping = (messageId: string) => {
        if (connection.document) {
          showPresence(
            connection.document,
            docName,
            claims.actor,
            { messageId },
            "chat"
          );
        }
      };
      for (const op of ops) {
        switch (op.type) {
          case "post_message": {
            const posted: ChatOpsResponse["results"] = [];
            await connection.transact((document) => {
              posted.push(
                postMessage(document, { ...op, text: "" }, claims.actor)
              );
            });
            const [result] = posted;
            if (!result.ok) {
              results.push(result);
              break;
            }
            const step = Math.max(
              chatChunkChars,
              Math.ceil(op.text.length / chatMaxFrames)
            );
            for (let shown = 0; shown < op.text.length; shown += step) {
              if (shown > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, frameIntervalMs)
                );
              }
              const delta = op.text.slice(shown, shown + step);
              await connection.transact((document) =>
                appendMessageText(document, result.id, delta, claims.actor)
              );
              showTyping(result.id);
            }
            if (connection.document) {
              presence.hide(connection.document, docName, claims.actor);
            }
            results.push(result);
            break;
          }
          case "edit_message":
            await connection.transact((document) =>
              results.push(editMessage(document, op.id, op.text, claims.actor))
            );
            break;
          case "react":
            await connection.transact((document) =>
              results.push(react(document, op.id, op.emoji, claims.actor))
            );
            break;
          case "typing":
            if (connection.document) {
              showPresence(
                connection.document,
                docName,
                claims.actor,
                { typing: true },
                "chat"
              );
            }
            results.push({ ok: true, id: "" });
            break;
        }
      }
      return { results, suggestionId: null };
    },
  };

  // A space is never binding either: every op applies for a write or suggest token alike, and
  // an agent's change to a window a person arranged comes back refused from the model.
  const applySpaceOp = (
    document: Y.Doc,
    op: SpaceOp,
    actor: LiveActor
  ): SpaceOpResult => {
    switch (op.type) {
      case "place":
        return placeObject(document, op, actor);
      case "move":
        return moveObject(document, op.id, op.x, op.y, actor);
      case "resize":
        return resizeObject(document, op.id, op.w, op.h, actor);
      case "remove":
        return removeObject(document, op.id, actor);
      case "bring_to_front":
        return bringToFront(document, op.id, actor);
      case "set_state":
        return setWindowState(document, op.id, op.state, actor);
    }
  };

  const spaceRunner: KindRunner<SpaceOp, SpaceOpsResponse["results"][number]> =
    {
      kind: "space",
      request: spaceOpsRequestSchema,
      apply: async ({ ops, docName, claims, connection }) => {
        const results: SpaceOpsResponse["results"] = [];
        for (const op of ops) {
          const applied: SpaceOpResult[] = [];
          await connection.transact((document) => {
            applied.push(applySpaceOp(document, op, claims.actor));
          });
          const [result] = applied;
          results.push(result);
          if (op.type === "place" && result.ok && connection.document) {
            showPresence(
              connection.document,
              docName,
              claims.actor,
              { objectId: result.id },
              op.title
            );
          }
        }
        return { results, suggestionId: null };
      },
    };

  const opsRoutes = new Map<
    string,
    (
      docName: string,
      claims: LiveTokenClaims,
      body: unknown
    ) => Promise<{ status: number; body: unknown }>
  >([
    ["ops", (d, c, b) => runKindOps("ops", richTextRunner, d, c, b)],
    ["sheet-ops", (d, c, b) => runKindOps("sheet-ops", sheetRunner, d, c, b)],
    [
      "canvas-ops",
      (d, c, b) => runKindOps("canvas-ops", canvasRunner, d, c, b),
    ],
    [
      "slides-ops",
      (d, c, b) => runKindOps("slides-ops", slidesRunner, d, c, b),
    ],
    ["chat-ops", (d, c, b) => runKindOps("chat-ops", chatRunner, d, c, b)],
    ["space-ops", (d, c, b) => runKindOps("space-ops", spaceRunner, d, c, b)],
    ["browser-ops", (d, c, b) => browserRooms.runOps(d, c, b)],
    ["desktop-ops", (d, c, b) => desktopRooms.runOps(d, c, b)],
  ]);

  // An agent reading an object shows up in it the way an edit does, so people see where it is
  // looking before it writes anything.
  const showReading = (
    connection: DirectConnection,
    docName: string,
    claims: LiveTokenClaims
  ) => {
    if (
      claims.actor.kind === "agent" &&
      claims.via !== "script" &&
      connection.document
    ) {
      showPresence(
        connection.document,
        docName,
        claims.actor,
        { reading: true },
        null,
        { writing: false }
      );
    }
  };

  const withDocument = async <T>(
    docName: string,
    claims: LiveTokenClaims,
    read: (document: Y.Doc) => T
  ): Promise<Awaited<T>> => {
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: "read",
      workspaceId: claims.workspaceId,
    });
    showReading(connection, docName, claims);
    try {
      return await read(connection.document ?? new Y.Doc());
    } finally {
      await connection.disconnect();
    }
  };

  const read = async (docName: string, claims: LiveTokenClaims) => {
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: "read",
      workspaceId: claims.workspaceId,
    });
    showReading(connection, docName, claims);
    try {
      const document = connection.document ?? new Y.Doc();
      const fragment = docFragment(document);
      return {
        outline: readOutline(fragment),
        suggestions: pendingSuggestions(fragment),
        threads: readThreads(document)
          .filter((thread) => !thread.resolved)
          .map(({ id, blockId, quote, detached, messages }) => ({
            id,
            blockId,
            quote,
            detached,
            messages: messages.map(({ actor, body }) => ({ actor, body })),
          })),
        markdown: exportMarkdown(fragment),
      };
    } finally {
      await connection.disconnect();
    }
  };

  const restore = async (
    docName: string,
    claims: LiveTokenClaims,
    body: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const parsed = restoreRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.message } };
    }
    const state = await persistence.stateAt(docName, parsed.data.uptoId);
    const version = fragmentFromState(state);
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: claims.access,
      workspaceId: claims.workspaceId,
    });
    try {
      await connection.transact((document) => {
        const fragment = docFragment(document);
        if (fragment.length > 0 || version.length > 0) {
          restoreBlocks(fragment, version);
        }
        const versionDoc = docFromState(state);
        restoreSheet(document, versionDoc);
        restoreCanvas(document, versionDoc);
        restoreSpace(document, versionDoc);
        if (isDeckDoc(document) || isDeckDoc(versionDoc)) {
          restoreSlides(document, versionDoc);
        }
      });
    } finally {
      await connection.disconnect();
    }
    logEvent(docName, "restore", claims.actor, { uptoId: parsed.data.uptoId });
    return { status: 200, body: { ok: true } };
  };

  const comment = async (
    docName: string,
    claims: LiveTokenClaims,
    body: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const parsed = commentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.message } };
    }
    const request = parsed.data;
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: claims.access,
      workspaceId: claims.workspaceId,
    });
    const written: { threadId: string | null } = { threadId: null };
    try {
      await connection.transact((document) => {
        written.threadId =
          "threadId" in request
            ? replyToThread(document, request.threadId, {
                actor: claims.actor,
                body: request.body,
              })
              ? request.threadId
              : null
            : addThread(document, {
                blockId: request.blockId,
                quote: request.quote,
                actor: claims.actor,
                body: request.body,
              });
      });
    } finally {
      await connection.disconnect();
    }
    const { threadId } = written;
    if (!threadId) {
      return { status: 404, body: { error: "No such comment thread." } };
    }
    logEvent(docName, "comment", claims.actor, { threadId });
    return { status: 200, body: { threadId } };
  };

  const version = async (
    docName: string,
    uptoId: string,
    sinceId: string | null
  ) => {
    const afterState = await persistence.stateAt(docName, uptoId);
    const beforeState = sinceId
      ? await persistence.stateAt(docName, sinceId)
      : null;
    const after = fragmentFromState(afterState);
    const before = fragmentFromState(beforeState);
    return {
      uptoId,
      markdown: exportMarkdown(after),
      diff: diffOutlines(readOutline(before), readOutline(after)),
      cells: diffSheets(docFromState(beforeState), docFromState(afterState)),
      shapes: diffCanvases(docFromState(beforeState), docFromState(afterState)),
      objects: diffSpaces(docFromState(beforeState), docFromState(afterState)),
      slides: diffSlides(deckFromState(beforeState), deckFromState(afterState)),
    };
  };

  const summaries = async (workspaceId: string, body: unknown) => {
    const parsed = summariesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: parsed.error.message } };
    }
    return {
      status: 200,
      body: {
        summaries: await activity.summarize(
          workspaceId,
          parsed.data.docNames,
          parsed.data.viewerId
        ),
      },
    };
  };

  return async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://live");
    if (url.pathname === "/v1/summaries" || url.pathname === "/v1/decisions") {
      const token = bearerToken(request);
      const service = token ? verifyLiveServiceToken(token, jwtSecret) : null;
      if (!service) {
        sendJson(response, 401, { error: "unauthorized" });
      } else if (request.method !== "POST") {
        sendJson(response, 405, { error: "method not allowed" });
      } else {
        try {
          const body = await readJson(request);
          if (url.pathname === "/v1/decisions") {
            const parsed = decisionRecordSchema.safeParse(body);
            if (!parsed.success) {
              sendJson(response, 400, { error: parsed.error.message });
            } else {
              turns.record({
                ...parsed.data,
                workspaceId: service.workspaceId,
              });
              response.writeHead(204);
              response.end();
            }
          } else {
            const result = await summaries(service.workspaceId, body);
            sendJson(response, result.status, result.body);
          }
        } catch (err) {
          logger.error({ err }, "live: service route failed");
          sendJson(response, 500, { error: "internal error" });
        }
      }
      return true;
    }
    const match = routePattern.exec(url.pathname);
    if (!match) {
      return false;
    }
    const docName = decodeURIComponent(match[1]);
    const route = match[3] ? "versions" : match[4] ? "frame" : match[2];
    const claims = authenticate(request, docName, jwtSecret);
    if (!claims) {
      sendJson(response, 401, { error: "unauthorized" });
      return true;
    }

    try {
      const runOps = opsRoutes.get(route);
      if (runOps) {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else if (!allows(claims, docName, "agent_ops")) {
          sendJson(response, 403, { error: "forbidden" });
        } else {
          const result = await runOps(docName, claims, await readJson(request));
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "sheet") {
        sendJson(
          response,
          200,
          await withDocument(docName, claims, (document) =>
            readSheetView(document, url.searchParams.get("range"))
          )
        );
        return true;
      }

      if (route === "xlsx") {
        const title = url.searchParams.get("title") || "Sheet";
        const buffer = await withDocument(docName, claims, (document) =>
          toXlsx(document, title)
        );
        response.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        response.end(buffer);
        return true;
      }

      if (route === "canvas") {
        sendJson(
          response,
          200,
          await withDocument(docName, claims, readCanvasView)
        );
        return true;
      }

      if (route === "chat") {
        const since = Number(url.searchParams.get("since"));
        const limit = Number(url.searchParams.get("limit"));
        sendJson(response, 200, {
          messages: await withDocument(docName, claims, (document) =>
            readMessages(document, {
              ...(since > 0 ? { since } : {}),
              ...(limit > 0 ? { limit } : {}),
            })
          ),
        });
        return true;
      }

      if (route === "space") {
        sendJson(response, 200, {
          objects: await withDocument(docName, claims, readSpace),
        });
        return true;
      }

      if (route === "deck") {
        sendJson(
          response,
          200,
          await withDocument(docName, claims, readDeckView)
        );
        return true;
      }

      if (route === "pptx") {
        const title = url.searchParams.get("title") || "Slides";
        const buffer = await withDocument(docName, claims, (document) =>
          isDeckDoc(document) ? deckToPptx(document, title) : null
        );
        if (!buffer) {
          sendJson(response, 404, {
            error: "Only live slides export to pptx.",
          });
          return true;
        }
        response.writeHead(200, {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        });
        response.end(buffer);
        return true;
      }

      if (route === "browser") {
        const result = await browserRooms.read(
          docName,
          claims,
          url.searchParams.get("screenshot") === "1"
        );
        sendJson(response, result.status, result.body);
        return true;
      }

      if (route === "desktop") {
        const result = await desktopRooms.read(
          docName,
          claims,
          url.searchParams.get("screenshot") === "1"
        );
        sendJson(response, result.status, result.body);
        return true;
      }

      if (route === "browser-video") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else {
          const result = await browserRooms.videoGrant(docName, claims);
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "media-token") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else {
          const parsed = mediaTokenRequestSchema.safeParse(
            (await readJson(request)) ?? {}
          );
          const result = await mediaRooms.token(
            docName,
            claims,
            parsed.success ? (parsed.data.viewer ?? null) : null
          );
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "transcript") {
        if (request.method === "POST") {
          if (!allows(claims, docName, "comment")) {
            sendJson(response, 403, { error: "forbidden" });
          } else {
            const result = await mediaRooms.addLine(
              docName,
              claims,
              await readJson(request)
            );
            sendJson(response, result.status, result.body);
          }
        } else {
          const result = await mediaRooms.transcript(docName, claims);
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "speak") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else if (!allows(claims, docName, "agent_ops")) {
          sendJson(response, 403, { error: "forbidden" });
        } else {
          const result = await mediaRooms.speak(
            docName,
            claims,
            await readJson(request)
          );
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "frames") {
        sendJson(response, 200, {
          frames: await persistence.listFrames(docName),
        });
        return true;
      }

      if (route === "frame") {
        const jpeg = await persistence.frame(docName, match[4]);
        if (!jpeg) {
          sendJson(response, 404, { error: "no such frame" });
        } else {
          response.writeHead(200, { "Content-Type": "image/jpeg" });
          response.end(jpeg);
        }
        return true;
      }

      if (route === "restore") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else if (!allows(claims, docName, "restore")) {
          sendJson(response, 403, { error: "forbidden" });
        } else {
          const result = await restore(
            docName,
            claims,
            await readJson(request)
          );
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "comments") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "method not allowed" });
        } else if (!allows(claims, docName, "comment")) {
          sendJson(response, 403, { error: "forbidden" });
        } else {
          const result = await comment(
            docName,
            claims,
            await readJson(request)
          );
          sendJson(response, result.status, result.body);
        }
        return true;
      }

      if (route === "history") {
        sendJson(response, 200, await persistence.history(docName));
        return true;
      }

      if (route === "versions") {
        const sinceId = url.searchParams.get("since");
        sendJson(
          response,
          200,
          await version(
            docName,
            match[3],
            sinceId && /^\d+$/.test(sinceId) ? sinceId : null
          )
        );
        return true;
      }

      const view = await read(docName, claims);
      if (route === "outline") {
        sendJson(response, 200, {
          blocks: view.outline,
          suggestions: view.suggestions,
          threads: view.threads,
        });
      } else {
        response.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
        response.end(view.markdown);
      }
    } catch (err) {
      logger.error({ err, docName, route }, "live: agent request failed");
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal error" });
      }
    }
    return true;
  };
}
