import { generateNKeysBetween } from "fractional-indexing";
import type * as Y from "yjs";

// Excalidraw 0.18 element JSON. The server builds only the fields below; the client passes every
// element through Excalidraw's restoreElements, which fills in anything left out.
export type CanvasElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  frameId: string | null;
  boundElements: readonly { id: string; type: "text" | "arrow" }[] | null;
  containerId?: string | null;
  text?: string;
  originalText?: string;
  fontSize?: number;
  name?: string | null;
  points?: readonly (readonly [number, number])[];
  startBinding?: CanvasBinding | null;
  endBinding?: CanvasBinding | null;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CanvasBinding = { elementId: string; focus: number; gap: number };

export type CanvasEditor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type CanvasSuggestion = {
  id: string;
  actorId: string;
  actorName: string;
  approver?: string;
  approverId?: string;
  status: "pending" | "accepted" | "rejected";
  // element id → proposed element, and the element it replaces as it was when proposed.
  after: Record<string, CanvasElement>;
  before: Record<string, CanvasElement | null>;
  createdAt: string;
};

export type CanvasOpOptions = {
  actor?: CanvasEditor;
  suggest?: {
    id: string;
    actor: { id: string; name: string };
    approver?: string;
    approverId?: string;
  };
};

export type CanvasOpResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export const shapeTypes = ["rectangle", "ellipse", "diamond", "text"] as const;
export type ShapeType = (typeof shapeTypes)[number];

export type ShapeSpec = {
  id?: string;
  type: ShapeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  label?: string;
  color?: string;
  fill?: string;
};

export type ConnectSpec = {
  id?: string;
  from: string;
  to: string;
  label?: string;
  color?: string;
};

export type ShapeUpdate = {
  id: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
};

export const canvasElements = (doc: Y.Doc) =>
  doc.getMap<CanvasElement>("canvasElements");
export const canvasEditors = (doc: Y.Doc) =>
  doc.getMap<CanvasEditor>("canvasEditors");
export const canvasSuggestions = (doc: Y.Doc) =>
  doc.getMap<CanvasSuggestion>("canvasSuggestions");
const idPattern = /^[A-Za-z0-9_-]{1,40}$/;
const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const randomInt = () => Math.floor(Math.random() * 2 ** 31);
const charWidth = 0.55;
const lineHeight = 1.25;
const arrowGap = 8;

// The elements as an op sees them: the doc, plus anything already proposed under the same
// suggestion, so a suggested `connect` can reach a suggested shape.
type View = Map<string, CanvasElement>;

function viewOf(doc: Y.Doc, opts: CanvasOpOptions): View {
  const view = new Map(canvasElements(doc).entries());
  const pending = opts.suggest
    ? canvasSuggestions(doc).get(opts.suggest.id)
    : undefined;
  for (const element of Object.values(pending?.after ?? {})) {
    view.set(element.id, element);
  }
  return view;
}

const isLive = (element: CanvasElement | undefined): element is CanvasElement =>
  !!element && !element.isDeleted;

function bump(
  element: CanvasElement,
  patch: Partial<CanvasElement>
): CanvasElement {
  return {
    ...element,
    ...patch,
    version: element.version + 1,
    versionNonce: randomInt(),
    updated: Date.now(),
  };
}

function base(
  type: string,
  id: string,
  box: { x: number; y: number; width: number; height: number },
  index: string,
  extra: Partial<CanvasElement> = {}
): CanvasElement {
  return {
    id,
    type,
    ...box,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...extra,
  };
}

function wrapLines(text: string, fontSize: number, width: number | null) {
  const perLine = width
    ? Math.max(1, Math.floor(width / (fontSize * charWidth)))
    : Number.POSITIVE_INFINITY;
  return text
    .split("\n")
    .flatMap((line) =>
      line.length <= perLine
        ? [line]
        : Array.from({ length: Math.ceil(line.length / perLine) }, (_, i) =>
            line.slice(i * perLine, (i + 1) * perLine)
          )
    );
}

function textSize(text: string, fontSize: number, width: number | null) {
  const lines = wrapLines(text, fontSize, width);
  return {
    width:
      width ??
      Math.max(1, ...lines.map((line) => line.length)) * fontSize * charWidth,
    height: lines.length * fontSize * lineHeight,
  };
}

