import type { JSONContent } from "@memo-air/richtext";
import {
  acceptSuggestion,
  deleteBlock,
  editBlocks,
  exportMarkdown,
  insertBlocks,
  markdownToNodes,
  readBlocks,
  readOutline,
  rejectSuggestion,
  restoreBlocks,
} from "@memo-air/richtext";
import * as Y from "yjs";

export const slideWidth = 1920;
export const slideHeight = 1080;

// --- Themes ---

export const themeIds = ["studio", "midnight"] as const;
export type ThemeId = (typeof themeIds)[number];

export type DeckTheme = {
  id: ThemeId;
  name: string;
  mode: "light" | "dark";
  fonts: { heading: string; body: string };
  palette: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accentContrast: string;
    border: string;
  };
  // Font sizes in slide pixels (1920×1080).
  sizes: {
    title: number;
    heading: number;
    subtitle: number;
    body: number;
    quote: number;
    caption: number;
  };
};

export const deckThemes: Record<ThemeId, DeckTheme> = {
  studio: {
    id: "studio",
    name: "Studio",
    mode: "light",
    fonts: { heading: "Geist", body: "Geist" },
    palette: {
      background: "#FFFFFF",
      surface: "#F4F5F7",
      text: "#111827",
      muted: "#6B7280",
      accent: "#2563EB",
      accentContrast: "#FFFFFF",
      border: "#E5E7EB",
    },
    sizes: {
      title: 104,
      heading: 64,
      subtitle: 40,
      body: 36,
      quote: 64,
      caption: 28,
    },
  },
  midnight: {
    id: "midnight",
    name: "Midnight",
    mode: "dark",
    fonts: { heading: "Georgia", body: "Geist" },
    palette: {
      background: "#0B1020",
      surface: "#141B33",
      text: "#F3F4F6",
      muted: "#9CA3AF",
      accent: "#8B9CFF",
      accentContrast: "#0B1020",
      border: "#263052",
    },
    sizes: {
      title: 112,
      heading: 68,
      subtitle: 40,
      body: 36,
      quote: 68,
      caption: 28,
    },
  },
};

export type ThemeOverrides = {
  accent?: string;
  background?: string;
  headingFont?: string;
  bodyFont?: string;
};

export type ThemeState = { themeId: ThemeId; overrides: ThemeOverrides };

// --- Layouts ---

export const layoutIds = [
  "title",
  "title_bullets",
  "section",
  "two_column",
  "chart_takeaway",
  "image_full",
  "quote",
  "closing",
] as const;
export type LayoutId = (typeof layoutIds)[number];

export const elementKinds = [
  "text",
  "shape",
  "image",
  "chart",
  "table",
] as const;
export type ElementKind = (typeof elementKinds)[number];

export type TextRole =
  | "title"
  | "heading"
  | "subtitle"
  | "body"
  | "quote"
  | "caption";

export type ElementStyle = {
  role?: TextRole;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  // A palette key ("accent", "text", "muted", ...) or a hex colour.
  color?: string;
  fill?: string;
  stroke?: string;
  radius?: number;
  opacity?: number;
};

export type ChartData = {
  chart: "bar" | "line" | "pie";
  labels: string[];
  series: { name: string; values: number[] }[];
};
export type ImageData = { url: string; alt: string };
export type TableData = { rows: string[][]; header: boolean };
export type ShapeData = { shape: "rect" | "ellipse" | "line" };
export type ElementData = ChartData | ImageData | TableData | ShapeData;

export type SlotName =
  | "title"
  | "subtitle"
  | "body"
  | "right"
  | "chart"
  | "image"
  | "quote"
  | "attribution"
  | "accent"
  | "scrim";

type SlotDef = {
  slot: SlotName;
  kind: ElementKind;
  x: number;
  y: number;
  w: number;
  h: number;
  style: ElementStyle;
  data?: ElementData;
  // Decorative slots are always present; content slots only when filled.
  decorative?: boolean;
};

const margin = 120;
const contentWidth = slideWidth - margin * 2;

const headingSlot: SlotDef = {
  slot: "title",
  kind: "text",
  x: margin,
  y: 96,
  w: contentWidth,
  h: 140,
  style: { role: "heading", valign: "bottom" },
};

