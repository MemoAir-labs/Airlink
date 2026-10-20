import type { LiveAgentClient } from "@memo-air/agent";
import type {
  BrowserOpsResponse,
  BrowserPage,
  CanvasReadResponse,
  DeckReadResponse,
  DesktopOpsResponse,
  DesktopView,
  LiveAccess,
  OutlineResponse,
  RichTextOp,
  SheetOp,
  SheetReadResponse,
  SlidesOp,
  TranscriptResponse,
} from "@memo-air/protocol";
import { formatValue } from "@memo-air/sheet";
import { z } from "zod";

const docIdSchema = z
  .string()
  .describe(
    "The live doc id (starts with ldoc_), from create_live_doc or the card."
  );

export const liveDocOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("insert"),
    after_block_id: z
      .string()
      .nullable()
      .describe(
        "Block id to insert after; null inserts at the top of the doc."
      ),
    markdown: z
      .string()
      .describe(
        "Content to insert: headings, paragraphs, lists, quotes, code."
      ),
  }),
  z.object({
    type: z.literal("replace"),
    block_id: z.string().describe("Block id to replace."),
    markdown: z.string().describe("Content that replaces the block."),
  }),
  z.object({
    type: z.literal("delete"),
    block_id: z.string().describe("Block id to delete."),
  }),
]);

const sheetIdSchema = z
  .string()
  .describe(
    "The live sheet id (starts with ldoc_), from create_live_sheet or the card."
  );

const sheetValuesSchema = z
  .array(z.array(z.string()))
  .min(1)
  .describe(
    "Rows of cell inputs, top to bottom. Each input is a label, a plain number ('15000', '12%'), or a formula starting with '=' ('=SUM(B2:B9)'). An empty string clears the cell."
  );

export const liveSheetOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_range"),
    range: z
      .string()
      .describe(
        "A1 address of the top-left cell ('B2'); the values set the size. Cells outside the sheet extend it."
      ),
    values: sheetValuesSchema,
  }),
  z.object({
    type: z.literal("add_rows"),
    after_row: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "Row number the new rows go below; 0 inserts at the top, null appends at the bottom."
      ),
    values: sheetValuesSchema,
  }),
  z.object({
    type: z.literal("delete_rows"),
    from_row: z.number().int().min(1).describe("First row number to delete."),
    to_row: z.number().int().min(1).describe("Last row number to delete."),
  }),
  z.object({
    type: z.literal("format_columns"),
    columns: z.string().describe("Column letter or span, e.g. 'C' or 'C:E'."),
    format: z
      .enum(["text", "number", "currency", "percent", "date"])
      .optional()
      .describe("How the column's numbers display."),
    width: z
      .number()
      .int()
      .min(40)
      .max(800)
      .optional()
      .describe("Column width in pixels."),
  }),
]);

const canvasIdSchema = z
  .string()
  .describe("The live canvas or slides id (starts with ldoc_).");

const shapeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .describe(
    "Short id you choose so later ops can refer to the shape, e.g. 'lead' or 'step_2'."
  );

const colorSchema = z
  .string()
  .regex(/^(#[0-9a-fA-F]{6}|transparent)$/)
  .describe("Hex colour like '#2563eb', or 'transparent'.");

const bulletsSchema = z
  .array(z.string())
  .max(20)
  .describe("Bullet lines, one per item, without the bullet character.");

const slideLayoutSchema = z
  .enum([
    "title",
    "title_bullets",
    "section",
    "two_column",
    "chart_takeaway",
    "image_full",
    "quote",
    "closing",
  ])
  .describe(
    "'title' starts the talk (title + subtitle); 'title_bullets' for most pages (the default); 'section' divides parts; 'two_column' compares (bullets left, right_bullets right); 'chart_takeaway' pairs numbers with the bullets as the takeaway; 'image_full' is a full-bleed image with a title; 'quote' for a customer quote (quote + attribution); 'closing' ends (title + subtitle)."
  );

const chartSchema = z
  .object({
    type: z.enum(["bar", "line", "pie"]),
    labels: z.array(z.string()).min(1).max(24).describe("Category labels."),
    values: z
      .array(z.number())
      .max(24)
      .optional()
      .describe("One value per label, for a single series."),
    series: z
      .array(
        z.object({
          name: z.string(),
          values: z.array(z.number()).min(1).max(24),
        })
      )
      .max(6)
      .optional()
      .describe("Several named series instead of values, to compare."),
  })
  .describe("Data for 'chart_takeaway'; real numbers only.");

const imageSchema = z
  .object({
    url: z.string().describe("https URL of the image."),
    alt: z.string().describe("What the image shows."),
  })
  .describe("Image for 'image_full'.");

const pageContentSchema = {
  title: z.string().optional(),
  subtitle: z.string().optional(),
  bullets: bulletsSchema.optional(),
  right_bullets: bulletsSchema
    .optional()
    .describe("Right-hand column, for 'two_column' only."),
  quote: z.string().optional(),
  attribution: z.string().optional().describe("Who said the quote."),
  chart: chartSchema.optional(),
  image: imageSchema.optional(),
  notes: z.string().optional().describe("Speaker notes: what to say."),
};

const pageSpecSchema = z.object({
  id: shapeIdSchema.optional(),
  layout: slideLayoutSchema.default("title_bullets"),
  ...pageContentSchema,
});

// Edits repeat the page fields; a short layout note keeps the edit tool's search text lean.
const briefLayoutSchema = slideLayoutSchema.describe(
  "Page layout, as listed in create_live_slides."
);

const editPageSpecSchema = z.object({
  id: shapeIdSchema.optional(),
  layout: briefLayoutSchema.default("title_bullets"),
  ...pageContentSchema,
});

const themeSchema = z
  .enum(["studio", "midnight"])
  .describe(
    "'studio' is light and clean; 'midnight' is dark with serif headings."
  );

const shapeSpecSchema = z.object({
  id: shapeIdSchema.optional(),
  type: z
    .enum(["rectangle", "ellipse", "diamond", "text"])
    .describe(
      "rectangle for steps, ellipse for start/end or people, diamond for decisions, text for a free-standing label."
    ),
  x: z
    .number()
    .describe(
      "Left edge in pixels, relative to the page when placed on one (0–1920); leave ~60 px between shapes."
    ),
  y: z
    .number()
    .describe(
      "Top edge in pixels, relative to the page when placed on one (0–1080)."
    ),
  width: z
    .number()
    .min(4)
    .optional()
    .describe("Width in pixels (default 200)."),
  height: z
    .number()
    .min(4)
    .optional()
    .describe("Height in pixels (default 100)."),
  label: z.string().optional().describe("Words shown in the shape."),
  color: colorSchema.optional(),
  fill: colorSchema.optional(),
});

export const liveCanvasOpSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_shapes"),
    shapes: z.array(shapeSpecSchema).min(1).max(100),
  }),
  z.object({
    type: z.literal("connect"),
    arrows: z
      .array(
        z.object({
          id: shapeIdSchema.optional(),
          from: z.string().describe("Shape id the arrow starts at."),
          to: z.string().describe("Shape id the arrow points to."),
          label: z.string().optional().describe("Short text on the arrow."),
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
          id: z.string().describe("Shape id to update."),
          label: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          width: z.number().min(4).optional(),
          height: z.number().min(4).optional(),
          color: colorSchema.optional(),
          fill: colorSchema.optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  z.object({
    type: z.literal("delete_shapes"),
    ids: z
      .array(z.string())
      .min(1)
      .max(100)
      .describe("Shape ids to delete; their labels and arrows go with them."),
  }),
  z.object({
    type: z.literal("add_slides"),
    slides: z.array(editPageSpecSchema).min(1).max(30),
    position: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based position of the first new page; omit to append."),
  }),
  z.object({
    type: z.literal("update_slide"),
    slide: z.string().describe("Page id to update."),
    layout: briefLayoutSchema.optional(),
    ...pageContentSchema,
    hidden: z.boolean().optional().describe("Skip the page when presenting."),
  }),
  z.object({
    type: z.literal("move_slide"),
    slide: z.string().describe("Page id to move."),
    position: z.number().int().min(1).describe("New 1-based position."),
  }),
  z.object({
    type: z.literal("delete_slide"),
    slide: z.string().describe("Page id to delete, with everything on it."),
  }),
  z.object({
    type: z.literal("set_theme"),
    theme: themeSchema.optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("Brand accent, e.g. '#FF6B35'."),
  }),
  z.object({
    type: z.literal("edit_element"),
    element: z.string().describe("Element id from read_live_canvas."),
    text: z.string().optional().describe("New text, as markdown."),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().min(4).optional(),
    h: z.number().min(4).optional(),
    delete: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add_element"),
    slide: z.string().describe("Page id."),
    kind: z.enum(["text", "shape", "table"]),
    x: z.number().describe("Left edge, 0–1920."),
    y: z.number().describe("Top edge, 0–1080."),
    w: z.number().min(4),
    h: z.number().min(4),
    text: z.string().optional().describe("Markdown, for kind 'text'."),
    rows: z
      .array(z.array(z.string()))
      .optional()
      .describe("Table rows, first row the header, for kind 'table'."),
  }),
]);

const browserIdSchema = z
  .string()
  .describe("The live browser id (starts with ldoc_), from open_live_browser.");

const browserRefSchema = z
  .string()
  .regex(/^e\d{1,4}$/)
  .describe(
    "A reference like e3 from the latest read_live_browser or action result."
  );

export const liveBrowserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.string().max(2000).describe("Full https URL to open."),
  }),
  z.object({ type: z.literal("click"), ref: browserRefSchema }),
  z.object({
    type: z.literal("type"),
    ref: browserRefSchema,
    text: z.string().max(2000).describe("Replaces what the field holds."),
    submit: z
      .boolean()
      .optional()
      .describe("Press Enter after typing, e.g. to run a search."),
  }),
  z.object({
    type: z.literal("press"),
    key: z
      .string()
      .max(40)
      .describe("A key such as Enter, Tab, Escape, ArrowDown, or Control+a."),
  }),
  z.object({
    type: z.literal("scroll"),
    dy: z
      .number()
      .min(-10_000)
      .max(10_000)
      .describe("Pixels to scroll; positive is down. 600 is about one screen."),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z
      .number()
      .min(0)
      .max(5000)
      .describe("Milliseconds to let the page settle."),
  }),
]);