type TextOptions = {
  fontSize?: number;
  fontFamily?: number;
  color?: string;
  containerId?: string | null;
  frameId?: string | null;
  // A fixed width wraps the text; without one the box grows to fit.
  width?: number | null;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle";
  customData?: Record<string, unknown>;
};

function textElement(
  id: string,
  text: string,
  at: { x: number; y: number },
  index: string,
  opts: TextOptions = {}
): CanvasElement {
  const fontSize = opts.fontSize ?? 20;
  const size = textSize(text, fontSize, opts.width ?? null);
  return base("text", id, { x: at.x, y: at.y, ...size }, index, {
    strokeColor: opts.color ?? "#1e1e1e",
    text,
    originalText: text,
    fontSize,
    fontFamily: opts.fontFamily ?? 5,
    textAlign: opts.textAlign ?? "center",
    verticalAlign: opts.verticalAlign ?? "middle",
    containerId: opts.containerId ?? null,
    frameId: opts.frameId ?? null,
    autoResize: opts.width == null,
    lineHeight,
    ...(opts.customData ? { customData: opts.customData } : {}),
  });
}

const center = (element: CanvasElement) => ({
  x: element.x + element.width / 2,
  y: element.y + element.height / 2,
});

function centeredIn(container: CanvasElement, label: CanvasElement) {
  const c = center(container);
  return { x: c.x - label.width / 2, y: c.y - label.height / 2 };
}

// Where the line from a box's centre towards `toward` leaves the box, pushed out by the gap.
function edgePoint(box: CanvasElement, toward: { x: number; y: number }) {
  const c = center(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) {
    return c;
  }
  const scale = Math.min(
    dx === 0
      ? Number.POSITIVE_INFINITY
      : (box.width / 2 + arrowGap) / Math.abs(dx),
    dy === 0
      ? Number.POSITIVE_INFINITY
      : (box.height / 2 + arrowGap) / Math.abs(dy)
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

function arrowGeometry(from: CanvasElement, to: CanvasElement) {
  const start = edgePoint(from, center(to));
  const end = edgePoint(to, center(from));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    x: start.x,
    y: start.y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ] satisfies [number, number][],
  };
}

const labelOf = (view: View, element: CanvasElement): CanvasElement | null => {
  const bound = element.boundElements?.find((b) => b.type === "text");
  const label = bound ? view.get(bound.id) : undefined;
  return isLive(label) ? label : null;
};

const labelText = (element: CanvasElement | null) =>
  element?.originalText ?? element?.text ?? "";

function maxIndex(view: View): string | null {
  let max: string | null = null;
  for (const element of view.values()) {
    if (max === null || element.index > max) {
      max = element.index;
    }
  }
  return max;
}

function writeElements(
  doc: Y.Doc,
  elements: CanvasElement[],
  actor?: CanvasEditor
): void {
  const map = canvasElements(doc);
  const editors = canvasEditors(doc);
  for (const element of elements) {
    map.set(element.id, element);
    if (actor) {
      editors.set(element.id, actor);
    }
  }
}

function propose(
  doc: Y.Doc,
  suggest: NonNullable<CanvasOpOptions["suggest"]>,
  elements: CanvasElement[]
): void {
  const suggestions = canvasSuggestions(doc);
  const current = canvasElements(doc);
  const existing = suggestions.get(suggest.id);
  const pending = existing?.status === "pending" ? existing : null;
  suggestions.set(suggest.id, {
    id: suggest.id,
    actorId: suggest.actor.id,
    actorName: suggest.actor.name,
    ...(suggest.approver ? { approver: suggest.approver } : {}),
    ...(suggest.approverId ? { approverId: suggest.approverId } : {}),
    status: "pending",
    after: {
      ...pending?.after,
      ...Object.fromEntries(elements.map((element) => [element.id, element])),
    },
    before: {
      ...Object.fromEntries(
        elements.map((element) => [element.id, current.get(element.id) ?? null])
      ),
      ...pending?.before,
    },
    createdAt: pending?.createdAt ?? new Date().toISOString(),
  });
}