export const deckLayouts: Record<LayoutId, SlotDef[]> = {
  title: [
    {
      slot: "accent",
      kind: "shape",
      x: margin,
      y: 330,
      w: 160,
      h: 10,
      style: { fill: "accent", radius: 5 },
      data: { shape: "rect" },
      decorative: true,
    },
    {
      slot: "title",
      kind: "text",
      x: margin,
      y: 370,
      w: contentWidth,
      h: 280,
      style: { role: "title", valign: "top" },
    },
    {
      slot: "subtitle",
      kind: "text",
      x: margin,
      y: 680,
      w: contentWidth,
      h: 160,
      style: { role: "subtitle", color: "muted" },
    },
  ],
  title_bullets: [
    headingSlot,
    {
      slot: "body",
      kind: "text",
      x: margin,
      y: 290,
      w: contentWidth,
      h: 700,
      style: { role: "body" },
    },
  ],
  section: [
    {
      slot: "accent",
      kind: "shape",
      x: 0,
      y: 0,
      w: 32,
      h: slideHeight,
      style: { fill: "accent" },
      data: { shape: "rect" },
      decorative: true,
    },
    {
      slot: "title",
      kind: "text",
      x: margin + 40,
      y: 380,
      w: contentWidth - 40,
      h: 220,
      style: { role: "title", valign: "bottom" },
    },
    {
      slot: "subtitle",
      kind: "text",
      x: margin + 40,
      y: 630,
      w: contentWidth - 40,
      h: 140,
      style: { role: "subtitle", color: "muted" },
    },
  ],
  two_column: [
    headingSlot,
    {
      slot: "body",
      kind: "text",
      x: margin,
      y: 290,
      w: 800,
      h: 700,
      style: { role: "body" },
    },
    {
      slot: "right",
      kind: "text",
      x: margin + 880,
      y: 290,
      w: 800,
      h: 700,
      style: { role: "body" },
    },
  ],
  chart_takeaway: [
    headingSlot,
    {
      slot: "chart",
      kind: "chart",
      x: margin,
      y: 290,
      w: 1080,
      h: 680,
      style: {},
    },
    {
      slot: "body",
      kind: "text",
      x: margin + 1160,
      y: 290,
      w: contentWidth - 1160,
      h: 680,
      style: { role: "body", valign: "middle" },
    },
  ],
  image_full: [
    {
      slot: "image",
      kind: "image",
      x: 0,
      y: 0,
      w: slideWidth,
      h: slideHeight,
      style: {},
    },
    {
      slot: "scrim",
      kind: "shape",
      x: 0,
      y: 640,
      w: slideWidth,
      h: 440,
      style: { fill: "#000000", opacity: 0.45 },
      data: { shape: "rect" },
      decorative: true,
    },
    {
      slot: "title",
      kind: "text",
      x: margin,
      y: 760,
      w: contentWidth,
      h: 220,
      style: { role: "title", color: "#FFFFFF", valign: "bottom" },
    },
  ],
  quote: [
    {
      slot: "accent",
      kind: "shape",
      x: 200,
      y: 300,
      w: 12,
      h: 360,
      style: { fill: "accent", radius: 6 },
      data: { shape: "rect" },
      decorative: true,
    },
    {
      slot: "quote",
      kind: "text",
      x: 260,
      y: 280,
      w: 1460,
      h: 420,
      style: { role: "quote", valign: "middle" },
    },
    {
      slot: "attribution",
      kind: "text",
      x: 260,
      y: 740,
      w: 1460,
      h: 80,
      style: { role: "caption", color: "muted" },
    },
  ],
  closing: [
    {
      slot: "title",
      kind: "text",
      x: margin,
      y: 380,
      w: contentWidth,
      h: 220,
      style: { role: "title", align: "center", valign: "bottom" },
    },
    {
      slot: "subtitle",
      kind: "text",
      x: margin,
      y: 630,
      w: contentWidth,
      h: 140,
      style: { role: "subtitle", align: "center", color: "muted" },
    },
  ],
};

// --- Model ---

export type SlideMeta = { layoutId: LayoutId; notes: string; hidden: boolean };

export type DeckEditor = { kind: "human" | "agent"; id: string; name: string };

export type ElementSnapshot = {
  id: string;
  slideId: string;
  kind: ElementKind;
  slot: SlotName | null;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation: number;
  style: ElementStyle;
  data: ElementData | null;
  // Markdown for text elements (their accepted content).
  text: string | null;
};

export type Geometry = Pick<
  ElementSnapshot,
  "x" | "y" | "w" | "h" | "z" | "rotation"
>;

export type ElementPatch = Partial<
  Pick<
    ElementSnapshot,
    "x" | "y" | "w" | "h" | "z" | "rotation" | "style" | "data"
  >
>;

const patchKeys = [
  "x",
  "y",
  "w",
  "h",
  "z",
  "rotation",
  "style",
  "data",
] as const;

// The fields of `source` named by `keys`, as a patch.
function pickPatch(
  source: ElementPatch,
  keys: readonly (typeof patchKeys)[number][]
): ElementPatch {
  const patch: ElementPatch = {};
  for (const key of keys) {
    if (key === "style") {
      patch.style = source.style;
    } else if (key === "data") {
      patch.data = source.data;
    } else {
      patch[key] = source[key];
    }
  }
  return patch;
}

export type SlideChange =
  | {
      type: "add_slide";
      slideId: string;
      position: number;
      meta: SlideMeta;
      elements: ElementSnapshot[];
    }
  | { type: "delete_slide"; slideId: string; title: string }
  | { type: "move_slide"; slideId: string; position: number; from: number }
  | { type: "set_meta"; slideId: string; before: SlideMeta; after: SlideMeta }
  | { type: "add_element"; element: ElementSnapshot }
  | {
      type: "set_element";
      elementId: string;
      before: ElementPatch;
      after: ElementPatch;
    }
  | { type: "delete_element"; before: ElementSnapshot }
  | { type: "set_theme"; before: ThemeState; after: ThemeState };

export type SlideSuggestion = {
  id: string;
  actorId: string;
  actorName: string;
  approver?: string;
  approverId?: string;
  status: "pending" | "accepted" | "rejected";
  changes: SlideChange[];
  // Text elements holding richtext suggestion marks under this id.
  textElementIds: string[];
  createdAt: string;
};

export type DeckOpOptions = {
  actor?: DeckEditor;
  suggest?: {
    id: string;
    actor: { id: string; name: string };
    approver?: string;
    approverId?: string;
  };
};

export type DeckOpResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

export const deckSlides = (doc: Y.Doc) => doc.getArray<string>("slides");
export const deckSlideMeta = (doc: Y.Doc) => doc.getMap<SlideMeta>("slideMeta");
export const deckElements = (doc: Y.Doc) =>
  doc.getMap<Y.Map<unknown>>("slideElements");
export const deckTheme = (doc: Y.Doc) => doc.getMap<unknown>("deckTheme");
export const deckEditors = (doc: Y.Doc) =>
  doc.getMap<DeckEditor>("slideEditors");
export const deckSuggestions = (doc: Y.Doc) =>
  doc.getMap<SlideSuggestion>("slideSuggestions");