const desktopIdSchema = z
  .string()
  .describe("The live desktop id (starts with ldoc_), from open_live_desktop.");

const screenXSchema = z
  .number()
  .min(0)
  .max(10_000)
  .describe(
    "Pixels from the left edge of the screen, from the last screenshot."
  );
const screenYSchema = z
  .number()
  .min(0)
  .max(10_000)
  .describe(
    "Pixels from the top edge of the screen, from the last screenshot."
  );

// A point is a two-number array rather than a tuple: zod writes tuples as draft-07 `items: [...]`,
// which model APIs that validate tool schemas as draft 2020-12 reject.
const screenPointSchema = z.array(z.number().min(0).max(10_000)).length(2);

export const liveDesktopActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), x: screenXSchema, y: screenYSchema }),
  z.object({
    type: z.literal("click"),
    x: screenXSchema,
    y: screenYSchema,
    button: z.enum(["left", "right", "middle"]).optional(),
    count: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe("2 for a double click."),
  }),
  z.object({
    type: z.literal("drag"),
    from: screenPointSchema.describe("[x, y] where the drag starts."),
    to: screenPointSchema.describe("[x, y] where the drag ends."),
  }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Wheel clicks, default 3."),
  }),
  z.object({
    type: z.literal("key"),
    keys: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(5)
      .describe(
        "X key names pressed together, e.g. ['Return'], ['ctrl', 's'], ['alt', 'Tab']."
      ),
  }),
  z.object({
    type: z.literal("type"),
    text: z.string().max(4000).describe("Typed into whatever has focus."),
  }),
  z.object({
    type: z.literal("open"),
    target: z
      .string()
      .max(2000)
      .describe("A URL or file path to open with the default app."),
  }),
  z.object({
    type: z.literal("launch"),
    application: z
      .string()
      .max(200)
      .describe(
        "An installed application: 'xfce4-terminal', 'google-chrome', 'libreoffice', 'gedit' or 'code'."
      ),
    uri: z.string().max(2000).optional().describe("Passed to the application."),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z
      .number()
      .min(0)
      .max(5000)
      .describe("Milliseconds to let the screen settle."),
  }),
]);

const roomIdSchema = z
  .string()
  .describe("The live room id (starts with ldoc_), from open_live_room.");

