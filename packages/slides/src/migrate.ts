import type * as Y from "yjs";

import type { LayoutId } from "./index.ts";
import {
  addElement,
  addSlide,
  deckSlides,
  isDeckDoc,
  layoutIds,
  slideHeight,
  slideWidth,
} from "./index.ts";

// P4 decks were Excalidraw frames (1920×1080) in `canvasElements`, with layout texts tagged by
// `customData.role` and free shapes inside each frame. This reads that map structurally so the
// slides package does not depend on the canvas package.

type OldElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  index: string;
  isDeleted: boolean;
  frameId: string | null;
  containerId: string | null;
  text: string;
  role: string | null;
  layout: string | null;
  notes: string;
  isSlide: boolean;
  boundTextId: string | null;
  points: [number, number][];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function oldElementOf(value: unknown): OldElement | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string"
  ) {
    return null;
  }
  const num = (key: string) =>
    typeof value[key] === "number" ? Number(value[key]) : 0;
  const custom = isRecord(value.customData) ? value.customData : {};
  const bound = Array.isArray(value.boundElements)
    ? value.boundElements.find((b) => isRecord(b) && b.type === "text")
    : undefined;
  const points = Array.isArray(value.points)
    ? value.points.flatMap((p): [number, number][] =>
        Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number"
          ? [[p[0], p[1]]]
          : []
      )
    : [];
  return {
    id: value.id,
    type: value.type,
    x: num("x"),
    y: num("y"),
    width: num("width"),
    height: num("height"),
    index: typeof value.index === "string" ? value.index : "",
    isDeleted: value.isDeleted === true,
    frameId: typeof value.frameId === "string" ? value.frameId : null,
    containerId:
      typeof value.containerId === "string" ? value.containerId : null,
    text:
      typeof value.originalText === "string"
        ? value.originalText
        : typeof value.text === "string"
          ? value.text
          : "",
    role: typeof custom.role === "string" ? custom.role : null,
    layout: typeof custom.layout === "string" ? custom.layout : null,
    notes: typeof custom.notes === "string" ? custom.notes : "",
    isSlide: custom.slide === true,
    boundTextId:
      isRecord(bound) && typeof bound.id === "string" ? bound.id : null,
    points,
  };
}

function oldElements(doc: Y.Doc): OldElement[] {
  return [...doc.getMap<unknown>("canvasElements").values()].flatMap(
    (value) => {
      const element = oldElementOf(value);
      return element && !element.isDeleted ? [element] : [];
    }
  );
}

export function needsDeckMigration(doc: Y.Doc): boolean {
  return (
    !isDeckDoc(doc) &&
    oldElements(doc).some((e) => e.type === "frame" && e.isSlide)
  );
}

function layoutOf(old: string | null): LayoutId {
  // P4 had a "blank" layout for diagram slides; its shapes come across as free elements.
  return layoutIds.find((id) => id === old) ?? "title_bullets";
}

const unbullet = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/^•\s?/, "").trim())
    .filter(Boolean);

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

// Converts every P4 slide frame into a slide, once. Returns whether anything changed; the update
// log before this transaction is the restore point.
export function migrateCanvasDeck(doc: Y.Doc): boolean {
  if (!needsDeckMigration(doc)) {
    return false;
  }
  const all = oldElements(doc);
  const byId = new Map(all.map((element) => [element.id, element]));
  const frames = all
    .filter((element) => element.type === "frame" && element.isSlide)
    .sort((a, b) => a.x - b.x);
  doc.transact(() => {
    for (const frame of frames) {
      const children = all
        .filter((element) => element.frameId === frame.id)
        .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
      const roleText = (role: string) =>
        children.find((child) => child.role === role)?.text ?? "";
      const layout = layoutOf(frame.layout);
      const body = unbullet(roleText("body"));
      addSlide(doc, {
        id: frame.id,
        layout,
        title: roleText("title") || undefined,
        ...(layout === "title" || layout === "section"
          ? { subtitle: body.join("\n") || undefined }
          : { bullets: body.length > 0 ? body : undefined }),
        rightBullets:
          unbullet(roleText("right")).length > 0
            ? unbullet(roleText("right"))
            : undefined,
        notes: frame.notes,
      });
      const at = (element: OldElement) => ({
        x: clamp(element.x - frame.x, slideWidth),
        y: clamp(element.y - frame.y, slideHeight),
        w: Math.max(element.width, 4),
        h: Math.max(element.height, 4),
      });
      for (const child of children) {
        if (child.role || child.containerId) {
          continue;
        }
        if (
          child.type === "rectangle" ||
          child.type === "ellipse" ||
          child.type === "diamond"
        ) {
          addElement(doc, {
            slide: frame.id,
            kind: "shape",
            ...at(child),
            data: { shape: child.type === "ellipse" ? "ellipse" : "rect" },
            style: {
              fill: "surface",
              stroke: "border",
              radius: child.type === "rectangle" ? 16 : undefined,
            },
          });
          const label = child.boundTextId
            ? byId.get(child.boundTextId)
            : undefined;
          if (label?.text) {
            addElement(doc, {
              slide: frame.id,
              kind: "text",
              ...at(child),
              text: label.text,
              style: { role: "body", align: "center", valign: "middle" },
            });
          }
        } else if (child.type === "arrow" || child.type === "line") {
          const [, end] = child.points;
          const [dx, dy] = end ?? [child.width, child.height];
          addElement(doc, {
            slide: frame.id,
            kind: "shape",
            x: clamp(child.x - frame.x + Math.min(0, dx), slideWidth),
            y: clamp(child.y - frame.y + Math.min(0, dy), slideHeight),
            w: Math.max(Math.abs(dx), 4),
            h: Math.max(Math.abs(dy), 4),
            data: { shape: "line" },
            style: { stroke: "muted" },
          });
        } else if (child.type === "text" && child.text) {
          addElement(doc, {
            slide: frame.id,
            kind: "text",
            ...at(child),
            text: child.text,
            style: { role: "body" },
          });
        }
      }
    }
    doc.getMap<unknown>("canvasElements").clear();
  });
  return deckSlides(doc).length > 0;
}