const idPattern = /^[A-Za-z0-9_-]{1,40}$/;
const newId = (prefix: string) =>
  `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isThemeId(value: unknown): value is ThemeId {
  return themeIds.some((id) => id === value);
}

function isElementKind(value: unknown): value is ElementKind {
  return elementKinds.some((kind) => kind === value);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readThemeState(doc: Y.Doc): ThemeState {
  const map = deckTheme(doc);
  const themeId = map.get("themeId");
  const overrides = map.get("overrides");
  return {
    themeId: isThemeId(themeId) ? themeId : "studio",
    overrides: isRecord(overrides) ? themeOverridesOf(overrides) : {},
  };
}

function themeOverridesOf(value: Record<string, unknown>): ThemeOverrides {
  const str = (key: string) =>
    typeof value[key] === "string" ? { [key]: value[key] } : {};
  return {
    ...str("accent"),
    ...str("background"),
    ...str("headingFont"),
    ...str("bodyFont"),
  };
}

export function resolveTheme({ themeId, overrides }: ThemeState): DeckTheme {
  const base = deckThemes[themeId];
  return {
    ...base,
    fonts: {
      heading: overrides.headingFont ?? base.fonts.heading,
      body: overrides.bodyFont ?? base.fonts.body,
    },
    palette: {
      ...base.palette,
      ...(overrides.accent ? { accent: overrides.accent } : {}),
      ...(overrides.background ? { background: overrides.background } : {}),
    },
  };
}

// A palette key resolves through the theme; anything else is used as a colour.
const paletteKeys = [
  "background",
  "surface",
  "text",
  "muted",
  "accent",
  "accentContrast",
  "border",
] as const;
type PaletteKey = (typeof paletteKeys)[number];

function isPaletteKey(value: string): value is PaletteKey {
  return paletteKeys.some((key) => key === value);
}

export function themeColor(theme: DeckTheme, value: string | undefined) {
  if (!value) {
    return undefined;
  }
  return isPaletteKey(value) ? theme.palette[value] : value;
}

const slotNames: SlotName[] = [
  "title",
  "subtitle",
  "body",
  "right",
  "chart",
  "image",
  "quote",
  "attribution",
  "accent",
  "scrim",
];

function isSlotName(value: unknown): value is SlotName {
  return slotNames.some((slot) => slot === value);
}

const textRoles: TextRole[] = [
  "title",
  "heading",
  "subtitle",
  "body",
  "quote",
  "caption",
];

function styleOf(value: unknown): ElementStyle {
  if (!isRecord(value)) {
    return {};
  }
  const str = (key: string) =>
    typeof value[key] === "string" ? String(value[key]) : undefined;
  const role = textRoles.find((r) => r === value.role);
  const align = (["left", "center", "right"] as const).find(
    (a) => a === value.align
  );
  const valign = (["top", "middle", "bottom"] as const).find(
    (a) => a === value.valign
  );
  return {
    ...(role ? { role } : {}),
    ...(align ? { align } : {}),
    ...(valign ? { valign } : {}),
    ...(str("color") ? { color: str("color") } : {}),
    ...(str("fill") ? { fill: str("fill") } : {}),
    ...(str("stroke") ? { stroke: str("stroke") } : {}),
    ...(typeof value.radius === "number" ? { radius: value.radius } : {}),
    ...(typeof value.opacity === "number" ? { opacity: value.opacity } : {}),
  };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function dataOf(value: unknown): ElementData | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.chart === "bar" ||
    value.chart === "line" ||
    value.chart === "pie"
  ) {
    const series = Array.isArray(value.series)
      ? value.series.flatMap((item) =>
          isRecord(item) &&
          typeof item.name === "string" &&
          Array.isArray(item.values)
            ? [
                {
                  name: item.name,
                  values: item.values.map((v) =>
                    typeof v === "number" ? v : 0
                  ),
                },
              ]
            : []
        )
      : [];
    return {
      chart: value.chart,
      labels: isStringArray(value.labels) ? value.labels : [],
      series,
    };
  }
  if (typeof value.url === "string") {
    return {
      url: value.url,
      alt: typeof value.alt === "string" ? value.alt : "",
    };
  }
  if (Array.isArray(value.rows)) {
    return {
      rows: value.rows.filter(isStringArray),
      header: value.header === true,
    };
  }
  if (
    value.shape === "rect" ||
    value.shape === "ellipse" ||
    value.shape === "line"
  ) {
    return { shape: value.shape };
  }
  return null;
}

function textOf(map: Y.Map<unknown>): Y.XmlFragment | null {
  const text = map.get("text");
  return text instanceof Y.XmlFragment ? text : null;
}

export function elementFragment(
  doc: Y.Doc,
  elementId: string
): Y.XmlFragment | null {
  const map = deckElements(doc).get(elementId);
  return map ? textOf(map) : null;
}

export function snapshotOf(id: string, map: Y.Map<unknown>): ElementSnapshot {
  const kind = map.get("kind");
  const slot = map.get("slot");
  const style = map.get("style");
  const data = map.get("data");
  const fragment = textOf(map);
  return {
    id,
    slideId: String(map.get("slideId") ?? ""),
    kind: isElementKind(kind) ? kind : "text",
    slot: isSlotName(slot) ? slot : null,
    x: num(map.get("x")),
    y: num(map.get("y")),
    w: num(map.get("w"), 100),
    h: num(map.get("h"), 100),
    z: num(map.get("z")),
    rotation: num(map.get("rotation")),
    style: styleOf(style),
    data: dataOf(data),
    text: fragment ? exportMarkdown(fragment).trim() : null,
  };
}

function writeElement(
  doc: Y.Doc,
  snapshot: ElementSnapshot,
  actor?: DeckEditor
): void {
  const map = new Y.Map<unknown>();
  const elements = deckElements(doc);
  elements.set(snapshot.id, map);
  map.set("slideId", snapshot.slideId);
  map.set("kind", snapshot.kind);
  map.set("slot", snapshot.slot);
  map.set("x", snapshot.x);
  map.set("y", snapshot.y);
  map.set("w", snapshot.w);
  map.set("h", snapshot.h);
  map.set("z", snapshot.z);
  map.set("rotation", snapshot.rotation);
  map.set("style", snapshot.style);
  map.set("data", snapshot.data);
  if (snapshot.kind === "text") {
    map.set("text", new Y.XmlFragment());
    const fragment = textOf(map);
    if (fragment) {
      editBlocks(fragment, () => markdownToNodes(snapshot.text ?? ""));
    }
  }
  if (actor) {
    deckEditors(doc).set(snapshot.id, actor);
  }
}

function patchElement(
  doc: Y.Doc,
  elementId: string,
  patch: ElementPatch,
  actor?: DeckEditor
): void {
  const map = deckElements(doc).get(elementId);
  if (!map) {
    return;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      map.set(key, value);
    }
  }
  if (actor) {
    deckEditors(doc).set(elementId, actor);
  }
}

function removeElement(doc: Y.Doc, elementId: string): void {
  deckElements(doc).delete(elementId);
  deckEditors(doc).delete(elementId);
}

export function slideElementIds(doc: Y.Doc, slideId: string): string[] {
  return [...deckElements(doc).entries()]
    .filter(([, map]) => map.get("slideId") === slideId)
    .map(([id]) => id);
}

function slotElement(
  doc: Y.Doc,
  slideId: string,
  slot: SlotName
): string | null {
  return (
    [...deckElements(doc).entries()].find(
      ([, map]) => map.get("slideId") === slideId && map.get("slot") === slot
    )?.[0] ?? null
  );
}

function maxZ(doc: Y.Doc, slideId: string): number {
  return Math.max(
    0,
    ...slideElementIds(doc, slideId).map((id) =>
      num(deckElements(doc).get(id)?.get("z"))
    )
  );
}

// --- Slot content ---

export type SlideContent = {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  rightBullets?: string[];
  quote?: string;
  attribution?: string;
  chart?: ChartData;
  image?: ImageData;
};

const bulletMarkdown = (lines: string[]) =>
  lines.map((line) => `- ${line.replace(/\n/g, " ")}`).join("\n");

// One slot's new value: markdown for text, data for charts and images, null to clear it.
type SlotValue = { text: string } | { data: ElementData } | null;

function slotValues(content: SlideContent): [SlotName, SlotValue][] {
  const text = (value: string | undefined): SlotValue | undefined =>
    value === undefined ? undefined : value.trim() ? { text: value } : null;
  const list = (value: string[] | undefined): SlotValue | undefined =>
    value === undefined
      ? undefined
      : value.length > 0
        ? { text: bulletMarkdown(value) }
        : null;
  const entries: [SlotName, SlotValue | undefined][] = [
    ["title", text(content.title)],
    ["subtitle", text(content.subtitle)],
    ["body", list(content.bullets)],
    ["right", list(content.rightBullets)],
    ["quote", text(content.quote)],
    ["attribution", text(content.attribution)],
    [
      "chart",
      content.chart === undefined ? undefined : { data: content.chart },
    ],
    [
      "image",
      content.image === undefined ? undefined : { data: content.image },
    ],
  ];
  return entries.flatMap(([slot, value]) =>
    value === undefined ? [] : [[slot, value]]
  );
}

// Layouts without a body (title, section, closing) show bullets as their subtitle, so content an
// agent sends in the usual field is never dropped.
function fitContent(layoutId: LayoutId, content: SlideContent): SlideContent {
  const slots = new Set(deckLayouts[layoutId].map((def) => def.slot));
  if (
    !slots.has("body") &&
    slots.has("subtitle") &&
    content.subtitle === undefined &&
    content.bullets?.length
  ) {
    return {
      ...content,
      subtitle: content.bullets.join("\n"),
      bullets: undefined,
    };
  }
  return content;
}

function slotSnapshot(
  slideId: string,
  def: SlotDef,
  z: number,
  value: SlotValue
): ElementSnapshot {
  return {
    id: `${slideId}-${def.slot}`,
    slideId,
    kind: def.kind,
    slot: def.slot,
    x: def.x,
    y: def.y,
    w: def.w,
    h: def.h,
    z,
    rotation: 0,
    style: def.style,
    data: value && "data" in value ? value.data : (def.data ?? null),
    text: def.kind === "text" && value && "text" in value ? value.text : null,
  };
}

function layoutSnapshots(
  slideId: string,
  layoutId: LayoutId,
  content: SlideContent
): ElementSnapshot[] {
  const values = new Map(slotValues(fitContent(layoutId, content)));
  return deckLayouts[layoutId].flatMap((def, z) => {
    const value = values.get(def.slot);
    if (def.decorative) {
      return [slotSnapshot(slideId, def, z, null)];
    }
    return value ? [slotSnapshot(slideId, def, z, value)] : [];
  });
}

// --- Suggestions plumbing ---

function proposal(
  doc: Y.Doc,
  suggest: NonNullable<DeckOpOptions["suggest"]>
): SlideSuggestion {
  const existing = deckSuggestions(doc).get(suggest.id);
  return existing?.status === "pending"
    ? existing
    : {
        id: suggest.id,
        actorId: suggest.actor.id,
        actorName: suggest.actor.name,
        ...(suggest.approver ? { approver: suggest.approver } : {}),
        ...(suggest.approverId ? { approverId: suggest.approverId } : {}),
        status: "pending",
        changes: [],
        textElementIds: [],
        createdAt: new Date().toISOString(),
      };
}

function propose(
  doc: Y.Doc,
  suggest: NonNullable<DeckOpOptions["suggest"]>,
  changes: SlideChange[],
  textElementIds: string[] = []
): void {
  const current = proposal(doc, suggest);
  deckSuggestions(doc).set(suggest.id, {
    ...current,
    changes: [...current.changes, ...changes],
    textElementIds: [
      ...new Set([...current.textElementIds, ...textElementIds]),
    ],
  });
}

// Replaces a text element's content. In suggest mode the old blocks are marked for deletion and
// the new ones for insertion, so accepting or rejecting settles them exactly.
function replaceText(
  doc: Y.Doc,
  elementId: string,
  markdown: string,
  opts: DeckOpOptions
): boolean {
  const fragment = elementFragment(doc, elementId);
  if (!fragment) {
    return false;
  }
  if (!opts.suggest) {
    editBlocks(fragment, () => markdownToNodes(markdown));
    if (opts.actor) {
      deckEditors(doc).set(elementId, opts.actor);
    }
    return true;
  }
  const blocks = readOutline(fragment).filter((block) => !block.suggestion);
  const last = blocks.at(-1)?.blockId ?? null;
  insertBlocks(fragment, last, markdown, { suggest: opts.suggest });
  for (const block of blocks) {
    deleteBlock(fragment, block.blockId, { suggest: opts.suggest });
  }
  propose(doc, opts.suggest, [], [elementId]);
  return true;
}

function applyChange(
  doc: Y.Doc,
  change: SlideChange,
  actor?: DeckEditor
): void {
  const slides = deckSlides(doc);
  switch (change.type) {
    case "add_slide": {
      if (slides.toArray().includes(change.slideId)) {
        return;
      }
      slides.insert(Math.min(change.position, slides.length), [change.slideId]);
      deckSlideMeta(doc).set(change.slideId, change.meta);
      for (const element of change.elements) {
        writeElement(doc, element, actor);
      }
      return;
    }
    case "delete_slide":
      removeSlide(doc, change.slideId);
      return;
    case "move_slide": {
      const at = slides.toArray().indexOf(change.slideId);
      if (at >= 0) {
        slides.delete(at, 1);
        slides.insert(Math.min(change.position, slides.length), [
          change.slideId,
        ]);
      }
      return;
    }
    case "set_meta":
      deckSlideMeta(doc).set(change.slideId, change.after);
      return;
    case "add_element":
      writeElement(doc, change.element, actor);
      return;
    case "set_element":
      patchElement(doc, change.elementId, change.after, actor);
      return;
    case "delete_element":
      removeElement(doc, change.before.id);
      return;
    case "set_theme":
      writeTheme(doc, change.after);
      return;
  }
}

function removeSlide(doc: Y.Doc, slideId: string): void {
  const slides = deckSlides(doc);
  const at = slides.toArray().indexOf(slideId);
  if (at >= 0) {
    slides.delete(at, 1);
  }
  deckSlideMeta(doc).delete(slideId);
  for (const id of slideElementIds(doc, slideId)) {
    removeElement(doc, id);
  }
}

function writeTheme(doc: Y.Doc, state: ThemeState): void {
  const map = deckTheme(doc);
  map.set("themeId", state.themeId);
  map.set("overrides", state.overrides);
}

// Runs the change now, or records it on the suggestion.
function commit(doc: Y.Doc, changes: SlideChange[], opts: DeckOpOptions): void {
  if (opts.suggest) {
    propose(doc, opts.suggest, changes);
    return;
  }
  for (const change of changes) {
    applyChange(doc, change, opts.actor);
  }
}

// --- Ops ---

export type AddSlideSpec = SlideContent & {
  id?: string;
  layout?: LayoutId;
  // 1-based; omitted appends.
  position?: number;
  notes?: string;
};

export function addSlide(
  doc: Y.Doc,
  spec: AddSlideSpec,
  opts: DeckOpOptions = {}
): DeckOpResult {
  if (
    spec.id &&
    (!idPattern.test(spec.id) || deckSlideMeta(doc).has(spec.id))
  ) {
    return { ok: false, error: `Slide id ${spec.id} is taken or invalid.` };
  }
  const slideId = spec.id ?? newId("s");
  const layoutId = spec.layout ?? "title_bullets";
  const slides = deckSlides(doc);
  const pendingAdds = opts.suggest
    ? proposal(doc, opts.suggest).changes.filter((c) => c.type === "add_slide")
        .length
    : 0;
  const position =
    spec.position === undefined
      ? slides.length + pendingAdds
      : Math.max(0, spec.position - 1);
  doc.transact(() =>
    commit(
      doc,
      [
        {
          type: "add_slide",
          slideId,
          position,
          meta: { layoutId, notes: spec.notes ?? "", hidden: false },
          elements: layoutSnapshots(slideId, layoutId, spec),
        },
      ],
      opts
    )
  );
  return { ok: true, ids: [slideId] };
}

export type UpdateSlideSpec = SlideContent & {
  slide: string;
  layout?: LayoutId;
  notes?: string;
  hidden?: boolean;
};

export function updateSlide(
  doc: Y.Doc,
  spec: UpdateSlideSpec,
  opts: DeckOpOptions = {}
): DeckOpResult {
  const meta = deckSlideMeta(doc).get(spec.slide);
  if (!meta) {
    return { ok: false, error: `No slide ${spec.slide}.` };
  }
  const layoutId = spec.layout ?? meta.layoutId;
  const changes: SlideChange[] = [];
  const touched: string[] = [];
  doc.transact(() => {
    const nextMeta: SlideMeta = {
      layoutId,
      notes: spec.notes ?? meta.notes,
      hidden: spec.hidden ?? meta.hidden,
    };
    if (JSON.stringify(nextMeta) !== JSON.stringify(meta)) {
      changes.push({
        type: "set_meta",
        slideId: spec.slide,
        before: meta,
        after: nextMeta,
      });
    }
    const defs = deckLayouts[layoutId];
    // A new layout moves every slotted element to its new place.
    if (spec.layout && spec.layout !== meta.layoutId) {
      for (const def of defs) {
        const id = slotElement(doc, spec.slide, def.slot);
        const map = id ? deckElements(doc).get(id) : undefined;
        if (id && map) {
          const before = snapshotOf(id, map);
          changes.push({
            type: "set_element",
            elementId: id,
            before: {
              x: before.x,
              y: before.y,
              w: before.w,
              h: before.h,
              style: before.style,
            },
            after: { x: def.x, y: def.y, w: def.w, h: def.h, style: def.style },
          });
        } else if (def.decorative) {
          changes.push({
            type: "add_element",
            element: slotSnapshot(
              spec.slide,
              def,
              maxZ(doc, spec.slide) + 1,
              null
            ),
          });
        }
      }
      const keep = new Set<string>(defs.map((def) => def.slot));
      for (const id of slideElementIds(doc, spec.slide)) {
        const map = deckElements(doc).get(id);
        const before = map ? snapshotOf(id, map) : null;
        if (
          before?.slot &&
          !keep.has(before.slot) &&
          deckLayouts[meta.layoutId].some(
            (d) => d.slot === before.slot && d.decorative
          )
        ) {
          changes.push({ type: "delete_element", before });
        }
      }
    }
    for (const [slot, value] of slotValues(fitContent(layoutId, spec))) {
      const def = defs.find((d) => d.slot === slot);
      const id = slotElement(doc, spec.slide, slot);
      const map = id ? deckElements(doc).get(id) : undefined;
      if (id && map && value === null) {
        changes.push({ type: "delete_element", before: snapshotOf(id, map) });
      } else if (id && map && value && "text" in value) {
        replaceText(doc, id, value.text, opts);
        touched.push(id);
      } else if (id && map && value && "data" in value) {
        changes.push({
          type: "set_element",
          elementId: id,
          before: { data: snapshotOf(id, map).data ?? undefined },
          after: { data: value.data },
        });
      } else if (!id && def && value) {
        changes.push({
          type: "add_element",
          element: slotSnapshot(
            spec.slide,
            def,
            maxZ(doc, spec.slide) + 1,
            value
          ),
        });
      }
    }
    commit(doc, changes, opts);
  });
  return { ok: true, ids: [spec.slide, ...touched] };
}

export function moveSlide(
  doc: Y.Doc,
  slideId: string,
  position: number,
  opts: DeckOpOptions = {}
): DeckOpResult {
  const slides = deckSlides(doc).toArray();
  const from = slides.indexOf(slideId);
  if (from < 0 || position < 1 || position > slides.length) {
    return {
      ok: false,
      error: `Slide ${slideId} or position ${position} is outside the deck (1–${slides.length}).`,
    };
  }
  doc.transact(() =>
    commit(
      doc,
      [{ type: "move_slide", slideId, position: position - 1, from }],
      opts
    )
  );
  return { ok: true, ids: [slideId] };
}

export function deleteSlide(
  doc: Y.Doc,
  slideId: string,
  opts: DeckOpOptions = {}
): DeckOpResult {
  if (!deckSlideMeta(doc).has(slideId)) {
    return { ok: false, error: `No slide ${slideId}.` };
  }
  doc.transact(() =>
    commit(
      doc,
      [{ type: "delete_slide", slideId, title: slideTitle(doc, slideId) }],
      opts
    )
  );
  return { ok: true, ids: [slideId] };
}

export function setTheme(
  doc: Y.Doc,
  next: { themeId?: ThemeId; overrides?: ThemeOverrides },
  opts: DeckOpOptions = {}
): DeckOpResult {
  const before = readThemeState(doc);
  const after: ThemeState = {
    themeId: next.themeId ?? before.themeId,
    overrides: next.overrides ?? before.overrides,
  };
  doc.transact(() => commit(doc, [{ type: "set_theme", before, after }], opts));
  return { ok: true, ids: [after.themeId] };
}

export type EditElementSpec = ElementPatch & {
  element: string;
  text?: string;
  delete?: boolean;
};

export function editElement(
  doc: Y.Doc,
  spec: EditElementSpec,
  opts: DeckOpOptions = {}
): DeckOpResult {
  const map = deckElements(doc).get(spec.element);
  if (!map) {
    return { ok: false, error: `No element ${spec.element}.` };
  }
  const before = snapshotOf(spec.element, map);
  doc.transact(() => {
    if (spec.delete) {
      commit(doc, [{ type: "delete_element", before }], opts);
      return;
    }
    if (spec.text !== undefined) {
      replaceText(doc, spec.element, spec.text, opts);
    }
    const keys = patchKeys.filter((key) => spec[key] !== undefined);
    if (keys.length > 0) {
      commit(
        doc,
        [
          {
            type: "set_element",
            elementId: spec.element,
            before: pickPatch(before, keys),
            after: pickPatch(spec, keys),
          },
        ],
        opts
      );
    }
  });
  return { ok: true, ids: [spec.element] };
}

export type AddElementSpec = Partial<Geometry> & {
  id?: string;
  slide: string;
  kind: ElementKind;
  text?: string;
  style?: ElementStyle;
  data?: ElementData;
};

export function addElement(
  doc: Y.Doc,
  spec: AddElementSpec,
  opts: DeckOpOptions = {}
): DeckOpResult {
  if (!deckSlideMeta(doc).has(spec.slide)) {
    return { ok: false, error: `No slide ${spec.slide}.` };
  }
  if (spec.id && (!idPattern.test(spec.id) || deckElements(doc).has(spec.id))) {
    return { ok: false, error: `Element id ${spec.id} is taken or invalid.` };
  }
  const id = spec.id ?? newId("e");
  const element: ElementSnapshot = {
    id,
    slideId: spec.slide,
    kind: spec.kind,
    slot: null,
    x: spec.x ?? margin,
    y: spec.y ?? 290,
    w: spec.w ?? 600,
    h: spec.h ?? 200,
    z: spec.z ?? maxZ(doc, spec.slide) + 1,
    rotation: spec.rotation ?? 0,
    style: spec.style ?? (spec.kind === "text" ? { role: "body" } : {}),
    data: spec.data ?? (spec.kind === "shape" ? { shape: "rect" } : null),
    text: spec.kind === "text" ? (spec.text ?? "") : null,
  };
  doc.transact(() => commit(doc, [{ type: "add_element", element }], opts));
  return { ok: true, ids: [id] };
}

// A person's direct edit from the UI: geometry or style, attributed to them.
export function setElementByHand(
  doc: Y.Doc,
  elementId: string,
  patch: ElementPatch,
  actor: DeckEditor
): void {
  doc.transact(() => patchElement(doc, elementId, patch, actor));
}

export function markEditedByHand(
  doc: Y.Doc,
  elementId: string,
  actor: DeckEditor
): void {
  if (deckEditors(doc).get(elementId)?.id !== actor.id) {
    deckEditors(doc).set(elementId, actor);
  }
}

export function removeElementByHand(doc: Y.Doc, elementId: string): void {
  doc.transact(() => removeElement(doc, elementId));
}

export function duplicateElementByHand(
  doc: Y.Doc,
  elementId: string,
  actor: DeckEditor
): string | null {
  const map = deckElements(doc).get(elementId);
  if (!map) {
    return null;
  }
  const copy = snapshotOf(elementId, map);
  const id = newId("e");
  doc.transact(() =>
    writeElement(
      doc,
      {
        ...copy,
        id,
        slot: null,
        x: copy.x + 40,
        y: copy.y + 40,
        z: maxZ(doc, copy.slideId) + 1,
      },
      actor
    )
  );
  return id;
}

// Elements among `ids` a person last wrote.
export function humanWrittenElements(doc: Y.Doc, ids: string[]): string[] {
  const editors = deckEditors(doc);
  return ids.filter(
    (id) => deckElements(doc).has(id) && editors.get(id)?.kind === "human"
  );
}

// --- Suggestions ---

export function acceptSlideSuggestion(
  doc: Y.Doc,
  id: string,
  actor?: DeckEditor
): void {
  const suggestion = deckSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  doc.transact(() => {
    for (const change of suggestion.changes) {
      applyChange(doc, change, actor);
    }
    for (const elementId of suggestion.textElementIds) {
      const fragment = elementFragment(doc, elementId);
      if (fragment) {
        acceptSuggestion(fragment, id);
        if (actor) {
          deckEditors(doc).set(elementId, actor);
        }
      }
    }
    deckSuggestions(doc).set(id, { ...suggestion, status: "accepted" });
  });
}

export function rejectSlideSuggestion(doc: Y.Doc, id: string): void {
  const suggestion = deckSuggestions(doc).get(id);
  if (suggestion?.status !== "pending") {
    return;
  }
  doc.transact(() => {
    for (const elementId of suggestion.textElementIds) {
      const fragment = elementFragment(doc, elementId);
      if (fragment) {
        rejectSuggestion(fragment, id);
      }
    }
    deckSuggestions(doc).set(id, { ...suggestion, status: "rejected" });
  });
}

export type SuggestionLine = {
  kind: "added" | "changed" | "removed" | "moved" | "theme";
  label: string;
  slideId: string | null;
  elementId: string | null;
};

export type PendingSlideSuggestion = SlideSuggestion & {
  lines: SuggestionLine[];
  stale: boolean;
};

function elementLabel(snapshot: ElementSnapshot): string {
  const firstLine = snapshot.text?.split("\n").find((line) => line.trim());
  return (
    firstLine?.replace(/^[-*#>\s]+/, "").slice(0, 80) ??
    snapshot.slot ??
    snapshot.kind
  );
}

export function slideTitle(doc: Y.Doc, slideId: string): string {
  const id = slotElement(doc, slideId, "title");
  const map = id ? deckElements(doc).get(id) : undefined;
  return map ? elementLabel(snapshotOf(id ?? "", map)) : "Untitled slide";
}

function proposedText(doc: Y.Doc, elementId: string, id: string): string {
  const fragment = elementFragment(doc, elementId);
  if (!fragment) {
    return "";
  }
  return readOutline(fragment)
    .filter(
      (block) =>
        block.suggestion?.id === id && block.suggestion.kind === "insert"
    )
    .map((block) => block.text)
    .join(" / ");
}

export function pendingSlideSuggestions(doc: Y.Doc): PendingSlideSuggestion[] {
  const elements = deckElements(doc);
  const current = (id: string) => {
    const map = elements.get(id);
    return map ? snapshotOf(id, map) : null;
  };
  return [...deckSuggestions(doc).values()]
    .filter((suggestion) => suggestion.status === "pending")
    .map((suggestion) => {
      const lines: SuggestionLine[] = suggestion.changes.map((change) => {
        switch (change.type) {
          case "add_slide": {
            const title = change.elements.find((e) => e.slot === "title");
            return {
              kind: "added",
              label: `Slide: ${title ? elementLabel(title) : "untitled"}`,
              slideId: change.slideId,
              elementId: null,
            };
          }
          case "delete_slide":
            return {
              kind: "removed",
              label: `Slide: ${change.title}`,
              slideId: change.slideId,
              elementId: null,
            };
          case "move_slide":
            return {
              kind: "moved",
              label: `Slide to position ${change.position + 1}`,
              slideId: change.slideId,
              elementId: null,
            };
          case "set_meta":
            return {
              kind: "changed",
              label:
                change.before.layoutId !== change.after.layoutId
                  ? `Layout: ${change.after.layoutId}`
                  : "Notes",
              slideId: change.slideId,
              elementId: null,
            };
          case "add_element":
            return {
              kind: "added",
              label: elementLabel(change.element),
              slideId: change.element.slideId,
              elementId: change.element.id,
            };
          case "set_element": {
            const now = current(change.elementId);
            const label = now ? elementLabel(now) : change.elementId;
            const what =
              "data" in change.after
                ? "Data"
                : "style" in change.after && !("x" in change.after)
                  ? "Style"
                  : "Placement";
            return {
              kind: "changed",
              label: `${what}: ${label}`,
              slideId: now?.slideId ?? null,
              elementId: change.elementId,
            };
          }
          case "delete_element":
            return {
              kind: "removed",
              label: elementLabel(change.before),
              slideId: change.before.slideId,
              elementId: change.before.id,
            };
          case "set_theme":
            return {
              kind: "theme",
              label: deckThemes[change.after.themeId].name,
              slideId: null,
              elementId: null,
            };
        }
      });
      const textLines: SuggestionLine[] = suggestion.textElementIds.map(
        (elementId) => ({
          kind: "changed",
          label: proposedText(doc, elementId, suggestion.id),
          slideId: current(elementId)?.slideId ?? null,
          elementId,
        })
      );
      const stale = suggestion.changes.some((change) => {
        if (change.type !== "set_element") {
          return false;
        }
        const now = current(change.elementId);
        const keys = patchKeys.filter((key) => key in change.before);
        return (
          !now ||
          JSON.stringify(pickPatch(now, keys)) !==
            JSON.stringify(pickPatch(change.before, keys))
        );
      });
      return { ...suggestion, lines: [...lines, ...textLines], stale };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// --- Reading ---

export type DeckElementView = ElementSnapshot & { by: string | null };

export type DeckSlideView = {
  id: string;
  number: number;
  layout: LayoutId;
  hidden: boolean;
  notes: string;
  title: string;
  elements: DeckElementView[];
};

export type DeckView = {
  theme: ThemeState & { name: string; mode: "light" | "dark" };
  slides: DeckSlideView[];
};

export function readDeck(doc: Y.Doc): DeckView {
  const editors = deckEditors(doc);
  const elements = [...deckElements(doc).entries()].map(([id, map]) => ({
    ...snapshotOf(id, map),
    by:
      editors.get(id)?.kind === "human"
        ? (editors.get(id)?.name ?? null)
        : null,
  }));
  const bySlide = new Map<string, DeckElementView[]>();
  for (const element of elements) {
    bySlide.set(element.slideId, [
      ...(bySlide.get(element.slideId) ?? []),
      element,
    ]);
  }
  const themeState = readThemeState(doc);
  const theme = deckThemes[themeState.themeId];
  return {
    theme: { ...themeState, name: theme.name, mode: theme.mode },
    slides: deckSlides(doc)
      .toArray()
      .flatMap((id, i) => {
        const meta = deckSlideMeta(doc).get(id);
        if (!meta) {
          return [];
        }
        return [
          {
            id,
            number: i + 1,
            layout: meta.layoutId,
            hidden: meta.hidden,
            notes: meta.notes,
            title: slideTitle(doc, id),
            elements: (bySlide.get(id) ?? []).sort((a, b) => a.z - b.z),
          },
        ];
      }),
  };
}

// The richtext JSON of a text element, for renderers and exporters.
export function elementBlocks(doc: Y.Doc, elementId: string): JSONContent[] {
  const fragment = elementFragment(doc, elementId);
  return fragment ? readBlocks(fragment) : [];
}

// --- History ---

export function docFromState(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) {
    Y.applyUpdate(doc, state);
  }
  return doc;
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

// Writes a version forward as one edit, keeping element maps (and their text items) that still
// exist so open editors keep their place.
export function restoreSlides(doc: Y.Doc, version: Y.Doc): void {
  const elements = deckElements(doc);
  const target = deckElements(version);
  doc.transact(() => {
    const order = deckSlides(version).toArray();
    const slides = deckSlides(doc);
    if (JSON.stringify(slides.toArray()) !== JSON.stringify(order)) {
      slides.delete(0, slides.length);
      slides.insert(0, order);
    }
    syncMap(deckSlideMeta(doc), deckSlideMeta(version));
    for (const id of [...elements.keys()]) {
      if (!target.has(id)) {
        elements.delete(id);
      }
    }
    for (const [id, versionMap] of target.entries()) {
      const was = snapshotOf(id, versionMap);
      const map = elements.get(id);
      if (!map) {
        writeElement(doc, was);
        const fragment = elementFragment(doc, id);
        const versionText = textOf(versionMap);
        if (fragment && versionText) {
          restoreBlocks(fragment, versionText);
        }
        continue;
      }
      const fields: [string, unknown][] = [
        ["slideId", was.slideId],
        ["kind", was.kind],
        ["slot", was.slot],
        ...patchKeys.map((key): [string, unknown] => [key, was[key]]),
      ];
      for (const [key, value] of fields) {
        if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
          map.set(key, value);
        }
      }
      const fragment = textOf(map);
      const versionText = textOf(versionMap);
      if (fragment && versionText) {
        restoreBlocks(fragment, versionText);
      }
    }
    syncMap(deckTheme(doc), deckTheme(version));
    syncMap(deckEditors(doc), deckEditors(version));
    syncMap(deckSuggestions(doc), deckSuggestions(version));
  });
}

export type DeckChange = {
  kind: "added" | "removed" | "changed";
  target: "slide" | "element" | "theme";
  label: string;
  slide: string | null;
};

export function diffSlides(before: Y.Doc, after: Y.Doc): DeckChange[] {
  const was = readDeck(before);
  const now = readDeck(after);
  const changes: DeckChange[] = [];
  if (was.theme.themeId !== now.theme.themeId) {
    changes.push({
      kind: "changed",
      target: "theme",
      label: now.theme.name,
      slide: null,
    });
  }
  const wasSlides = new Map(was.slides.map((slide) => [slide.id, slide]));
  const nowSlides = new Map(now.slides.map((slide) => [slide.id, slide]));
  for (const slide of now.slides) {
    if (!wasSlides.has(slide.id)) {
      changes.push({
        kind: "added",
        target: "slide",
        label: slide.title,
        slide: slide.title,
      });
    }
  }
  for (const slide of was.slides) {
    if (!nowSlides.has(slide.id)) {
      changes.push({
        kind: "removed",
        target: "slide",
        label: slide.title,
        slide: slide.title,
      });
    }
  }
  const fingerprint = (element: DeckElementView) =>
    JSON.stringify([
      element.x,
      element.y,
      element.w,
      element.h,
      element.style,
      element.data,
      element.text,
    ]);
  for (const slide of now.slides) {
    const previous = wasSlides.get(slide.id);
    if (!previous) {
      continue;
    }
    const wasElements = new Map(previous.elements.map((e) => [e.id, e]));
    const nowIds = new Set(slide.elements.map((e) => e.id));
    for (const element of slide.elements) {
      const old = wasElements.get(element.id);
      if (!old) {
        changes.push({
          kind: "added",
          target: "element",
          label: elementLabel(element),
          slide: slide.title,
        });
      } else if (fingerprint(old) !== fingerprint(element)) {
        changes.push({
          kind: "changed",
          target: "element",
          label: elementLabel(element),
          slide: slide.title,
        });
      }
    }
    for (const element of previous.elements) {
      if (!nowIds.has(element.id)) {
        changes.push({
          kind: "removed",
          target: "element",
          label: elementLabel(element),
          slide: slide.title,
        });
      }
    }
  }
  return changes;
}

export function isDeckDoc(doc: Y.Doc): boolean {
  return deckSlides(doc).length > 0 || deckSlideMeta(doc).size > 0;
}
