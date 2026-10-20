import { z } from "zod";

// An agent acts for a person; `onBehalfOf` names them so the log and the ledger say whose Juno
// did what, even when the same agent serves two people.
export const liveActorSchema = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  onBehalfOf: z.object({ id: z.string(), name: z.string() }).optional(),
});

export const liveAccessSchema = z.enum(["read", "write", "suggest"]);

export const liveTokenClaimsSchema = z.object({
  actor: liveActorSchema,
  workspaceId: z.string(),
  docName: z.string(),
  access: liveAccessSchema,
  // The browser extension sharing the person's own tab, which serves as the doc's browser.
  via: z.literal("extension").optional(),
});

export type LiveTokenClaims = z.infer<typeof liveTokenClaimsSchema>;
export type LiveActor = LiveTokenClaims["actor"];
export type LiveAccess = LiveTokenClaims["access"];

// The kinds a person opens as a live object. `chat` is a room kind too, but Airlink draws it as
// the channel itself, never as an object.
export type LiveDocKind =
  | "doc"
  | "sheet"
  | "canvas"
  | "slides"
  | "browser"
  | "desktop"
  | "media"
  | "space"
  | "file"
  | "runner";

export const systemActor: LiveActor = {
  kind: "agent",
  id: "system",
  name: "System",
};

// A service token lets the host app read summaries across docs of one workspace; only the host,
// which holds the secret, can mint it.
export const liveServiceClaimsSchema = z.object({
  scope: z.literal("service"),
  workspaceId: z.string(),
});

export type LiveServiceClaims = z.infer<typeof liveServiceClaimsSchema>;

export const richTextOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("insert"),
    afterBlockId: z.string().nullable(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("replace"),
    blockId: z.string(),
    markdown: z.string(),
  }),
  z.object({ type: z.literal("delete"), blockId: z.string() }),
]);

export type RichTextOp = z.infer<typeof richTextOpSchema>;

export const liveOpsRequestSchema = z.object({
  ops: z.array(richTextOpSchema).min(1).max(50),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type LiveOpsRequest = z.input<typeof liveOpsRequestSchema>;

export const liveOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({ ok: z.literal(true), blockIds: z.array(z.string()) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  ),
  suggestionId: z.string().nullable(),
});

export type LiveOpsResponse = z.infer<typeof liveOpsResponseSchema>;

const sheetValuesSchema = z
  .array(z.array(z.string().max(10_000)).max(200))
  .min(1)
  .max(2000);

export const sheetOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_range"),
    range: z.string(),
    values: sheetValuesSchema,
  }),
  z.object({
    type: z.literal("add_rows"),
    afterRow: z.number().int().min(0).nullable(),
    values: sheetValuesSchema,
  }),
  z.object({
    type: z.literal("delete_rows"),
    fromRow: z.number().int().min(1),
    toRow: z.number().int().min(1),
  }),
  z.object({
    type: z.literal("format_columns"),
    columns: z.string(),
    format: z
      .enum(["text", "number", "currency", "percent", "date"])
      .optional(),
    width: z.number().int().min(40).max(800).optional(),
  }),
]);

export type SheetOp = z.infer<typeof sheetOpSchema>;

export const sheetOpsRequestSchema = z.object({
  ops: z.array(sheetOpSchema).min(1).max(50),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type SheetOpsRequest = z.input<typeof sheetOpsRequestSchema>;

export const sheetOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({
        ok: z.literal(true),
        range: z.string(),
        // Set when the op would have changed cells a person wrote, so it became a suggestion.
        suggested: z.boolean().optional(),
        humanCells: z.array(z.string()).optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  ),
  suggestionId: z.string().nullable(),
});

export type SheetOpsResponse = z.infer<typeof sheetOpsResponseSchema>;

const cellValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null(),
  z.object({ error: z.string() }),
]);

export const sheetReadResponseSchema = z.object({
  range: z.string().nullable(),
  rowCount: z.number(),
  colCount: z.number(),
  columns: z.array(
    z.object({
      column: z.string(),
      format: z.string().optional(),
      width: z.number().optional(),
    })
  ),
  rows: z.array(
    z.object({
      row: z.number(),
      cells: z.array(
        z.object({
          cell: z.string(),
          input: z.string(),
          value: cellValueSchema,
          editor: z
            .object({ kind: z.enum(["human", "agent"]), name: z.string() })
            .nullable()
            .default(null),
        })
      ),
    })
  ),
  suggestions: z.array(
    z.object({
      id: z.string(),
      actorName: z.string(),
      approver: z.string().optional(),
      cells: z.array(
        z.object({ cell: z.string(), before: z.string(), after: z.string() })
      ),
      insertRows: z.number(),
      deleteRows: z.number(),
      stale: z.boolean(),
    })
  ),
});