function commit(
  doc: Y.Doc,
  elements: CanvasElement[],
  opts: CanvasOpOptions
): void {
  doc.transact(() => {
    if (opts.suggest) {
      propose(doc, opts.suggest, elements);
    } else {
      writeElements(doc, elements, opts.actor);
    }
  });
}

// Collects changed elements by id, so later edits in the same op build on earlier ones.
class Changes {
  readonly changed = new Map<string, CanvasElement>();
  private readonly view: View;

  constructor(view: View) {
    this.view = view;
  }

  get(id: string): CanvasElement | undefined {
    return this.changed.get(id) ?? this.view.get(id);
  }

  put(element: CanvasElement): CanvasElement {
    this.changed.set(element.id, element);
    return element;
  }

  patch(id: string, patch: Partial<CanvasElement>): CanvasElement | null {
    const element = this.get(id);
    if (!element) {
      return null;
    }
    // A brand-new element keeps version 1 until it lands.
    return this.put(
      this.changed.has(id) && !this.view.has(id)
        ? { ...element, ...patch }
        : bump(element, patch)
    );
  }

  list(): CanvasElement[] {
    return [...this.changed.values()];
  }
}

function nextIndices(view: View, changes: Changes, n: number): string[] {
  let max = maxIndex(view);
  for (const element of changes.changed.values()) {
    if (max === null || element.index > max) {
      max = element.index;
    }
  }
  return generateNKeysBetween(max, null, n);
}

function rerouteArrowsOf(changes: Changes, shapeId: string): void {
  const shape = changes.get(shapeId);
  for (const bound of shape?.boundElements ?? []) {
    const arrow = changes.get(bound.id);
    if (bound.type !== "arrow" || !isLive(arrow)) {
      continue;
    }
    const from = changes.get(arrow.startBinding?.elementId ?? "");
    const to = changes.get(arrow.endBinding?.elementId ?? "");
    if (!isLive(from) || !isLive(to)) {
      continue;
    }
    const routed = changes.patch(arrow.id, arrowGeometry(from, to));
    const label = labelFromChanges(changes, routed);
    if (routed && label) {
      changes.patch(label.id, centeredIn(routed, label));
    }
  }
}

function labelFromChanges(
  changes: Changes,
  element: CanvasElement | null
): CanvasElement | null {
  const bound = element?.boundElements?.find((b) => b.type === "text");
  const label = bound ? changes.get(bound.id) : undefined;
  return isLive(label) ? label : null;
}

export function addShapes(
  doc: Y.Doc,
  shapes: ShapeSpec[],
  opts: CanvasOpOptions = {}
): CanvasOpResult {
  const view = viewOf(doc, opts);
  for (const shape of shapes) {
    if (shape.id && (!idPattern.test(shape.id) || view.has(shape.id))) {
      return {
        ok: false,
        error: `Shape id ${shape.id} is taken or invalid; use letters, digits, - and _ (up to 40).`,
      };
    }
  }
  const changes = new Changes(view);
  const indices = nextIndices(view, changes, shapes.length * 2);
  const ids = shapes.map((shape, i) => {
    const id = shape.id ?? newId();
    const at = { x: shape.x, y: shape.y };
    const frameId = null;
    if (shape.type === "text") {
      changes.put(
        textElement(id, shape.label ?? "", at, indices[i * 2], {
          color: shape.color,
          frameId,
          // Free text sizes itself; a fixed width would clip it in a wider font than estimated.
          width: null,
          textAlign: "left",
          verticalAlign: "top",
        })
      );
      return id;
    }
    const labelId = shape.label ? newId() : null;
    const container = changes.put(
      base(
        shape.type,
        id,
        { ...at, width: shape.width ?? 200, height: shape.height ?? 100 },
        indices[i * 2],
        {
          frameId,
          strokeColor: shape.color ?? "#1e1e1e",
          backgroundColor: shape.fill ?? "transparent",
          roundness: shape.type === "rectangle" ? { type: 3 } : { type: 2 },
          boundElements: labelId ? [{ id: labelId, type: "text" }] : null,
        }
      )
    );
    if (labelId && shape.label) {
      const label = textElement(labelId, shape.label, at, indices[i * 2 + 1], {
        containerId: id,
        frameId,
        width: container.width - 20,
        color: shape.color,
      });
      changes.put({ ...label, ...centeredIn(container, label) });
    }
    return id;
  });
  commit(doc, changes.list(), opts);
  return { ok: true, ids };
}