// One definition per tool, shared by every host: the name an agent calls, the kinds of live
// object it works on, whether it reads, writes, creates or exports, and the words and shape the
// model sees. Hosts add their own fields (Memoair: stake, labels, cost) around these.
export const roomTools = {
  create_live_doc: {
    name: "create_live_doc",
    kinds: ["doc"],
    effect: "create",
    description:
      "Create a live doc that the user and agents co-edit in real time, with a card in this conversation. Returns its id and outline with block ids. If this conversation already has a live doc with the same title, return that doc instead of creating a duplicate. Start with a skeleton (headings, at most one line each), then fill sections with edit_live_doc.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short title shown on the card, e.g. 'Q4 vendor proposal'."),
      markdown: z
        .string()
        .describe(
          "Initial content in Markdown: the skeleton of headings with at most one line under each."
        ),
    },
  },
  get_live_doc_outline: {
    name: "get_live_doc_outline",
    kinds: ["doc"],
    effect: "read",
    description:
      "Get the outline of a live doc: every top-level block with its block id, type and text, plus pending suggestions. Call before editing; block ids are how edits target content.",
    schema: { doc_id: docIdSchema },
  },
  edit_live_doc: {
    name: "edit_live_doc",
    kinds: ["doc"],
    effect: "write",
    description:
      "Edit a live doc with block operations: insert Markdown after a block, replace a block, or delete a block. Edits stream in with your cursor visible to everyone in the doc. Use mode 'suggest' for binding content (prices, terms, dates, commitments, anything another company or a named approver will rely on): suggestions show as underlined or struck-through text and change nothing until a person accepts them. Use mode 'edit' for drafting your own new sections.",
    schema: {
      doc_id: docIdSchema,
      ops: z
        .array(liveDocOpSchema)
        .min(1)
        .max(50)
        .describe("Operations applied in order, as one change."),
      mode: z
        .enum(["edit", "suggest"])
        .describe(
          "'suggest' proposes changes for a person to accept; 'edit' applies them."
        ),
      approver: z
        .string()
        .optional()
        .describe(
          "Email (preferred) or exact full name of the workspace member who must accept; only with mode 'suggest'. The suggestion appears in that person's Home under Needs you. The tool fails if no single member matches; retry with their email."
        ),
    },
  },
  comment_live_doc: {
    name: "comment_live_doc",
    kinds: ["doc"],
    effect: "write",
    description:
      "Add a comment to a live doc: open a comment thread on a block, or reply in an existing thread. Use it to answer a person who mentioned you in a comment, and to leave a review note on text you were not asked to change instead of editing it. get_live_doc_outline lists open threads with their ids.",
    schema: {
      doc_id: docIdSchema,
      block_id: z
        .string()
        .optional()
        .describe("Block id to open a new thread on; omit when replying."),
      quote: z
        .string()
        .max(500)
        .optional()
        .describe("The passage of the block the comment is about."),
      thread_id: z
        .string()
        .optional()
        .describe("Thread id to reply in; omit when opening a thread."),
      body: z.string().min(1).max(4000).describe("The comment text."),
    },
  },
  export_live_doc: {
    name: "export_live_doc",
    kinds: ["doc"],
    effect: "export",
    description:
      "Export a live doc to PDF or docx in this conversation. Export the accepted text: pending insertions are left out and text proposed for deletion is kept.",
    schema: {
      doc_id: docIdSchema,
      format: z.enum(["pdf", "docx"]).describe("File format to export."),
    },
  },
  create_live_sheet: {
    name: "create_live_sheet",
    kinds: ["sheet"],
    effect: "create",
    description:
      "Create a live sheet: a spreadsheet the user and agents edit together in real time, with formulas, shown as a card in this conversation. Use it for numbers across rows and columns, comparisons, budgets, pricing and trackers. Put the header row first, then the first rows of data; fill the rest with edit_live_sheet. If this conversation already has a live sheet with the same title, return that sheet instead of creating a duplicate.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Short title shown on the card, e.g. 'Vendor price comparison'."
        ),
      values: sheetValuesSchema,
    },
  },
  read_live_sheet: {
    name: "read_live_sheet",
    kinds: ["sheet"],
    effect: "read",
    description:
      "Read a live sheet: each cell's A1 address, its input (the formula, if any) and its computed value, plus the column formats and pending suggestions. Cells a person wrote are marked with their name. Call it before editing so your ranges target the right cells; people may have added or moved rows since you last looked.",
    schema: {
      doc_id: sheetIdSchema,
      range: z
        .string()
        .optional()
        .describe(
          "A1 range to read, e.g. 'A1:F40'. Omit to read the whole sheet (up to 500 rows)."
        ),
    },
  },
  edit_live_sheet: {
    name: "edit_live_sheet",
    kinds: ["sheet"],
    effect: "write",
    description:
      "Edit a live sheet with range operations: set cell values or formulas, insert rows, delete rows, or format columns. Rows stream in with your cursor visible to everyone in the sheet. Enter totals, differences and ratios as formulas, not as numbers you computed. Use mode 'suggest' for binding figures (prices, quantities, dates, terms, anything another company or a named approver will rely on): suggested cells show the proposed value beside the current one and change nothing until a person accepts. Use mode 'edit' for your own new rows and columns. An edit that would change or remove a cell a person wrote becomes a suggestion for them automatically.",
    schema: {
      doc_id: sheetIdSchema,
      ops: z
        .array(liveSheetOpSchema)
        .min(1)
        .max(50)
        .describe("Operations applied in order, as one change."),
      mode: z
        .enum(["edit", "suggest"])
        .describe(
          "'suggest' proposes changes for a person to accept; 'edit' applies them."
        ),
      approver: z
        .string()
        .optional()
        .describe(
          "Email (preferred) or exact full name of the workspace member who must accept; only with mode 'suggest'. The suggestion appears in that person's Home under Needs you. The tool fails if no single member matches; retry with their email."
        ),
    },
  },
  export_live_sheet: {
    name: "export_live_sheet",
    kinds: ["sheet"],
    effect: "export",
    description:
      "Export a live sheet to an Excel (xlsx) file in this conversation, keeping its formulas and column formats. Export the accepted values: pending suggestions are not included.",
    schema: { doc_id: sheetIdSchema },
  },
  create_live_canvas: {
    name: "create_live_canvas",
    kinds: ["canvas"],
    effect: "create",
    description:
      "Create a live canvas: a whiteboard the user and agents draw on together in real time, shown as a card in this conversation. Use it for flowcharts, processes, org charts, architecture diagrams and timelines. Lay out the main boxes first so the user sees the layout within a second, then fill in the rest with edit_live_canvas. If this conversation already has a live canvas with the same title, return that canvas instead of creating a duplicate.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Short title shown on the card, e.g. 'Lead-to-cash flow'."),
      shapes: z
        .array(shapeSpecSchema)
        .min(1)
        .max(100)
        .describe(
          "First boxes, each with an id. Space them ~260 px apart in a row or column."
        ),
    },
  },
  create_live_slides: {
    name: "create_live_slides",
    kinds: ["slides"],
    effect: "create",
    description:
      "Create live slides: a presentation the user and agents edit together in real time, shown as a card in this conversation. Use it when the user wants to present, pitch or walk someone through something. Choose a layout for each page and fill its slots (title, subtitle, bullets, chart, quote, image); the theme handles fonts, colours and placement, so never position text yourself. One idea per page, at most five short bullets, and what to say in notes. If this conversation already has live slides with the same title, return them instead of creating a duplicate.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .describe("Title shown on the card, e.g. 'Acme pilot proposal'."),
      slides: z.array(pageSpecSchema).min(1).max(30),
      theme: themeSchema.optional(),
    },
  },
  read_live_canvas: {
    name: "read_live_canvas",
    kinds: ["canvas", "slides"],
    effect: "read",
    description:
      "Read a live canvas or live slides. For a canvas: every shape with its id, type, position, size and label, and the arrows between them. For live slides: the theme and each page's layout, elements with their ids and text, and notes. Both include pending suggestions, and mark what a person last changed with their name. Call it before editing; people may have moved, renamed or deleted things since you last looked.",
    schema: { doc_id: canvasIdSchema },
  },
  edit_live_canvas: {
    name: "edit_live_canvas",
    kinds: ["canvas", "slides"],
    effect: "write",
    description:
      "Edit a live canvas or live slides. On a canvas: add a shape, connect shapes with an arrow, relabel, recolour, move or resize a shape, delete shapes. On live slides: add, update, move or delete pages by filling layout slots, switch the theme, or adjust one element by its id. Edits appear one at a time with your pointer visible to everyone. Refer to ids from read_live_canvas or your earlier ops. Use mode 'suggest' for binding content (prices, dates, commitments, anything another company or a named approver will rely on): suggested edits stay pending until a person accepts. Use mode 'edit' for your own new content. An edit to something a person made becomes a suggestion for them automatically.",
    schema: {
      doc_id: canvasIdSchema,
      ops: z
        .array(liveCanvasOpSchema)
        .min(1)
        .max(50)
        .describe("Operations applied in order, as one change."),
      mode: z
        .enum(["edit", "suggest"])
        .describe(
          "'suggest' proposes changes for a person to accept; 'edit' applies them."
        ),
      approver: z
        .string()
        .optional()
        .describe(
          "Email (preferred) or exact full name of the workspace member who must accept; only with mode 'suggest'. The suggestion appears in that person's Home under Needs you. The tool fails if no single member matches; retry with their email."
        ),
    },
  },
  export_live_slides: {
    name: "export_live_slides",
    kinds: ["slides"],
    effect: "export",
    description:
      "Export live slides to a PowerPoint (pptx) file in this conversation, with speaker notes. Pending suggestions are not included.",
    schema: {
      doc_id: z.string().describe("The live slides id (starts with ldoc_)."),
    },
  },
  open_live_browser: {
    name: "open_live_browser",
    kinds: ["browser"],
    effect: "create",
    description:
      "Open a shared live browser: a web page the user and agents see and drive together in real time, shown as a card in this conversation. Use it when a task needs a real website with clicks and typing: filling a form, checking an account, walking the user through a site, or a page the web browse tool returns empty. Give the page URL; the tool opens it and returns the page outline with a numbered reference (e1, e2…) for every link, button and field. If this conversation already has a live browser, the tool takes it to the URL instead of opening a second one.",
    schema: {
      url: z.string().max(2000).describe("Full https URL of the page to open."),
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Short title for the card, e.g. 'Vendor portal'. Defaults to the page title."
        ),
    },
  },
  read_live_browser: {
    name: "read_live_browser",
    kinds: ["browser"],
    effect: "read",
    description:
      "Read the page open in the shared live browser: its URL, title, who is driving, and an outline with a numbered reference (e1, e2…) for every link, button, field and checkbox, plus the visible text. Read before you act: people navigate and type in the same browser, so references from an earlier read may no longer exist.",
    schema: { doc_id: browserIdSchema },
  },
  act_live_browser: {
    name: "act_live_browser",
    kinds: ["browser"],
    effect: "write",
    description:
      "Act on the page in the shared live browser: navigate to a URL, click a reference, type into a field (optionally pressing Enter), press a key, scroll, or wait. Actions run in order and stop at the first failure. The result is the page afterwards, with fresh references and what changed, so read it before the next action. Everyone watching sees your pointer move. If a person is driving the browser the action fails with their name: stop, say what you were about to do, and wait instead of retrying. Never type a password, card number or one-time code the user did not hand you in this conversation.",
    schema: {
      doc_id: browserIdSchema,
      actions: z
        .array(liveBrowserActionSchema)
        .min(1)
        .max(20)
        .describe("Actions applied in order; one step of the task at a time."),
    },
  },
  open_live_desktop: {
    name: "open_live_desktop",
    kinds: ["desktop"],
    effect: "create",
    description:
      "Open a shared live desktop: a full computer with a screen, keyboard and mouse that the user and agents see and drive together, shown as a card in this conversation. Use it when a task needs software rather than a web page: a desktop application, a file to edit in an installed app, a terminal, or anything that will not run inside one browser tab. It takes about ten seconds to start. Optionally launch an application or open a URL or file right away. If this conversation already has a live desktop, the tool reuses it.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Short title for the card, e.g. 'Invoice fix in LibreOffice'."
        ),
      application: z
        .string()
        .max(200)
        .optional()
        .describe(
          "An installed application to launch first: 'xfce4-terminal', 'google-chrome', 'libreoffice', 'gedit' or 'code'."
        ),
      target: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "A URL or file path to open with the default app instead of launching one."
        ),
    },
  },
  read_live_desktop: {
    name: "read_live_desktop",
    kinds: ["desktop"],
    effect: "read",
    description:
      "Look at the shared live desktop: a screenshot of the screen as it is now, the screen size, who is driving, and the last actions taken on it with who took them. Look before you act: people use the same desktop, so coordinates from an earlier screenshot may point at something else now.",
    schema: { doc_id: desktopIdSchema },
  },
  act_live_desktop: {
    name: "act_live_desktop",
    kinds: ["desktop"],
    effect: "write",
    description:
      "Act on the shared live desktop with the mouse and keyboard: move, click or double-click at screen coordinates, drag, scroll, press keys, type text, open a URL or file, launch an application, or wait. Actions run in order and stop at the first failure. The result is a fresh screenshot, so look at it before the next step. Everyone watching sees your pointer. If a person is driving the desktop the action fails with their name: stop, say what you were about to do, and wait instead of retrying. Never type a password, card number or one-time code the user did not hand you in this conversation.",
    schema: {
      doc_id: desktopIdSchema,
      actions: z
        .array(liveDesktopActionSchema)
        .min(1)
        .max(20)
        .describe("Actions applied in order; one step of the task at a time."),
    },
  },
  open_live_room: {
    name: "open_live_room",
    kinds: ["media"],
    effect: "create",
    description:
      "Open a live room: voice and video for the people in this conversation and their agents, with a shared transcript, shown as a card. Use it when people want to talk instead of type: a call, a huddle, a walkthrough, a meeting with an agent listening in. You join as a participant and can speak. If this conversation already has a live room, the tool returns it.",
    schema: {
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Short title for the card, e.g. 'Pricing huddle'."),
    },
  },
  read_live_room: {
    name: "read_live_room",
    kinds: ["media"],
    effect: "read",
    description:
      "Read the live room's transcript: who has joined and what each person and agent has said, newest last. Call it to catch up before speaking, and again after you speak to hear the reply; people's lines arrive as they talk.",
    schema: { doc_id: roomIdSchema },
  },
  speak_in_live_room: {
    name: "speak_in_live_room",
    kinds: ["media"],
    effect: "write",
    description:
      "Speak in the live room: your words are voiced to everyone there and written into the transcript under your name. Keep it to one or two spoken sentences; people cannot skim speech. Do not repeat what you just said in chat.",
    schema: {
      doc_id: roomIdSchema,
      text: z
        .string()
        .min(1)
        .max(1000)
        .describe("What to say, as you would say it aloud."),
    },
  },
} as const;