export type SheetReadResponse = z.infer<typeof sheetReadResponseSchema>;

const elementIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const coordinateSchema = z.number().min(-100_000).max(100_000);
const sizeSchema = z.number().min(4).max(10_000);
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|transparent)$/);

export const canvasOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_shapes"),
    shapes: z
      .array(
        z.object({
          id: elementIdSchema.optional(),
          type: z.enum(["rectangle", "ellipse", "diamond", "text"]),
          x: coordinateSchema,
          y: coordinateSchema,
          width: sizeSchema.optional(),
          height: sizeSchema.optional(),
          label: z.string().max(2000).optional(),
          color: colorSchema.optional(),
          fill: colorSchema.optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("connect"),
    arrows: z
      .array(
        z.object({
          id: elementIdSchema.optional(),
          from: elementIdSchema,
          to: elementIdSchema,
          label: z.string().max(200).optional(),
          color: colorSchema.optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("update_shapes"),
    updates: z
      .array(
        z.object({
          id: elementIdSchema,
          label: z.string().max(2000).optional(),
          x: coordinateSchema.optional(),
          y: coordinateSchema.optional(),
          width: sizeSchema.optional(),
          height: sizeSchema.optional(),
          color: colorSchema.optional(),
          fill: colorSchema.optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("delete_shapes"),
    ids: z.array(elementIdSchema).min(1).max(100),
  }),
]);

export type CanvasOp = z.infer<typeof canvasOpSchema>;

export const canvasOpsRequestSchema = z.object({
  ops: z.array(canvasOpSchema).min(1).max(50),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type CanvasOpsRequest = z.input<typeof canvasOpsRequestSchema>;

export const canvasOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({
        ok: z.literal(true),
        ids: z.array(z.string()),
        // Set when the op would have changed shapes a person wrote, so it became a suggestion.
        suggested: z.boolean().optional(),
        humanShapes: z.array(z.string()).optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  ),
  suggestionId: z.string().nullable(),
});

export type CanvasOpsResponse = z.infer<typeof canvasOpsResponseSchema>;

const canvasShapeViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  label: z.string(),
  frame: z.string().nullable(),
  by: z.string().nullable(),
});

const canvasConnectionViewSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string(),
});

export const canvasReadResponseSchema = z.object({
  shapes: z.array(canvasShapeViewSchema),
  connections: z.array(canvasConnectionViewSchema),
  suggestions: z.array(
    z.object({
      id: z.string(),
      actorName: z.string(),
      approver: z.string().optional(),
      changes: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          kind: z.enum(["added", "changed", "removed"]),
        })
      ),
      stale: z.boolean(),
    })
  ),
});

export type CanvasReadResponse = z.infer<typeof canvasReadResponseSchema>;

// Chat (Airlink D). Mentions are chips, never text, so routing reads them structurally. Chat is
// never binding: the request keeps `mode` for the runner's shape, but no op becomes a suggestion.
export const chatMentionSchema = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
});

export type ChatMention = z.infer<typeof chatMentionSchema>;

export const chatAttachmentSchema = z.object({
  docName: z.string().min(1).max(200),
  title: z.string().max(512).optional(),
});

const chatMessageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

export const chatOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("post_message"),
    id: chatMessageIdSchema.optional(),
    text: z.string().max(20_000),
    mentions: z.array(chatMentionSchema).max(50).optional(),
    attachments: z.array(chatAttachmentSchema).max(20).optional(),
  }),
  z.object({
    type: z.literal("edit_message"),
    id: chatMessageIdSchema,
    text: z.string().max(20_000),
  }),
  z.object({
    type: z.literal("react"),
    id: chatMessageIdSchema,
    emoji: z.string().min(1).max(16),
  }),
  // Changes nothing: shows the actor typing in the channel for a few seconds. An agent's runtime
  // sends it while the agent works on a reply.
  z.object({ type: z.literal("typing") }),
]);

export type ChatOp = z.infer<typeof chatOpSchema>;