export function connect(
  doc: Y.Doc,
  arrows: ConnectSpec[],
  opts: CanvasOpOptions = {}
): CanvasOpResult {
  const view = viewOf(doc, opts);
  const changes = new Changes(view);
  for (const arrow of arrows) {
    if (!isLive(view.get(arrow.from)) || !isLive(view.get(arrow.to))) {
      return {
        ok: false,
        error: `Cannot connect ${arrow.from} → ${arrow.to}: both shapes must exist.`,
      };
    }
    if (arrow.id && (!idPattern.test(arrow.id) || view.has(arrow.id))) {
      return { ok: false, error: `Arrow id ${arrow.id} is taken or invalid.` };
    }
  }
  const indices = nextIndices(view, changes, arrows.length * 2);
  const ids = arrows.map((spec, i) => {
    const id = spec.id ?? newId();
    const from = changes.get(spec.from);
    const to = changes.get(spec.to);
    if (!from || !to) {
      return id;
    }
    const labelId = spec.label ? newId() : null;
    const arrow = changes.put(
      base("arrow", id, arrowGeometry(from, to), indices[i * 2], {
        ...arrowGeometry(from, to),
        frameId: from.frameId,
        strokeColor: spec.color ?? "#1e1e1e",
        roundness: { type: 2 },
        startBinding: { elementId: from.id, focus: 0, gap: arrowGap },
        endBinding: { elementId: to.id, focus: 0, gap: arrowGap },
        startArrowhead: null,
        endArrowhead: "arrow",
        lastCommittedPoint: null,
        elbowed: false,
        boundElements: labelId ? [{ id: labelId, type: "text" }] : null,
      })
    );
    if (labelId && spec.label) {
      const label = textElement(
        labelId,
        spec.label,
        arrow,
        indices[i * 2 + 1],
        {
          containerId: id,
          frameId: from.frameId,
          fontSize: 16,
        }
      );
      changes.put({ ...label, ...centeredIn(arrow, label) });
    }
    for (const end of [from, to]) {
      const current = changes.get(end.id) ?? end;
      changes.patch(end.id, {
        boundElements: [
          ...(current.boundElements ?? []),
          { id, type: "arrow" },
        ],
      });
    }
    return id;
  });
  commit(doc, changes.list(), opts);
  return { ok: true, ids };
}

export function updateShapes(
  doc: Y.Doc,
  updates: ShapeUpdate[],
  opts: CanvasOpOptions = {}
): CanvasOpResult {
  const view = viewOf(doc, opts);
  const missing = updates.filter((u) => !isLive(view.get(u.id)));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `No shape ${missing.map((u) => u.id).join(", ")}.`,
    };
  }
  const changes = new Changes(view);
  for (const update of updates) {
    const element = changes.get(update.id);
    if (!element) {
      continue;
    }
    const frame = element.frameId ? changes.get(element.frameId) : undefined;
    const dx =
      update.x === undefined ? 0 : (frame?.x ?? 0) + update.x - element.x;
    const dy =
      update.y === undefined ? 0 : (frame?.y ?? 0) + update.y - element.y;
    const isText = element.type === "text";
    const textPatch =
      isText && update.label !== undefined
        ? {
            text: update.label,
            originalText: update.label,
            ...textSize(
              update.label,
              element.fontSize ?? 20,
              element.autoResize === false ? element.width : null
            ),
          }
        : {};
    const shape = changes.patch(update.id, {
      x: element.x + dx,
      y: element.y + dy,
      ...(update.width !== undefined && !isText ? { width: update.width } : {}),
      ...(update.height !== undefined && !isText
        ? { height: update.height }
        : {}),
      ...(update.color !== undefined ? { strokeColor: update.color } : {}),
      ...(update.fill !== undefined ? { backgroundColor: update.fill } : {}),
      ...textPatch,
    });
    if (!shape || isText) {
      continue;
    }
    const label = labelFromChanges(changes, shape);
    if (label) {
      const text = update.label ?? labelText(label);
      const sized = {
        ...label,
        text,
        originalText: text,
        ...textSize(text, label.fontSize ?? 20, shape.width - 20),
      };
      changes.patch(label.id, { ...sized, ...centeredIn(shape, sized) });
    } else if (update.label) {
      const [index] = nextIndices(view, changes, 1);
      const labelId = newId();
      const created = textElement(labelId, update.label, shape, index, {
        containerId: shape.id,
        frameId: shape.frameId,
        width: shape.width - 20,
      });
      changes.put({ ...created, ...centeredIn(shape, created) });
      changes.patch(shape.id, {
        boundElements: [
          ...(shape.boundElements ?? []),
          { id: labelId, type: "text" },
        ],
      });
    }
    if (
      [update.x, update.y, update.width, update.height].some(
        (value) => value !== undefined
      )
    ) {
      rerouteArrowsOf(changes, shape.id);
    }
  }
  commit(doc, changes.list(), opts);
  return { ok: true, ids: updates.map((u) => u.id) };
}