export type RoomToolName = keyof typeof roomTools;
export type RoomToolArgs<N extends RoomToolName> = z.infer<
  z.ZodObject<(typeof roomTools)[N]["schema"]>
>;

// Creates and exports touch the host's own records (which conversation or channel an object
// belongs to, where a file goes), so each host runs them; everything else is the same call to
// live-server whoever hosts the room.
export type RunnableToolName = {
  [N in RoomToolName]: (typeof roomTools)[N]["effect"] extends "read" | "write"
    ? N
    : never;
}[RoomToolName];

export type RoomToolCall = {
  [N in RunnableToolName]: { name: N; args: RoomToolArgs<N> };
}[RunnableToolName];

// A model's tool call arrives as a name and untyped arguments; this is the one place they become
// a typed call, so every host validates them the same way.
function parseWith<N extends RoomToolName, S extends z.ZodRawShape>(
  name: N,
  shape: S
) {
  return (args: unknown) => {
    const parsed = z.object(shape).safeParse(args);
    return parsed.success
      ? { name, args: parsed.data }
      : parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.join(".") || "arguments"}: ${issue.message}`
          )
          .join("; ");
  };
}

const callParsers: {
  [N in RunnableToolName]: (args: unknown) => RoomToolCall | string;
} = {
  get_live_doc_outline: parseWith(
    "get_live_doc_outline",
    roomTools.get_live_doc_outline.schema
  ),
  edit_live_doc: parseWith("edit_live_doc", roomTools.edit_live_doc.schema),
  comment_live_doc: parseWith(
    "comment_live_doc",
    roomTools.comment_live_doc.schema
  ),
  read_live_sheet: parseWith(
    "read_live_sheet",
    roomTools.read_live_sheet.schema
  ),
  edit_live_sheet: parseWith(
    "edit_live_sheet",
    roomTools.edit_live_sheet.schema
  ),
  read_live_canvas: parseWith(
    "read_live_canvas",
    roomTools.read_live_canvas.schema
  ),
  edit_live_canvas: parseWith(
    "edit_live_canvas",
    roomTools.edit_live_canvas.schema
  ),
  read_live_browser: parseWith(
    "read_live_browser",
    roomTools.read_live_browser.schema
  ),
  act_live_browser: parseWith(
    "act_live_browser",
    roomTools.act_live_browser.schema
  ),
  read_live_desktop: parseWith(
    "read_live_desktop",
    roomTools.read_live_desktop.schema
  ),
  act_live_desktop: parseWith(
    "act_live_desktop",
    roomTools.act_live_desktop.schema
  ),
  read_live_room: parseWith("read_live_room", roomTools.read_live_room.schema),
  speak_in_live_room: parseWith(
    "speak_in_live_room",
    roomTools.speak_in_live_room.schema
  ),
};

export const isRunnableToolName = (name: string): name is RunnableToolName =>
  Object.hasOwn(callParsers, name);

export function parseRoomToolCall(
  name: RunnableToolName,
  args: unknown
): { ok: true; call: RoomToolCall } | { ok: false; error: string } {
  const call = callParsers[name](args);
  return typeof call === "string"
    ? { ok: false, error: call }
    : { ok: true, call };
}

export type RoomObject = { id: string; title: string; kind: string };

export type RoomToolResult =
  | { ok: true; text: string; desktop?: DesktopView }
  | { ok: false; error: string; cause: "input" | "service" };

type LiveSheetToolOp = z.infer<typeof liveSheetOpSchema>;
type LiveCanvasToolOp = z.infer<typeof liveCanvasOpSchema>;

type CanvasShapeToolOp = Extract<
  LiveCanvasToolOp,
  { type: "add_shapes" | "connect" | "update_shapes" | "delete_shapes" }
>;
type PageContent = Omit<
  Extract<LiveCanvasToolOp, { type: "update_slide" }>,
  "type" | "slide" | "layout" | "hidden"
>;

const blockTextPreviewChars = 200;

function isShapeOp(op: LiveCanvasToolOp): op is CanvasShapeToolOp {
  return (
    op.type === "add_shapes" ||
    op.type === "connect" ||
    op.type === "update_shapes" ||
    op.type === "delete_shapes"
  );
}

// Tool fields are snake_case the way agents write them; live-server's are camelCase.
function toDeckContent({ right_bullets, chart, ...page }: PageContent) {
  return {
    ...page,
    rightBullets: right_bullets,
    chart: chart && {
      chart: chart.type,
      labels: chart.labels,
      series: chart.series ?? [{ name: "", values: chart.values ?? [] }],
    },
  };
}

export function toSlidesOps(op: LiveCanvasToolOp): SlidesOp[] {
  switch (op.type) {
    case "add_slides":
      return op.slides.map(({ id, layout, ...page }, i) => ({
        type: "add_slide",
        id,
        layout,
        ...(op.position ? { position: op.position + i } : {}),
        ...toDeckContent(page),
      }));
    case "update_slide": {
      const { type: _type, slide, layout, hidden, ...page } = op;
      return [
        { type: "update_slide", slide, layout, hidden, ...toDeckContent(page) },
      ];
    }
    case "move_slide":
    case "delete_slide":
      return [op];
    case "set_theme":
      return [
        {
          type: "set_theme",
          themeId: op.theme,
          ...(op.accent ? { overrides: { accent: op.accent } } : {}),
        },
      ];
    case "edit_element":
      return [{ ...op, type: "edit_element" }];
    case "add_element":
      return [
        {
          type: "add_element",
          slide: op.slide,
          kind: op.kind,
          x: op.x,
          y: op.y,
          w: op.w,
          h: op.h,
          text: op.text,
          ...(op.kind === "table" && op.rows
            ? { data: { rows: op.rows, header: true } }
            : {}),
          ...(op.kind === "shape"
            ? {
                data: { shape: "rect" },
                style: { fill: "surface", radius: 16 },
              }
            : {}),
        },
      ];
    case "add_shapes":
    case "connect":
    case "update_shapes":
    case "delete_shapes":
      return [];
  }
}

export function toSheetOp(op: LiveSheetToolOp): SheetOp {
  switch (op.type) {
    case "set_range":
      return { type: "set_range", range: op.range, values: op.values };
    case "add_rows":
      return { type: "add_rows", afterRow: op.after_row, values: op.values };
    case "delete_rows":
      return { type: "delete_rows", fromRow: op.from_row, toRow: op.to_row };
    case "format_columns":
      return {
        type: "format_columns",
        columns: op.columns,
        format: op.format,
        width: op.width,
      };
  }
}

export function formatOutline({
  blocks,
  suggestions,
  threads,
}: OutlineResponse): string {
  const lines = blocks.map((block) => {
    const text =
      block.text.length > blockTextPreviewChars
        ? `${block.text.slice(0, blockTextPreviewChars)}…`
        : block.text;
    const pending = block.suggestion
      ? ` (suggested ${block.suggestion.kind} by ${block.suggestion.actorName})`
      : "";
    return `[${block.blockId}] ${block.type}${pending}: ${text}`;
  });
  const review = suggestions.length
    ? `\n\n${suggestions.length} suggestion(s) await a person's review.`
    : "";
  const comments = threads.length
    ? `\n\nOpen comment threads:\n${threads
        .map(
          (thread) =>
            `[thread ${thread.id}] on ${thread.detached ? "a deleted block" : `[${thread.blockId}]`}${thread.quote ? ` "${thread.quote}"` : ""}: ${thread.messages
              .map((message) => `${message.actor.name}: ${message.body}`)
              .join(" / ")}`
        )
        .join("\n")}`
    : "";
  return `${lines.join("\n")}${review}${comments}`;
}