export const chatOpsRequestSchema = z.object({
  ops: z.array(chatOpSchema).min(1).max(20),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type ChatOpsRequest = z.input<typeof chatOpsRequestSchema>;

export const chatOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({ ok: z.literal(true), id: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  ),
  suggestionId: z.null(),
});

export type ChatOpsResponse = z.infer<typeof chatOpsResponseSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  actor: liveActorSchema,
  text: z.string(),
  mentions: z.array(chatMentionSchema),
  attachments: z.array(chatAttachmentSchema),
  ts: z.number(),
  editedAt: z.number().optional(),
  reactions: z.record(z.string(), z.array(z.string())),
});

export const chatReadResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export type ChatReadResponse = z.infer<typeof chatReadResponseSchema>;

// A space arranges a room's objects as windows. It is never binding: `mode` is kept for the
// runner's shape and ignored, and an agent's change to a window a person arranged is refused.
const spaceObjectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const spaceMinWidth = 240;
const spaceMinHeight = 160;

export const spaceOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("place"),
    docName: z.string().min(1).max(200),
    kind: z.string().min(1).max(32),
    title: z.string().max(512),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    w: z.number().finite().min(spaceMinWidth).optional(),
    h: z.number().finite().min(spaceMinHeight).optional(),
  }),
  z.object({
    type: z.literal("move"),
    id: spaceObjectIdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({
    type: z.literal("resize"),
    id: spaceObjectIdSchema,
    w: z.number().finite().min(spaceMinWidth),
    h: z.number().finite().min(spaceMinHeight),
  }),
  z.object({ type: z.literal("remove"), id: spaceObjectIdSchema }),
  z.object({ type: z.literal("bring_to_front"), id: spaceObjectIdSchema }),
  z.object({
    type: z.literal("set_state"),
    id: spaceObjectIdSchema,
    state: z.enum(["open", "minimized", "maximized"]),
  }),
]);

export type SpaceOp = z.infer<typeof spaceOpSchema>;

export const spaceOpsRequestSchema = z.object({
  ops: z.array(spaceOpSchema).min(1).max(50),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type SpaceOpsRequest = z.input<typeof spaceOpsRequestSchema>;

export const spaceOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({ ok: z.literal(true), id: z.string() }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        by: z.string().optional(),
      }),
    ])
  ),
  suggestionId: z.null(),
});

export type SpaceOpsResponse = z.infer<typeof spaceOpsResponseSchema>;

export const spaceObjectViewSchema = z.object({
  id: z.string(),
  docName: z.string(),
  kind: z.string(),
  title: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  state: z.enum(["open", "minimized", "maximized"]).default("open"),
  by: z.object({
    kind: z.enum(["human", "agent"]),
    id: z.string(),
    name: z.string(),
  }),
});

export const spaceReadResponseSchema = z.object({
  objects: z.array(spaceObjectViewSchema),
});

export type SpaceReadResponse = z.infer<typeof spaceReadResponseSchema>;

const deckLayoutSchema = z.enum([
  "title",
  "title_bullets",
  "section",
  "two_column",
  "chart_takeaway",
  "image_full",
  "quote",
  "closing",
]);