// Deleting a shape takes its label and the arrows attached to it with it.
function deleteInto(changes: Changes, id: string): void {
  const element = changes.get(id);
  if (!isLive(element)) {
    return;
  }
  changes.patch(id, { isDeleted: true });
  for (const bound of element.boundElements ?? []) {
    if (bound.type === "text") {
      changes.patch(bound.id, { isDeleted: true });
    } else {
      deleteInto(changes, bound.id);
    }
  }
  for (const binding of [element.startBinding, element.endBinding]) {
    const end = binding ? changes.get(binding.elementId) : undefined;
    if (isLive(end)) {
      changes.patch(end.id, {
        boundElements: (end.boundElements ?? []).filter((b) => b.id !== id),
      });
    }
  }
}

export function deleteShapes(
  doc: Y.Doc,
  ids: string[],
  opts: CanvasOpOptions = {}
): CanvasOpResult {
  const view = viewOf(doc, opts);
  const missing = ids.filter((id) => !isLive(view.get(id)));
  if (missing.length > 0) {
    return { ok: false, error: `No shape ${missing.join(", ")}.` };
  }
  const changes = new Changes(view);
  for (const id of ids) {
    deleteInto(changes, id);
  }
  commit(doc, changes.list(), opts);
  return { ok: true, ids };
}

// The person who accepts becomes the elements' editor: the change is now theirs.
export function acceptCanvasSuggestion(
  doc: Y.Doc,
  id: string,
  actor?: CanvasEditor
): void {
  const suggestion = canvasSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  const current = canvasElements(doc);
  doc.transact(() => {
    writeElements(
      doc,
      Object.values(suggestion.after).map((element) => ({
        ...element,
        version:
          Math.max(current.get(element.id)?.version ?? 0, element.version) + 1,
        versionNonce: randomInt(),
      })),
      actor
    );
    canvasSuggestions(doc).set(id, { ...suggestion, status: "accepted" });
  });
}

export function rejectCanvasSuggestion(doc: Y.Doc, id: string): void {
  const suggestion = canvasSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  canvasSuggestions(doc).set(id, { ...suggestion, status: "rejected" });
}

export type CanvasChangeKind = "added" | "changed" | "removed";

export type PendingCanvasSuggestion = CanvasSuggestion & {
  changes: { id: string; label: string; kind: CanvasChangeKind }[];
  // Whether any element it replaces changed since the proposal.
  stale: boolean;
};

const isVisibleShape = (element: CanvasElement) =>
  !element.containerId && element.type !== "frame";

function changeKind(
  before: CanvasElement | null | undefined,
  after: CanvasElement
): CanvasChangeKind {
  if (!isLive(before ?? undefined)) {
    return "added";
  }
  return after.isDeleted ? "removed" : "changed";
}

