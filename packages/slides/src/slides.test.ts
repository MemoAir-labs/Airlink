import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  acceptSlideSuggestion,
  addElement,
  addSlide,
  deckElements,
  deleteSlide,
  diffSlides,
  editElement,
  elementBlocks,
  humanWrittenElements,
  moveSlide,
  pendingSlideSuggestions,
  readDeck,
  readThemeState,
  rejectSlideSuggestion,
  resolveTheme,
  restoreSlides,
  setElementByHand,
  setTheme,
  updateSlide,
} from "./index.ts";
import { migrateCanvasDeck, needsDeckMigration } from "./migrate.ts";
import { toPptx } from "./pptx.ts";

const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
const hana = { kind: "human" as const, id: "u1", name: "Hana" };
const suggest = (id: string) => ({
  actor: juno,
  suggest: { id, actor: juno, approver: "Hana", approverId: "u1" },
});

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

// Everything a viewer sees: slides, elements with their text blocks, and the theme.
function content(doc: Y.Doc) {
  const deck = readDeck(doc);
  return JSON.stringify({
    deck,
    blocks: deck.slides.flatMap((slide) =>
      slide.elements.map((element) => elementBlocks(doc, element.id))
    ),
  });
}

function pipelineDeck() {
  const doc = new Y.Doc();
  addSlide(
    doc,
    { id: "s1", layout: "title", title: "Q3 pipeline", subtitle: "Review" },
    { actor: juno }
  );
  addSlide(
    doc,
    {
      id: "s2",
      layout: "title_bullets",
      title: "Highlights",
      bullets: ["Acme signed", "Globex in legal"],
    },
    { actor: juno }
  );
  return doc;
}