const deckColorSchema = z
  .string()
  .regex(
    /^(#[0-9a-fA-F]{6}|background|surface|text|muted|accent|accentContrast|border)$/
  );

const deckStyleSchema = z.object({
  role: z
    .enum(["title", "heading", "subtitle", "body", "quote", "caption"])
    .optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  color: deckColorSchema.optional(),
  fill: deckColorSchema.optional(),
  stroke: deckColorSchema.optional(),
  radius: z.number().min(0).max(540).optional(),
  opacity: z.number().min(0).max(1).optional(),
});

const deckChartSchema = z.object({
  chart: z.enum(["bar", "line", "pie"]),
  labels: z.array(z.string().max(80)).min(1).max(24),
  series: z
    .array(
      z.object({
        name: z.string().max(80),
        values: z.array(z.number()).min(1).max(24),
      })
    )
    .min(1)
    .max(6),
});

const deckImageSchema = z.object({
  url: z
    .string()
    .url()
    .regex(/^https:\/\//),
  alt: z.string().max(300),
});

const deckDataSchema = z.union([
  deckChartSchema,
  deckImageSchema,
  z.object({
    rows: z
      .array(z.array(z.string().max(200)).max(8))
      .min(1)
      .max(12),
    header: z.boolean(),
  }),
  z.object({ shape: z.enum(["rect", "ellipse", "line"]) }),
]);

const deckIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const deckLinesSchema = z.array(z.string().max(300)).max(12);
const deckPositionSchema = z.number().min(0).max(1920);

const slideContentSchema = {
  title: z.string().max(300).optional(),
  subtitle: z.string().max(500).optional(),
  bullets: deckLinesSchema.optional(),
  rightBullets: deckLinesSchema.optional(),
  quote: z.string().max(600).optional(),
  attribution: z.string().max(200).optional(),
  chart: deckChartSchema.optional(),
  image: deckImageSchema.optional(),
};

export const slidesOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_slide"),
    id: deckIdSchema.optional(),
    layout: deckLayoutSchema.optional(),
    position: z.number().int().min(1).optional(),
    notes: z.string().max(5000).optional(),
    ...slideContentSchema,
  }),
  z.object({
    type: z.literal("update_slide"),
    slide: deckIdSchema,
    layout: deckLayoutSchema.optional(),
    notes: z.string().max(5000).optional(),
    hidden: z.boolean().optional(),
    ...slideContentSchema,
  }),
  z.object({
    type: z.literal("move_slide"),
    slide: deckIdSchema,
    position: z.number().int().min(1),
  }),
  z.object({ type: z.literal("delete_slide"), slide: deckIdSchema }),
  z.object({
    type: z.literal("set_theme"),
    themeId: z.enum(["studio", "midnight"]).optional(),
    overrides: z
      .object({
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        background: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("edit_element"),
    element: deckIdSchema,
    x: deckPositionSchema.optional(),
    y: deckPositionSchema.optional(),
    w: z.number().min(4).max(1920).optional(),
    h: z.number().min(4).max(1080).optional(),
    z: z.number().int().min(0).max(1000).optional(),
    rotation: z.number().min(-360).max(360).optional(),
    style: deckStyleSchema.optional(),
    data: deckDataSchema.optional(),
    text: z.string().max(5000).optional(),
    delete: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add_element"),
    id: deckIdSchema.optional(),
    slide: deckIdSchema,
    kind: z.enum(["text", "shape", "image", "chart", "table"]),
    x: deckPositionSchema.optional(),
    y: deckPositionSchema.optional(),
    w: z.number().min(4).max(1920).optional(),
    h: z.number().min(4).max(1080).optional(),
    text: z.string().max(5000).optional(),
    style: deckStyleSchema.optional(),
    data: deckDataSchema.optional(),
  }),
]);

export type SlidesOp = z.infer<typeof slidesOpSchema>;