export function formatBrowserPage(page: BrowserPage): string {
  const driver = page.controller
    ? page.controller.kind === "human"
      ? `${page.controller.name} is driving the browser.`
      : `${page.controller.name} is driving.`
    : "Nobody is driving right now.";
  const changed = page.changed
    ? [
        page.changed.added.length
          ? `Appeared: ${page.changed.added.slice(0, 20).join("; ")}`
          : "",
        page.changed.removed.length
          ? `Gone: ${page.changed.removed.slice(0, 20).join("; ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return `Page: ${page.title || "(untitled)"} — ${page.url}\n${driver}${changed ? `\n${changed}` : ""}\n\n${page.outline || "(the page has no readable content yet)"}`;
}

export function formatActionResults(
  results: BrowserOpsResponse["results"] | DesktopOpsResponse["results"],
  actions: { type: string }[]
): string {
  return results
    .map((result, i) =>
      result.ok
        ? `${i + 1}. ${actions[i].type}: ok`
        : `${i + 1}. ${actions[i].type}: failed, ${result.error}`
    )
    .join("\n");
}

export function formatDesktop(view: DesktopView): string {
  const driver = view.controller
    ? `${view.controller.name} is driving.`
    : "Nobody is driving right now.";
  const actions = view.actions.length
    ? `\nLast actions:\n${view.actions
        .slice(-10)
        .map((a) => `- ${a.actor.name}: ${a.action} ${a.detail}`)
        .join("\n")}`
    : "";
  return `Desktop ${view.status}, screen ${view.screen.width}×${view.screen.height}${view.app ? `, last opened: ${view.app}` : ""}. ${driver}${view.cursor ? ` Pointer at ${view.cursor.x},${view.cursor.y}.` : ""}${actions}`;
}

export function formatTranscript(view: TranscriptResponse): string {
  const present = view.present.length
    ? `In the room now: ${view.present.map((a) => (a.kind === "agent" ? `✦ ${a.name}` : a.name)).join(", ")}.`
    : "Nobody has the room open right now.";
  const lines = view.lines.length
    ? view.lines
        .slice(-40)
        .map(
          (line) =>
            `[${line.at.slice(11, 16)}] ${line.actor.kind === "agent" ? "✦ " : ""}${line.actor.name}: ${line.text}${line.final ? "" : " …"}`
        )
        .join("\n")
    : "(nothing said yet)";
  return `${present}\n\n${lines}`;
}

export function formatSheet(
  object: RoomObject,
  { range, rowCount, colCount, columns, rows, suggestions }: SheetReadResponse
): string {
  const formats = columns
    .filter((column) => column.format)
    .map((column) => `${column.column} ${column.format}`);
  const lines = rows.map(
    ({ row, cells }) =>
      `${row}: ${cells
        .filter((cell) => cell.input !== "")
        .map((cell) => {
          const shown = formatValue(cell.value);
          const by =
            cell.editor?.kind === "human" ? ` (by ${cell.editor.name})` : "";
          return cell.input.startsWith("=")
            ? `${cell.cell} ${cell.input} → ${shown}${by}`
            : `${cell.cell} ${shown}${by}`;
        })
        .join(" | ")}`
  );
  const review = suggestions.length
    ? `\n\nPending suggestions (a person accepts or rejects them):\n${suggestions
        .map(
          (s) =>
            `[${s.id}] by ${s.actorName}${s.approver ? ` for ${s.approver}` : ""}${s.stale ? " (cells changed since)" : ""}: ${[
              ...s.cells.map(
                (c) =>
                  `${c.cell} ${c.before || "(empty)"} → ${c.after || "(empty)"}`
              ),
              ...(s.insertRows ? [`insert ${s.insertRows} row(s)`] : []),
              ...(s.deleteRows ? [`delete ${s.deleteRows} row(s)`] : []),
            ].join(", ")}`
        )
        .join("\n")}`
    : "";
  return `Live sheet "${object.title}" (${object.id}): ${rowCount} rows × ${colCount} columns${range ? `, showing ${range}` : ", empty"}.${formats.length ? ` Column formats: ${formats.join(", ")}.` : ""}\n\n${lines.join("\n")}${review}`;
}

function formatShape(shape: CanvasReadResponse["shapes"][number]): string {
  const by = shape.by ? ` (by ${shape.by})` : "";
  return `[${shape.id}] ${shape.type} at (${shape.x}, ${shape.y}) ${shape.width}×${shape.height}${shape.label ? `: ${shape.label}` : ""}${by}`;
}

function formatConnection(
  connection: CanvasReadResponse["connections"][number]
): string {
  return `[${connection.id}] ${connection.from} → ${connection.to}${connection.label ? `: ${connection.label}` : ""}`;
}

function formatCanvas(
  object: RoomObject,
  { shapes, connections, suggestions }: CanvasReadResponse
): string {
  const review = suggestions.length
    ? `\n\nPending suggestions (a person accepts or rejects them):\n${suggestions
        .map(
          (s) =>
            `[${s.id}] by ${s.actorName}${s.approver ? ` for ${s.approver}` : ""}${s.stale ? " (shapes changed since)" : ""}: ${s.changes
              .map((c) => `${c.kind} ${c.id} "${c.label}"`)
              .join(", ")}`
        )
        .join("\n")}`
    : "";
  const lines = [
    ...shapes.map(formatShape),
    ...(connections.length
      ? ["", "Arrows:", ...connections.map(formatConnection)]
      : []),
  ];
  return `Live canvas "${object.title}" (${object.id}): ${shapes.length} shape(s).\n\n${lines.join("\n")}${review}`;
}

function formatDeck(object: RoomObject, deck: DeckReadResponse): string {
  const pages = deck.slides.map((slide) => {
    const elements = slide.elements
      .filter(
        (element) => element.slot !== "accent" && element.slot !== "scrim"
      )
      .map((element) => {
        const name = element.slot ?? element.kind;
        const by = element.by ? ` (by ${element.by})` : "";
        const body =
          element.text !== null
            ? element.text.replace(/\n/g, " / ")
            : JSON.stringify(element.data);
        return `  [${element.id}] ${name}: ${body}${by}`;
      });
    return [
      `Page ${slide.number} [${slide.id}] ${slide.layout}${slide.hidden ? " (hidden)" : ""}: ${slide.title}`,
      ...elements,
      ...(slide.notes ? [`  notes: ${slide.notes}`] : []),
    ].join("\n");
  });
  const review = deck.suggestions.length
    ? `\n\nPending suggestions (a person accepts or rejects them):\n${deck.suggestions
        .map(
          (s) =>
            `[${s.id}] by ${s.actorName}${s.approver ? ` for ${s.approver}` : ""}${s.stale ? " (changed since)" : ""}: ${s.lines
              .map((line) => `${line.kind} ${line.label}`)
              .join(", ")}`
        )
        .join("\n")}`
    : "";
  return `Live slides "${object.title}" (${object.id}): ${deck.slides.length} page(s), theme ${deck.theme.name} (${deck.theme.mode}).\n\n${pages.join("\n\n")}${review}`;
}

export async function readCanvasText(
  object: RoomObject,
  client: LiveAgentClient
): Promise<string> {
  return object.kind === "slides"
    ? formatDeck(object, await client.readDeck())
    : formatCanvas(object, await client.readCanvas());
}

// The token a host mints for a call: reads never write, a comment is never binding, and an edit
// in suggest mode can only propose.
export function roomToolAccess(call: RoomToolCall): LiveAccess {
  switch (call.name) {
    case "get_live_doc_outline":
    case "read_live_sheet":
    case "read_live_canvas":
    case "read_live_browser":
    case "read_live_desktop":
    case "read_live_room":
      return "read";
    case "comment_live_doc":
      return "suggest";
    case "edit_live_doc":
    case "edit_live_sheet":
    case "edit_live_canvas":
      return call.args.mode === "suggest" ? "suggest" : "write";
    case "act_live_browser":
    case "act_live_desktop":
    case "speak_in_live_room":
      return "write";
  }
}

const inputError = (error: string): RoomToolResult => ({
  ok: false,
  error,
  cause: "input",
});

export type Approver = { id: string; name: string };

export async function runRoomTool(
  client: LiveAgentClient,
  call: RoomToolCall,
  object: RoomObject,
  { approver }: { approver?: Approver } = {}
): Promise<RoomToolResult> {
  const suggestionLine = (suggestionId: string | null | undefined) =>
    suggestionId
      ? `\nThe changes are a suggestion (${suggestionId}) waiting for ${approver?.name ?? "a person"} to accept.`
      : "";
  const review = {
    approver: approver?.name,
    approverId: approver?.id,
  };
  try {
    switch (call.name) {
      case "get_live_doc_outline":
        return {
          ok: true,
          text: `Live doc "${object.title}" (${object.id}):\n\n${formatOutline(await client.outline())}`,
        };

      case "edit_live_doc": {
        const { ops, mode } = call.args;
        const liveOps: RichTextOp[] = ops.map((op) => {
          switch (op.type) {
            case "insert":
              return {
                type: "insert",
                afterBlockId: op.after_block_id,
                markdown: op.markdown,
              };
            case "replace":
              return {
                type: "replace",
                blockId: op.block_id,
                markdown: op.markdown,
              };
            case "delete":
              return { type: "delete", blockId: op.block_id };
          }
        });
        const response = await client.ops({ ops: liveOps, mode, ...review });
        const outline = await client.outline();
        const results = response.results
          .map((result, i) =>
            result.ok
              ? `${i + 1}. ${ops[i].type}: ok${result.blockIds.length ? ` (new blocks ${result.blockIds.join(", ")})` : ""}`
              : `${i + 1}. ${ops[i].type}: failed, ${result.error}`
          )
          .join("\n");
        return {
          ok: true,
          text: `${results}${suggestionLine(response.suggestionId)}\n\n${formatOutline(outline)}`,
        };
      }

      case "comment_live_doc": {
        const { thread_id, block_id, quote, body } = call.args;
        if (!thread_id && !block_id) {
          return inputError(
            "Pass block_id to open a thread or thread_id to reply."
          );
        }
        const { threadId } = await client.comment(
          thread_id
            ? { threadId: thread_id, body }
            : { blockId: block_id ?? "", quote, body }
        );
        return {
          ok: true,
          text: `${thread_id ? "Replied in" : "Opened"} comment thread ${threadId} on "${object.title}".`,
        };
      }

      case "read_live_sheet":
        return {
          ok: true,
          text: formatSheet(object, await client.readSheet(call.args.range)),
        };

      case "edit_live_sheet": {
        const { ops, mode } = call.args;
        const response = await client.sheetOps({
          ops: ops.map(toSheetOp),
          mode,
          ...review,
        });
        const sheet = await client.readSheet();
        const results = response.results
          .map((result, i) =>
            result.ok
              ? result.suggested
                ? `${i + 1}. ${ops[i].type}: suggested instead of applied (${result.range}), because a person wrote ${(result.humanCells ?? []).join(", ")}`
                : `${i + 1}. ${ops[i].type}: ok (${result.range})`
              : `${i + 1}. ${ops[i].type}: failed, ${result.error}`
          )
          .join("\n");
        return {
          ok: true,
          text: `${results}${suggestionLine(response.suggestionId)}\n\n${formatSheet(object, sheet)}`,
        };
      }

      case "read_live_canvas":
        return { ok: true, text: await readCanvasText(object, client) };

      case "edit_live_canvas": {
        const { ops, mode } = call.args;
        const isSlides = object.kind === "slides";
        const misplaced = ops.filter((op) => isShapeOp(op) === isSlides);
        if (misplaced.length > 0) {
          return inputError(
            isSlides
              ? `${object.id} is live slides; use page ops (add_slides, update_slide, move_slide, delete_slide, set_theme, edit_element, add_element), not ${misplaced[0].type}.`
              : `${object.id} is a live canvas; use shape ops (add_shapes, connect, update_shapes, delete_shapes), not ${misplaced[0].type}.`
          );
        }
        const response = isSlides
          ? await client.slidesOps({
              mode,
              ...review,
              ops: ops.flatMap(toSlidesOps),
            })
          : await client.canvasOps({
              mode,
              ...review,
              ops: ops.filter(isShapeOp),
            });
        const view = await readCanvasText(object, client);
        const results = response.results
          .map((result, i) => {
            if (!result.ok) {
              return `${i + 1}. failed, ${result.error}`;
            }
            const human =
              "humanElements" in result
                ? result.humanElements
                : "humanShapes" in result
                  ? result.humanShapes
                  : undefined;
            return result.suggested
              ? `${i + 1}. suggested instead of applied, because a person wrote ${(human ?? []).join(", ")}`
              : `${i + 1}. ok (${result.ids.join(", ")})`;
          })
          .join("\n");
        return {
          ok: true,
          text: `${results}${suggestionLine(response.suggestionId)}\n\n${view}`,
        };
      }

      case "read_live_browser":
        return {
          ok: true,
          text: formatBrowserPage(await client.readBrowser()),
        };

      case "act_live_browser": {
        const { actions } = call.args;
        const acted = await client.browserOps({ ops: actions });
        return {
          ok: true,
          text: `${formatActionResults(acted.results, actions)}\n\n${formatBrowserPage(acted.page)}`,
        };
      }

      case "read_live_desktop": {
        const desktop = await client.readDesktop({ screenshot: true });
        return { ok: true, text: formatDesktop(desktop), desktop };
      }

      case "act_live_desktop": {
        const { actions } = call.args;
        const acted = await client.desktopOps({
          ops: actions.map((action) =>
            action.type === "drag"
              ? {
                  ...action,
                  from: [action.from[0], action.from[1]],
                  to: [action.to[0], action.to[1]],
                }
              : action
          ),
        });
        return {
          ok: true,
          text: `${formatActionResults(acted.results, actions)}\n\n${formatDesktop(acted.desktop)}`,
          desktop: acted.desktop,
        };
      }

      case "read_live_room":
        return { ok: true, text: formatTranscript(await client.transcript()) };

      case "speak_in_live_room": {
        const spoke = await client.speak(call.args.text);
        const how =
          spoke.spoken === "server"
            ? "spoken into the room"
            : "voiced on each person's device and written to the transcript";
        return { ok: true, text: `Said "${call.args.text}" (${how}).` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `The live doc service failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: "service",
    };
  }
}