describe("slides", () => {
  it("fills a layout's slots and leaves empty slots out", () => {
    const doc = new Y.Doc();
    addSlide(doc, {
      id: "c",
      layout: "chart_takeaway",
      title: "Pipeline by stage",
      bullets: ["Proposal stage doubled"],
      chart: {
        chart: "bar",
        labels: ["Lead", "Proposal"],
        series: [{ name: "Deals", values: [12, 8] }],
      },
    });
    addSlide(doc, { id: "t", layout: "title", title: "Q3" });
    const [chart, title] = readDeck(doc).slides;
    expect(chart.elements.map((e) => [e.slot, e.kind])).toEqual([
      ["title", "text"],
      ["chart", "chart"],
      ["body", "text"],
    ]);
    expect(chart.elements[1].data).toMatchObject({
      chart: "bar",
      labels: ["Lead", "Proposal"],
    });
    expect(chart.elements[2].text).toBe("- Proposal stage doubled");
    expect(title.elements.map((e) => e.slot)).toEqual(["accent", "title"]);

    addSlide(doc, {
      id: "o",
      layout: "title",
      title: "Q3",
      bullets: ["Sales review", "Friday"],
    });
    const opening = readDeck(doc).slides[2];
    expect(opening.elements.find((e) => e.slot === "subtitle")?.text).toBe(
      "Sales review\nFriday"
    );
  });

  it("merges an agent's text edit with a person dragging the same element", () => {
    const server = pipelineDeck();
    const client = new Y.Doc();
    sync(server, client);

    updateSlide(
      server,
      { slide: "s2", title: "Q3 highlights" },
      { actor: juno }
    );
    setElementByHand(client, "s2-title", { x: 300, y: 120 }, hana);
    sync(server, client);

    const title = readDeck(server).slides[1].elements.find(
      (e) => e.slot === "title"
    );
    expect(title).toMatchObject({ x: 300, y: 120, text: "Q3 highlights" });
    expect(content(server)).toBe(content(client));
  });

  it("leaves the deck identical when a suggestion is rejected, and applies it on accept", () => {
    const doc = pipelineDeck();
    const before = content(doc);

    updateSlide(
      doc,
      { slide: "s2", title: "Q3 wins", bullets: ["Acme signed for $40k"] },
      suggest("x")
    );
    addSlide(
      doc,
      { id: "s3", layout: "closing", title: "Next steps" },
      suggest("x")
    );
    editElement(doc, { element: "s1-title", x: 200 }, suggest("x"));
    moveSlide(doc, "s2", 1, suggest("x"));
    expect(readDeck(doc).slides.map((s) => s.title)).toEqual([
      "Q3 pipeline",
      "Highlights",
    ]);

    const [pending] = pendingSlideSuggestions(doc);
    expect(pending.lines.map((l) => [l.kind, l.label])).toEqual(
      expect.arrayContaining([
        ["added", "Slide: Next steps"],
        ["moved", "Slide to position 1"],
        ["changed", "Q3 wins"],
      ])
    );

    rejectSlideSuggestion(doc, "x");
    expect(content(doc)).toBe(before);
    expect(pendingSlideSuggestions(doc)).toEqual([]);

    updateSlide(doc, { slide: "s2", title: "Q3 wins" }, suggest("y"));
    addSlide(
      doc,
      { id: "s3", layout: "closing", title: "Next steps" },
      suggest("y")
    );
    acceptSlideSuggestion(doc, "y", hana);
    const deck = readDeck(doc);
    expect(deck.slides.map((s) => s.title)).toEqual([
      "Q3 pipeline",
      "Q3 wins",
      "Next steps",
    ]);
    expect(deck.slides[1].elements.find((e) => e.slot === "title")?.by).toBe(
      "Hana"
    );
  });

  it("switches theme, keeping overrides, and suggests a theme change without applying it", () => {
    const doc = pipelineDeck();
    setTheme(doc, { themeId: "midnight", overrides: { accent: "#FF6B35" } });
    const theme = resolveTheme(readThemeState(doc));
    expect(theme.fonts.heading).toBe("Georgia");
    expect(theme.palette.accent).toBe("#FF6B35");
    expect(theme.mode).toBe("dark");

    setTheme(doc, { themeId: "studio", overrides: {} }, suggest("t"));
    expect(readThemeState(doc).themeId).toBe("midnight");
    acceptSlideSuggestion(doc, "t", hana);
    expect(readThemeState(doc)).toEqual({ themeId: "studio", overrides: {} });
  });

  it("knows which elements a person last changed", () => {
    const doc = pipelineDeck();
    setElementByHand(doc, "s2-body", { w: 900 }, hana);
    expect(humanWrittenElements(doc, ["s2-title", "s2-body"])).toEqual([
      "s2-body",
    ]);
  });

  it("moves slotted elements when the layout changes", () => {
    const doc = pipelineDeck();
    updateSlide(doc, {
      slide: "s2",
      layout: "two_column",
      rightBullets: ["Initech"],
    });
    const slide = readDeck(doc).slides[1];
    expect(slide.layout).toBe("two_column");
    expect(slide.elements.find((e) => e.slot === "body")?.w).toBe(800);
    expect(slide.elements.find((e) => e.slot === "right")?.text).toBe(
      "- Initech"
    );
  });

  it("restores a version forward and diffs slides and elements by title", () => {
    const doc = pipelineDeck();
    addElement(doc, {
      id: "note",
      slide: "s2",
      kind: "text",
      text: "Draft",
      x: 100,
      y: 900,
    });
    const v1 = Y.encodeStateAsUpdate(doc);
    updateSlide(doc, { slide: "s2", title: "Wins" });
    deleteSlide(doc, "s1");
    addSlide(doc, { id: "s9", layout: "closing", title: "Thanks" });

    const version = new Y.Doc();
    Y.applyUpdate(version, v1);
    expect(diffSlides(version, doc)).toEqual(
      expect.arrayContaining([
        { kind: "added", target: "slide", label: "Thanks", slide: "Thanks" },
        {
          kind: "removed",
          target: "slide",
          label: "Q3 pipeline",
          slide: "Q3 pipeline",
        },
        { kind: "changed", target: "element", label: "Wins", slide: "Wins" },
      ])
    );

    const open = new Y.Doc();
    Y.applyUpdate(open, Y.encodeStateAsUpdate(doc));
    restoreSlides(doc, version);
    sync(doc, open);
    expect(readDeck(open).slides.map((s) => s.title)).toEqual([
      "Q3 pipeline",
      "Highlights",
    ]);
    expect(deckElements(open).get("note")).toBeDefined();
    expect(content(open)).toBe(content(version));
  });
});