export const slidesOpsRequestSchema = z.object({
  ops: z.array(slidesOpSchema).min(1).max(40),
  mode: z.enum(["edit", "suggest"]).default("edit"),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export type SlidesOpsRequest = z.input<typeof slidesOpsRequestSchema>;

export const slidesOpsResponseSchema = z.object({
  results: z.array(
    z.union([
      z.object({
        ok: z.literal(true),
        ids: z.array(z.string()),
        // Set when the op would have changed elements a person wrote, so it became a suggestion.
        suggested: z.boolean().optional(),
        humanElements: z.array(z.string()).optional(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
  ),
  suggestionId: z.string().nullable(),
});

export type SlidesOpsResponse = z.infer<typeof slidesOpsResponseSchema>;

export const deckReadResponseSchema = z.object({
  theme: z.object({
    themeId: z.string(),
    name: z.string(),
    mode: z.enum(["light", "dark"]),
  }),
  slides: z.array(
    z.object({
      id: z.string(),
      number: z.number(),
      layout: z.string(),
      hidden: z.boolean(),
      notes: z.string(),
      title: z.string(),
      elements: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          slot: z.string().nullable(),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          text: z.string().nullable(),
          data: z.unknown().nullable(),
          by: z.string().nullable(),
        })
      ),
    })
  ),
  suggestions: z.array(
    z.object({
      id: z.string(),
      actorName: z.string(),
      approver: z.string().optional(),
      lines: z.array(z.object({ kind: z.string(), label: z.string() })),
      stale: z.boolean(),
    })
  ),
});

export type DeckReadResponse = z.infer<typeof deckReadResponseSchema>;

const suggestionSchema = z.object({
  id: z.string(),
  kind: z.enum(["insert", "delete"]),
  actorId: z.string(),
  actorName: z.string(),
  approver: z.string().optional(),
  approverId: z.string().optional(),
});

export const outlineResponseSchema = z.object({
  blocks: z.array(
    z.object({
      blockId: z.string(),
      type: z.string(),
      text: z.string(),
      suggestion: suggestionSchema.nullable(),
    })
  ),
  suggestions: z.array(suggestionSchema),
  threads: z
    .array(
      z.object({
        id: z.string(),
        blockId: z.string(),
        quote: z.string(),
        detached: z.boolean(),
        messages: z.array(
          z.object({ actor: liveActorSchema, body: z.string() })
        ),
      })
    )
    .default([]),
});

export type OutlineResponse = z.infer<typeof outlineResponseSchema>;

const outlineBlockSchema = outlineResponseSchema.shape.blocks.element;

export const historyResponseSchema = z.object({
  sessions: z.array(
    z.object({
      uptoId: z.string(),
      actor: liveActorSchema,
      startedAt: z.string(),
      endedAt: z.string(),
      updates: z.number(),
    })
  ),
  events: z.array(
    z.object({
      type: z.string(),
      actor: liveActorSchema,
      payload: z.record(z.string(), z.unknown()),
      createdAt: z.string(),
    })
  ),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;

export const versionResponseSchema = z.object({
  uptoId: z.string(),
  markdown: z.string(),
  cells: z
    .array(
      z.object({ cell: z.string(), before: z.string(), after: z.string() })
    )
    .default([]),
  slides: z
    .array(
      z.object({
        kind: z.enum(["added", "removed", "changed"]),
        target: z.enum(["slide", "element", "theme"]),
        label: z.string(),
        slide: z.string().nullable(),
      })
    )
    .default([]),
  shapes: z
    .array(
      z.object({
        id: z.string(),
        type: z.string().default("shape"),
        label: z.string(),
        kind: z.enum(["added", "changed", "removed"]),
      })
    )
    .default([]),
  objects: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        kind: z.enum([
          "placed",
          "moved",
          "resized",
          "removed",
          "minimized",
          "maximized",
          "restored",
        ]),
      })
    )
    .default([]),
  diff: z.array(
    z.object({
      blockId: z.string(),
      change: z.enum(["added", "removed", "changed", "same"]),
      before: outlineBlockSchema.nullable(),
      after: outlineBlockSchema.nullable(),
    })
  ),
});

export type VersionResponse = z.infer<typeof versionResponseSchema>;

export const restoreRequestSchema = z.object({ uptoId: z.string() });

// A watch token lets one browser receive activity for the docs its host app says it may see. The
// token is bound to one private `watch:<watchId>` document, so no one else can listen on it.
export const liveWatchClaimsSchema = z.object({
  scope: z.literal("watch"),
  watchId: z.string(),
  workspaceId: z.string(),
  actor: liveActorSchema,
  docNames: z.array(z.string()).max(500),
});

export type LiveWatchClaims = z.infer<typeof liveWatchClaimsSchema>;

export const watchDocPrefix = "watch:";

export const summariesRequestSchema = z.object({
  docNames: z.array(z.string()).max(200),
  // The person the summaries are for: `seenAt` is when they last opened each doc, so a card
  // can say what happened while they were away.
  viewerId: z.string().optional(),
});

export const docSummarySchema = z.object({
  docName: z.string(),
  lastEditor: liveActorSchema.nullable(),
  lastEditedAt: z.string().nullable(),
  seenAt: z.string().nullable().default(null),
  present: z.array(liveActorSchema),
  writing: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["human", "agent"]),
      section: z.string().nullable(),
    })
  ),
  pending: z.array(
    z.object({
      id: z.string(),
      approverId: z.string().nullable(),
      approverName: z.string().nullable(),
      actor: liveActorSchema,
      createdAt: z.string(),
    })
  ),
});

export type DocSummary = z.infer<typeof docSummarySchema>;

export const summariesResponseSchema = z.object({
  summaries: z.array(docSummarySchema),
});

export const commentRequestSchema = z.union([
  z.object({ threadId: z.string(), body: z.string().min(1).max(4000) }),
  z.object({
    blockId: z.string(),
    quote: z.string().max(500).optional(),
    body: z.string().min(1).max(4000),
  }),
]);

export type CommentRequest = z.infer<typeof commentRequestSchema>;

export const commentResponseSchema = z.object({ threadId: z.string() });

export const activityMessageSchema = z.object({
  type: z.literal("activity"),
  summary: docSummarySchema,
});