// Creates are split between the host and here. The host owns the record: which channel or
// conversation the object joins, whether one already exists, where it is placed. What the new
// object starts with and what the agent is told back are the same in every host.
export type CreateToolName = {
  [N in RoomToolName]: (typeof roomTools)[N]["effect"] extends "create"
    ? N
    : never;
}[RoomToolName];

const createParsers: {
  [N in CreateToolName]: (args: unknown) => CreateToolCall | string;
} = {
  create_live_doc: parseWith(
    "create_live_doc",
    roomTools.create_live_doc.schema
  ),
  create_live_sheet: parseWith(
    "create_live_sheet",
    roomTools.create_live_sheet.schema
  ),
  create_live_canvas: parseWith(
    "create_live_canvas",
    roomTools.create_live_canvas.schema
  ),
  create_live_slides: parseWith(
    "create_live_slides",
    roomTools.create_live_slides.schema
  ),
  open_live_browser: parseWith(
    "open_live_browser",
    roomTools.open_live_browser.schema
  ),
  open_live_desktop: parseWith(
    "open_live_desktop",
    roomTools.open_live_desktop.schema
  ),
  open_live_room: parseWith("open_live_room", roomTools.open_live_room.schema),
};

export type CreateToolCall = {
  [N in CreateToolName]: { name: N; args: RoomToolArgs<N> };
}[CreateToolName];