export function pendingCanvasSuggestions(
  doc: Y.Doc
): PendingCanvasSuggestion[] {
  const current = canvasElements(doc);
  return [...canvasSuggestions(doc).values()]
    .filter((suggestion) => suggestion.status === "pending")
    .map((suggestion) => {
      const view: View = new Map([
        ...current.entries(),
        ...Object.entries(suggestion.after),
      ]);
      return {
        ...suggestion,
        changes: Object.values(suggestion.after)
          .filter(isVisibleShape)
          .map((element) => ({
            id: element.id,
            label: labelText(labelOf(view, element)) || element.type,
            kind: changeKind(suggestion.before[element.id], element),
          })),
        stale: Object.entries(suggestion.before).some(
          ([elementId, was]) =>
            (current.get(elementId)?.version ?? null) !== (was?.version ?? null)
        ),
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type CanvasShapeView = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  // The Excalidraw frame the shape sits in, if any.
  frame: string | null;
  // Set when a person last wrote the shape.
  by: string | null;
};

export type CanvasConnectionView = {
  id: string;
  from: string;
  to: string;
  label: string;
};

export type CanvasView = {
  shapes: CanvasShapeView[];
  connections: CanvasConnectionView[];
};

export function readCanvas(doc: Y.Doc): CanvasView {
  const view: View = new Map(canvasElements(doc).entries());
  const editors = canvasEditors(doc);
  const live = [...view.values()]
    .filter((element) => isLive(element) && isVisibleShape(element))
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  const byOf = (element: CanvasElement) => {
    const label = labelOf(view, element);
    const editor = [
      editors.get(element.id),
      label && editors.get(label.id),
    ].find((e) => e?.kind === "human");
    return editor ? editor.name : null;
  };
  return {
    shapes: live
      .filter((element) => element.type !== "arrow")
      .map((element) => {
        const frame = element.frameId ? view.get(element.frameId) : undefined;
        return {
          id: element.id,
          type: element.type,
          x: Math.round(element.x - (frame?.x ?? 0)),
          y: Math.round(element.y - (frame?.y ?? 0)),
          width: Math.round(element.width),
          height: Math.round(element.height),
          label:
            element.type === "text"
              ? labelText(element)
              : labelText(labelOf(view, element)),
          frame: element.frameId,
          by: byOf(element),
        };
      }),
    connections: live
      .filter((element) => element.type === "arrow")
      .map((element) => ({
        id: element.id,
        from: element.startBinding?.elementId ?? "",
        to: element.endBinding?.elementId ?? "",
        label: labelText(labelOf(view, element)),
      })),
  };
}

// Element ids among `ids` (or their labels) that a person last wrote.
export function humanWrittenElements(doc: Y.Doc, ids: string[]): string[] {
  const view: View = new Map(canvasElements(doc).entries());
  const editors = canvasEditors(doc);
  return ids.filter((id) => {
    const element = view.get(id);
    if (!isLive(element)) {
      return false;
    }
    const label = labelOf(view, element);
    return [id, label?.id].some(
      (elementId) => elementId && editors.get(elementId)?.kind === "human"
    );
  });
}

// Writes elements the local person changed; unchanged versions are skipped, so a remote update
// applied to the scene does not echo back.
export function writeLocalElements(
  doc: Y.Doc,
  elements: readonly CanvasElement[],
  actor: CanvasEditor
): void {
  const map = canvasElements(doc);
  const changed = elements.filter((element) => {
    const stored = map.get(element.id);
    return (
      !stored ||
      stored.version !== element.version ||
      stored.versionNonce !== element.versionNonce
    );
  });
  if (changed.length > 0) {
    doc.transact(() => writeElements(doc, changed, actor));
  }
}

// --- History ---

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

// Writes a version forward as one edit. Elements get a version above both sides so every
// open Excalidraw scene takes the restored state.
export function restoreCanvas(doc: Y.Doc, version: Y.Doc): void {
  const current = canvasElements(doc);
  const target = canvasElements(version);
  doc.transact(() => {
    for (const [id, element] of current.entries()) {
      if (!target.has(id) && !element.isDeleted) {
        current.set(id, bump(element, { isDeleted: true }));
      }
    }
    for (const [id, element] of target.entries()) {
      const now = current.get(id);
      if (JSON.stringify(now) !== JSON.stringify(element)) {
        current.set(id, {
          ...element,
          version: Math.max(now?.version ?? 0, element.version) + 1,
          versionNonce: randomInt(),
        });
      }
    }
    syncMap(canvasEditors(doc), canvasEditors(version));
    syncMap(canvasSuggestions(doc), canvasSuggestions(version));
  });
}

export type CanvasShapeChange = {
  id: string;
  type: string;
  label: string;
  kind: CanvasChangeKind;
};

// Shape-level changes; a label edit counts as a change to its shape.
export function diffCanvases(before: Y.Doc, after: Y.Doc): CanvasShapeChange[] {
  const was: View = new Map(canvasElements(before).entries());
  const now: View = new Map(canvasElements(after).entries());
  const ids = new Set([...was.keys(), ...now.keys()]);
  const fingerprint = (view: View, element: CanvasElement | undefined) =>
    isLive(element)
      ? JSON.stringify([
          element.x,
          element.y,
          element.width,
          element.height,
          element.strokeColor,
          element.backgroundColor,
          element.text,
          labelText(labelOf(view, element)),
        ])
      : null;
  return [...ids].flatMap((id) => {
    const a = was.get(id);
    const b = now.get(id);
    const shape = b ?? a;
    if (!shape || !isVisibleShape(shape)) {
      return [];
    }
    const fa = fingerprint(was, a);
    const fb = fingerprint(now, b);
    if (fa === fb) {
      return [];
    }
    const view = isLive(b) ? now : was;
    const label =
      shape.type === "text"
        ? labelText(shape)
        : labelText(labelOf(view, shape)) || shape.name || shape.type;
    const kind: CanvasChangeKind =
      fa === null ? "added" : fb === null ? "removed" : "changed";
    return [{ id, type: shape.type, label: label ?? shape.type, kind }];
  });
}

export function isCanvasElement(value: unknown): value is CanvasElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "type" in value &&
    typeof value.type === "string" &&
    "version" in value &&
    typeof value.version === "number" &&
    "index" in value &&
    typeof value.index === "string"
  );
}

export const ghostPrefix = "ghost:";
const ghostOffset = 28;

// Pending suggestions drawn as locked, faded copies of whole shapes (a label edit shows its
// container too). Ids are prefixed so a ghost never collides with, or is written back as, a real
// element; a changed shape's ghost sits slightly offset so old and new text stay readable.
export function suggestionGhosts(
  suggestions: PendingCanvasSuggestion[],
  current: Map<string, CanvasElement>
): CanvasElement[] {
  const ghost = (id: string) => `${ghostPrefix}${id}`;
  const ghosts = suggestions.flatMap((suggestion) => {
    const stateOf = (id: string) => suggestion.after[id] ?? current.get(id);
    const roots = new Set(
      Object.values(suggestion.after).map(
        (element) => element.containerId ?? element.id
      )
    );
    return [...roots].flatMap((rootId) => {
      const proposed = suggestion.after[rootId];
      const existing = current.get(rootId);
      const removed = proposed?.isDeleted === true;
      const root = removed ? existing : stateOf(rootId);
      if (!root || root.isDeleted) {
        return [];
      }
      const changed = !removed && isLive(existing);
      const labelBound = root.boundElements?.find((b) => b.type === "text");
      const label = labelBound
        ? removed
          ? current.get(labelBound.id)
          : stateOf(labelBound.id)
        : undefined;
      return [root, ...(isLive(label) ? [label] : [])].map(
        (shown): CanvasElement => ({
          ...shown,
          id: ghost(shown.id),
          x: shown.x + (changed ? ghostOffset : 0),
          y: shown.y + (changed ? ghostOffset : 0),
          isDeleted: false,
          locked: true,
          opacity: removed ? 30 : 60,
          strokeStyle: "dashed",
          ...(removed ? { strokeColor: "#dc2626" } : {}),
          containerId: shown.containerId ? ghost(shown.containerId) : null,
          boundElements:
            shown.boundElements
              ?.filter((b) => b.type === "text")
              .map((b) => ({ ...b, id: ghost(b.id) })) ?? null,
          startBinding: null,
          endBinding: null,
          customData: { ...shown.customData, suggestionId: suggestion.id },
        })
      );
    });
  });
  // Ghosts sort after every real element, so Excalidraw never has to re-index the scene.
  const indices = generateNKeysBetween(
    maxIndex(new Map(current)),
    null,
    ghosts.length
  );
  return ghosts.map((element, i) => ({ ...element, index: indices[i] }));
}