export type ActivityMessage = z.infer<typeof activityMessageSchema>;

// Shared browser (P5). Agents act by reference from the outline; viewers send raw input over the
// doc socket as stateless messages, and get frames and status back the same way.
const browserRefSchema = z.string().regex(/^e\d{1,4}$/);
const pageCoordinateSchema = z.number().min(-100).max(10_000);
const inputModifiersSchema = z.number().int().min(0).max(15).optional();

export const browserOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().max(2000) }),
  z.object({ type: z.literal("click"), ref: browserRefSchema }),
  z.object({
    type: z.literal("type"),
    ref: browserRefSchema,
    text: z.string().max(2000),
    submit: z.boolean().optional(),
  }),
  z.object({ type: z.literal("press"), key: z.string().min(1).max(40) }),
  z.object({
    type: z.literal("scroll"),
    dy: z.number().min(-10_000).max(10_000),
  }),
  z.object({ type: z.literal("wait"), ms: z.number().min(0).max(5000) }),
]);

export type BrowserOp = z.infer<typeof browserOpSchema>;

export const browserOpsRequestSchema = z.object({
  ops: z.array(browserOpSchema).min(1).max(20),
});

export type BrowserOpsRequest = z.input<typeof browserOpsRequestSchema>;

export const browserPageSchema = z.object({
  url: z.string(),
  title: z.string(),
  controller: liveActorSchema.nullable(),
  outline: z.string(),
  changed: z
    .object({ added: z.array(z.string()), removed: z.array(z.string()) })
    .optional(),
  screenshot: z.string().optional(),
});

export type BrowserPage = z.infer<typeof browserPageSchema>;

export const browserOpsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        heldBy: liveActorSchema.optional(),
      }),
    ])
  ),
  page: browserPageSchema,
});

export type BrowserOpsResponse = z.infer<typeof browserOpsResponseSchema>;

export const browserReadResponseSchema = browserPageSchema;

export type BrowserReadResponse = z.infer<typeof browserReadResponseSchema>;

export const browserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    kind: z.enum(["move", "down", "up"]),
    x: pageCoordinateSchema,
    y: pageCoordinateSchema,
    button: z.enum(["left", "right", "middle", "none"]).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers: inputModifiersSchema,
  }),
  z.object({
    type: z.literal("wheel"),
    x: pageCoordinateSchema,
    y: pageCoordinateSchema,
    deltaX: z.number().min(-10_000).max(10_000),
    deltaY: z.number().min(-10_000).max(10_000),
    modifiers: inputModifiersSchema,
  }),
  z.object({
    type: z.literal("key"),
    kind: z.enum(["down", "up"]),
    key: z.string().min(1).max(40),
    code: z.string().max(40),
    text: z.string().max(10).optional(),
    modifiers: inputModifiersSchema,
  }),
  z.object({ type: z.literal("text"), text: z.string().max(2000) }),
  z.object({ type: z.literal("navigate"), url: z.string().max(2000) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("claim") }),
  z.object({ type: z.literal("release") }),
  // A viewer that attached its listener after the join messages asks for them again.
  z.object({ type: z.literal("status") }),
]);

export type BrowserInput = z.infer<typeof browserInputSchema>;

export const browserStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "unavailable",
]);

export const browserMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser_frame"),
    data: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({
    type: z.literal("browser_status"),
    status: browserStatusSchema,
    url: z.string(),
    title: z.string(),
    controller: liveActorSchema.nullable(),
    video: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("browser_denied"), heldBy: liveActorSchema }),
]);

export type BrowserMessage = z.infer<typeof browserMessageSchema>;

// A viewer's session on the browser's own WebRTC server, minted in the viewer's name.
export const browserVideoResponseSchema = z.object({
  url: z.string(),
  token: z.string(),
});

export type BrowserVideoResponse = z.infer<typeof browserVideoResponseSchema>;

export const browserFramesResponseSchema = z.object({
  frames: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      actor: liveActorSchema,
      createdAt: z.string(),
    })
  ),
});

export type BrowserFramesResponse = z.infer<typeof browserFramesResponseSchema>;

// Shared desktop (P6). A provider (E2B Desktop first) runs the machine; viewers watch its
// view-only stream; every input goes through live-server's mux, humans and agents alike.
const screenCoordinateSchema = z.number().min(0).max(10_000);