export const isCreateToolName = (name: string): name is CreateToolName =>
  Object.hasOwn(createParsers, name);

export function parseCreateToolCall(
  name: CreateToolName,
  args: unknown
): { ok: true; call: CreateToolCall } | { ok: false; error: string } {
  const call = createParsers[name](args);
  return typeof call === "string"
    ? { ok: false, error: call }
    : { ok: true, call };
}

// A shared browser, desktop or call is one per room; docs, sheets, canvases and slides are one
// per title.
export function createdObject(call: CreateToolCall): {
  kind: "doc" | "sheet" | "canvas" | "slides" | "browser" | "desktop" | "media";
  title: string;
  onePerRoom: boolean;
} {
  switch (call.name) {
    case "create_live_doc":
      return { kind: "doc", title: call.args.title, onePerRoom: false };
    case "create_live_sheet":
      return { kind: "sheet", title: call.args.title, onePerRoom: false };
    case "create_live_canvas":
      return { kind: "canvas", title: call.args.title, onePerRoom: false };
    case "create_live_slides":
      return { kind: "slides", title: call.args.title, onePerRoom: false };
    case "open_live_browser": {
      const hostname = URL.canParse(call.args.url)
        ? new URL(call.args.url).hostname
        : "Browser";
      return {
        kind: "browser",
        title: call.args.title ?? hostname,
        onePerRoom: true,
      };
    }
    case "open_live_desktop":
      return {
        kind: "desktop",
        title:
          call.args.title ??
          (call.args.application
            ? `Desktop: ${call.args.application}`
            : "Desktop"),
        onePerRoom: true,
      };
    case "open_live_room":
      return {
        kind: "media",
        title: call.args.title ?? "Live room",
        onePerRoom: true,
      };
  }
}