describe("pptx", () => {
  it("exports native text, a native chart, theme fonts and notes", async () => {
    const doc = pipelineDeck();
    addSlide(doc, {
      id: "s3",
      layout: "chart_takeaway",
      title: "By stage",
      bullets: ["Proposal doubled"],
      chart: {
        chart: "bar",
        labels: ["Lead", "Proposal"],
        series: [{ name: "Deals", values: [12, 8] }],
      },
      notes: "Pause on the proposal bar.",
    });
    setTheme(doc, { themeId: "midnight" });
    updateSlide(doc, { slide: "s2", title: "Not yet accepted" }, suggest("p"));

    const text = Buffer.from(await toPptx(doc, "Q3")).toString("latin1");
    expect(text.startsWith("PK")).toBe(true);
    expect(text).toContain("ppt/slides/slide3.xml");
    expect(text).not.toContain("ppt/slides/slide4.xml");
    expect(text).toContain("ppt/charts/chart");
    expect(text).toContain("Q3 pipeline");
    expect(text).toContain("Acme signed");
    expect(text).toContain('typeface="Georgia"');
    expect(text).toContain("Pause on the proposal bar.");
    expect(text).toContain("Highlights");
    expect(text).not.toContain("Not yet accepted");
  });
});

describe("migration", () => {
  // A P4 deck: Excalidraw frames with layout texts tagged by role, plus a labelled box and an arrow.
  function p4Deck() {
    const doc = new Y.Doc();
    const old = doc.getMap<unknown>("canvasElements");
    const el = (props: Record<string, unknown>) =>
      old.set(String(props.id), {
        isDeleted: false,
        index: "a0",
        frameId: null,
        ...props,
      });
    el({
      id: "f1",
      type: "frame",
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      name: "Plan",
      customData: { slide: true, layout: "title_bullets", notes: "Say hi" },
    });
    el({
      id: "t1",
      type: "text",
      x: 120,
      y: 90,
      width: 400,
      height: 80,
      frameId: "f1",
      originalText: "Plan",
      customData: { role: "title" },
    });
    el({
      id: "b1",
      type: "text",
      x: 120,
      y: 260,
      width: 900,
      height: 120,
      frameId: "f1",
      originalText: "• Ship\n• Learn",
      customData: { role: "body" },
    });
    el({
      id: "r1",
      type: "rectangle",
      x: 200,
      y: 600,
      width: 300,
      height: 120,
      frameId: "f1",
      boundElements: [{ id: "l1", type: "text" }],
    });
    el({
      id: "l1",
      type: "text",
      x: 220,
      y: 640,
      width: 200,
      height: 30,
      frameId: "f1",
      containerId: "r1",
      originalText: "Pilot",
    });
    el({
      id: "a1",
      type: "arrow",
      x: 500,
      y: 660,
      width: 200,
      height: 0,
      frameId: "f1",
      points: [
        [0, 0],
        [200, 0],
      ],
    });
    el({
      id: "f0",
      type: "frame",
      x: 2120,
      y: 0,
      width: 1920,
      height: 1080,
      name: "Hello",
      customData: { slide: true, layout: "title", notes: "" },
    });
    el({
      id: "t0",
      type: "text",
      x: 2280,
      y: 380,
      width: 400,
      height: 80,
      frameId: "f0",
      originalText: "Hello",
      customData: { role: "title" },
    });
    return doc;
  }

  it("turns a P4 Excalidraw deck into slides once", () => {
    const doc = p4Deck();
    expect(needsDeckMigration(doc)).toBe(true);
    expect(migrateCanvasDeck(doc)).toBe(true);

    const deck = readDeck(doc);
    expect(deck.slides.map((s) => [s.id, s.layout, s.title, s.notes])).toEqual([
      ["f1", "title_bullets", "Plan", "Say hi"],
      ["f0", "title", "Hello", ""],
    ]);
    const plan = deck.slides[0].elements;
    expect(plan.find((e) => e.slot === "body")?.text).toBe("- Ship\n- Learn");
    expect(
      plan.filter((e) => e.slot === null).map((e) => [e.kind, e.text ?? e.data])
    ).toEqual([
      ["shape", { shape: "rect" }],
      ["text", "Pilot"],
      ["shape", { shape: "line" }],
    ]);
    expect(doc.getMap("canvasElements").size).toBe(0);
    expect(migrateCanvasDeck(doc)).toBe(false);
  });
});