export const desktopOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("move"),
    x: screenCoordinateSchema,
    y: screenCoordinateSchema,
  }),
  z.object({
    type: z.literal("click"),
    x: screenCoordinateSchema,
    y: screenCoordinateSchema,
    button: z.enum(["left", "right", "middle"]).default("left"),
    count: z.union([z.literal(1), z.literal(2)]).default(1),
  }),
  z.object({
    type: z.literal("drag"),
    from: z.tuple([screenCoordinateSchema, screenCoordinateSchema]),
    to: z.tuple([screenCoordinateSchema, screenCoordinateSchema]),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().min(1).max(50).default(3),
  }),
  z.object({
    type: z.literal("key"),
    keys: z.array(z.string().min(1).max(40)).min(1).max(5),
  }),
  z.object({ type: z.literal("type"), text: z.string().max(4000) }),
  z.object({ type: z.literal("open"), target: z.string().max(2000) }),
  z.object({
    type: z.literal("launch"),
    application: z.string().max(200),
    uri: z.string().max(2000).optional(),
  }),
  z.object({ type: z.literal("wait"), ms: z.number().min(0).max(5000) }),
]);

export type DesktopOp = z.infer<typeof desktopOpSchema>;

export const desktopOpsRequestSchema = z.object({
  ops: z.array(desktopOpSchema).min(1).max(20),
});

export type DesktopOpsRequest = z.input<typeof desktopOpsRequestSchema>;

export const desktopStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "unavailable",
]);

export const desktopViewSchema = z.object({
  status: desktopStatusSchema,
  screen: z.object({ width: z.number(), height: z.number() }),
  app: z.string(),
  controller: liveActorSchema.nullable(),
  cursor: z.object({ x: z.number(), y: z.number() }).nullable(),
  actions: z.array(
    z.object({
      at: z.string(),
      actor: liveActorSchema,
      action: z.string(),
      detail: z.string(),
    })
  ),
  screenshot: z.string().optional(),
});

export type DesktopView = z.infer<typeof desktopViewSchema>;

export const desktopOpsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({
        ok: z.literal(false),
        error: z.string(),
        heldBy: liveActorSchema.optional(),
      }),
    ])
  ),
  desktop: desktopViewSchema,
});

export type DesktopOpsResponse = z.infer<typeof desktopOpsResponseSchema>;

export const desktopInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    kind: z.enum(["move", "down", "up"]),
    x: screenCoordinateSchema,
    y: screenCoordinateSchema,
    button: z.enum(["left", "right", "middle"]).optional(),
  }),
  z.object({
    type: z.literal("wheel"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().min(1).max(50),
  }),
  z.object({
    type: z.literal("key"),
    keys: z.array(z.string().min(1).max(40)).min(1).max(5),
  }),
  z.object({ type: z.literal("text"), text: z.string().max(2000) }),
  z.object({ type: z.literal("claim") }),
  z.object({ type: z.literal("release") }),
]);

export type DesktopInput = z.infer<typeof desktopInputSchema>;

export const desktopMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("desktop_status"),
    status: desktopStatusSchema,
    streamUrl: z.string().nullable(),
    screen: z.object({ width: z.number(), height: z.number() }),
    controller: liveActorSchema.nullable(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("desktop_denied"), heldBy: liveActorSchema }),
]);

export type DesktopMessage = z.infer<typeof desktopMessageSchema>;

// Every action on a room, by a person or an agent, is named here and checked here (P1). The
// names are also the vocabulary of the event log, so an audit reads the same way the check does.
export const liveActions = [
  "read",
  "write",
  "suggest",
  "comment",
  "restore",
  "drive",
  "agent_ops",
] as const;

export type LiveAction = (typeof liveActions)[number];

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; reason: "wrong_doc" | "forbidden" };

export function authorize(
  claims: LiveTokenClaims,
  docName: string,
  action: LiveAction
): AuthorizeResult {
  if (claims.docName !== docName) {
    return { ok: false, reason: "wrong_doc" };
  }
  const { access, actor } = claims;
  switch (action) {
    case "read":
      return { ok: true };
    case "write":
    case "restore":
    case "drive":
      return access === "write"
        ? { ok: true }
        : { ok: false, reason: "forbidden" };
    case "suggest":
    case "comment":
      return access !== "read"
        ? { ok: true }
        : { ok: false, reason: "forbidden" };
    case "agent_ops":
      return actor.kind === "agent" && access !== "read"
        ? { ok: true }
        : { ok: false, reason: "forbidden" };
  }
}