// Fills a new object (or points an existing browser or desktop where it was asked) and returns
// what the agent reads back.
export async function fillCreatedObject(
  client: LiveAgentClient,
  call: CreateToolCall,
  object: RoomObject,
  { existing }: { existing: boolean }
): Promise<string> {
  const noun = `live ${object.kind === "media" ? "room" : object.kind}`;
  const lead = existing
    ? `This room already has the ${noun} "${object.title}" (${object.id}).`
    : `Created the ${noun} "${object.title}" (${object.id}). It is open in the space.`;
  switch (call.name) {
    case "create_live_doc":
      if (!existing) {
        await client.ops({
          ops: [
            {
              type: "insert",
              afterBlockId: null,
              markdown: call.args.markdown,
            },
          ],
        });
      }
      return `${lead}${existing ? " Edit it with edit_live_doc." : ""}\n\n${formatOutline(await client.outline())}`;
    case "create_live_sheet":
      if (!existing) {
        await client.sheetOps({
          ops: [{ type: "set_range", range: "A1", values: call.args.values }],
        });
      }
      return `${lead}${existing ? " Edit it with edit_live_sheet." : ""}\n\n${formatSheet(object, await client.readSheet())}`;
    case "create_live_canvas":
    case "create_live_slides": {
      const failed = existing
        ? []
        : (call.name === "create_live_canvas"
            ? await client.canvasOps({
                ops: [{ type: "add_shapes", shapes: call.args.shapes }],
              })
            : await client.slidesOps({
                ops: [
                  ...(call.args.theme
                    ? [{ type: "set_theme" as const, themeId: call.args.theme }]
                    : []),
                  ...toSlidesOps({
                    type: "add_slides",
                    slides: call.args.slides,
                  }),
                ],
              })
          ).results.flatMap((result) => (result.ok ? [] : [result.error]));
      const failures = failed.length
        ? `\nNot applied: ${failed.join("; ")}`
        : "";
      return `${lead}${existing ? ` Edit it with edit_live_canvas${call.name === "create_live_slides" ? " (it edits slides too)" : ""}.` : ""}${failures}\n\n${await readCanvasText(object, client)}`;
    }
    case "open_live_browser": {
      const ops = [{ type: "navigate" as const, url: call.args.url }];
      const opened = await client.browserOps({ ops });
      return `${lead}\n${formatActionResults(opened.results, ops)}\n\n${formatBrowserPage(opened.page)}`;
    }
    case "open_live_desktop": {
      const { application, target } = call.args;
      const ops = application
        ? [{ type: "launch" as const, application, uri: target }]
        : target
          ? [{ type: "open" as const, target }]
          : [{ type: "wait" as const, ms: 1000 }];
      const opened = await client.desktopOps({ ops });
      return `${lead}\n${formatActionResults(opened.results, ops)}\n\n${formatDesktop(opened.desktop)}`;
    }
    case "open_live_room":
      return `${lead}\n\n${formatTranscript(await client.transcript())}`;
  }
}