export function allows(
  claims: LiveTokenClaims,
  docName: string,
  action: LiveAction
): boolean {
  return authorize(claims, docName, action).ok;
}

// Media room (P7). LiveKit carries the audio and video; live-server mints the join token per
// actor and keeps the transcript in the doc, line by line, attributed to the speaker.
export const mediaTokenResponseSchema = z.object({
  url: z.string(),
  token: z.string(),
  identity: z.string(),
  room: z.string(),
  canPublish: z.boolean(),
});

export type MediaTokenResponse = z.infer<typeof mediaTokenResponseSchema>;

// `viewer` tags one tab of a person as its own participant (a shared-browser viewer); without it
// an actor is one participant, as in a call.
export const mediaTokenRequestSchema = z.object({
  viewer: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .optional(),
});

export type MediaTokenRequest = z.infer<typeof mediaTokenRequestSchema>;

export const transcriptLineSchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: liveActorSchema,
  text: z.string(),
  final: z.boolean(),
  cut: z.boolean().optional(),
});

export const transcriptRequestSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(4000),
  final: z.boolean(),
  // false when the host already routes this line itself (AirLink's voice package).
  turn: z.boolean().optional(),
  // The agent was talked over here; the rest of what it meant to say was dropped.
  cut: z.boolean().optional(),
});

export type TranscriptRequest = z.infer<typeof transcriptRequestSchema>;

export const transcriptResponseSchema = z.object({
  room: z.string(),
  startedAt: z.string().nullable(),
  present: z.array(liveActorSchema),
  lines: z.array(transcriptLineSchema),
});

export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export const speakRequestSchema = z.object({
  text: z.string().min(1).max(4000),
});

export const speakResponseSchema = z.object({
  id: z.string(),
  spoken: z.enum(["server", "clients"]),
});

export type SpeakResponse = z.infer<typeof speakResponseSchema>;

// Server → viewers: an agent line to voice on each client when the server has no speech engine,
// and perception signals people's browsers publish (P8).
export const mediaMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("media_speak"),
    id: z.string(),
    actor: liveActorSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal("media_signal"),
    actor: liveActorSchema,
    signal: z.enum(["attention", "gesture", "speaking"]),
    value: z.string(),
    score: z.number().min(0).max(1).optional(),
  }),
]);

export type MediaMessage = z.infer<typeof mediaMessageSchema>;

export const mediaSignalInputSchema = z.object({
  type: z.literal("signal"),
  signal: z.enum(["attention", "gesture", "speaking"]),
  value: z.string().max(40),
  score: z.number().min(0).max(1).optional(),
});

export type MediaSignalInput = z.infer<typeof mediaSignalInputSchema>;

// The person's own tab (P9). The browser extension joins a browser doc with a `via: "extension"`
// token and serves as that room's browser session: it sends frames and the page, answers read
// requests on its own, and runs an agent's click, type or navigate only after the person
// approves it in the sidebar.
export const outlineLineSchema = z.object({
  ref: z.string().nullable(),
  role: z.string(),
  text: z.string(),
  value: z.string().nullable(),
  level: z.number().nullable(),
  checked: z.boolean().nullable(),
  backendNodeId: z.number().nullable(),
});

export const outlineSchema = z.object({
  lines: z.array(outlineLineSchema).max(400),
  refs: z.record(z.string(), z.number()),
});

export const extensionRequestSchema = z.object({
  type: z.literal("ext_request"),
  id: z.string(),
  actor: liveActorSchema,
  request: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("read") }),
    z.object({ kind: z.literal("page") }),
    z.object({ kind: z.literal("navigate"), url: z.string().max(2000) }),
    z.object({ kind: z.literal("back") }),
    z.object({ kind: z.literal("forward") }),
    z.object({ kind: z.literal("reload") }),
    z.object({ kind: z.literal("click"), ref: z.string() }),
    z.object({
      kind: z.literal("type"),
      ref: z.string(),
      text: z.string().max(2000),
      submit: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("press"), key: z.string().max(40) }),
  ]),
});

export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;

export const extensionMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ext_frame"),
    data: z.string(),
    width: z.number(),
    height: z.number(),
  }),
  z.object({ type: z.literal("ext_page"), url: z.string(), title: z.string() }),
  z.object({
    type: z.literal("ext_response"),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    outline: outlineSchema.optional(),
    page: z.object({ url: z.string(), title: z.string() }).optional(),
  }),
]);

export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;
