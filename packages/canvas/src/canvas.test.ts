import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  acceptCanvasSuggestion,
  addShapes,
  canvasElements,
  connect,
  deleteShapes,
  diffCanvases,
  humanWrittenElements,
  pendingCanvasSuggestions,
  readCanvas,
  rejectCanvasSuggestion,
  restoreCanvas,
  updateShapes,
  writeLocalElements,
} from "./index.ts";

const agent = { kind: "agent" as const, id: "juno", name: "Juno" };
const hana = { kind: "human" as const, id: "u1", name: "Hana" };
const suggest = (id: string) => ({
  actor: agent,
  suggest: { id, actor: agent, approver: "Hana", approverId: "u1" },
});

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

const snapshot = (doc: Y.Doc) => JSON.stringify(canvasElements(doc).toJSON());

describe("canvas", () => {
  it("merges an agent's new shapes with a person moving another shape", () => {
    const server = new Y.Doc();
    addShapes(
      server,
      [{ id: "lead", type: "rectangle", x: 0, y: 0, label: "Lead" }],
      { actor: agent }
    );
    const client = new Y.Doc();
    sync(server, client);

    const lead = canvasElements(client).get("lead");
    if (!lead) {
      throw new Error("lead missing");
    }
    writeLocalElements(
      client,
      [{ ...lead, x: 300, version: lead.version + 1 }],
      hana
    );
    addShapes(
      server,
      [{ id: "deal", type: "ellipse", x: 0, y: 300, label: "Deal" }],
      { actor: agent }
    );
    sync(server, client);

    const view = readCanvas(server);
    expect(view.shapes.map((s) => [s.id, s.x, s.label, s.by])).toEqual([
      ["lead", 300, "Lead", "Hana"],
      ["deal", 0, "Deal", null],
    ]);
    expect(snapshot(server)).toBe(snapshot(client));
  });

  it("binds both ends of a connection and reroutes it when a shape moves", () => {
    const doc = new Y.Doc();
    addShapes(doc, [
      { id: "a", type: "rectangle", x: 0, y: 0 },
      { id: "b", type: "rectangle", x: 400, y: 0 },
    ]);
    const result = connect(doc, [
      { id: "ab", from: "a", to: "b", label: "qualifies" },
    ]);
    expect(result).toEqual({ ok: true, ids: ["ab"] });
    const elements = canvasElements(doc);
    expect(elements.get("a")?.boundElements).toContainEqual({
      id: "ab",
      type: "arrow",
    });
    expect(elements.get("b")?.boundElements).toContainEqual({
      id: "ab",
      type: "arrow",
    });
    expect(readCanvas(doc).connections).toEqual([
      { id: "ab", from: "a", to: "b", label: "qualifies" },
    ]);
    const before = elements.get("ab")?.points;
    updateShapes(doc, [{ id: "b", x: 400, y: 400 }]);
    expect(elements.get("ab")?.points).not.toEqual(before);

    deleteShapes(doc, ["b"]);
    expect(elements.get("ab")?.isDeleted).toBe(true);
    expect(elements.get("a")?.boundElements).not.toContainEqual({
      id: "ab",
      type: "arrow",
    });
  });

  it("leaves the canvas identical when a suggestion is rejected, and applies it on accept", () => {
    const doc = new Y.Doc();
    addShapes(
      doc,
      [{ id: "price", type: "rectangle", x: 0, y: 0, label: "$15,000" }],
      { actor: hana }
    );
    const before = snapshot(doc);

    updateShapes(doc, [{ id: "price", label: "$13,500" }], suggest("s1"));
    addShapes(
      doc,
      [{ id: "fee", type: "rectangle", x: 0, y: 200, label: "Setup fee" }],
      suggest("s1")
    );
    connect(doc, [{ from: "price", to: "fee" }], suggest("s1"));
    expect(snapshot(doc)).toBe(before);
    const [pending] = pendingCanvasSuggestions(doc);
    expect(pending.changes.map((c) => [c.id, c.label, c.kind])).toEqual(
      expect.arrayContaining([
        ["price", "$13,500", "changed"],
        ["fee", "Setup fee", "added"],
      ])
    );

    rejectCanvasSuggestion(doc, "s1");
    expect(snapshot(doc)).toBe(before);
    expect(pendingCanvasSuggestions(doc)).toEqual([]);

    updateShapes(doc, [{ id: "price", label: "$13,500" }], suggest("s2"));
    acceptCanvasSuggestion(doc, "s2", hana);
    expect(readCanvas(doc).shapes[0]).toMatchObject({
      label: "$13,500",
      by: "Hana",
    });
  });

  it("marks a suggestion stale when the shape changed after it was proposed", () => {
    const doc = new Y.Doc();
    addShapes(doc, [{ id: "a", type: "rectangle", x: 0, y: 0, label: "A" }], {
      actor: hana,
    });
    updateShapes(doc, [{ id: "a", label: "B" }], suggest("s1"));
    expect(pendingCanvasSuggestions(doc)[0].stale).toBe(false);
    updateShapes(doc, [{ id: "a", x: 50 }], { actor: hana });
    expect(pendingCanvasSuggestions(doc)[0].stale).toBe(true);
  });

  it("knows which shapes a person wrote", () => {
    const doc = new Y.Doc();
    addShapes(
      doc,
      [
        { id: "mine", type: "rectangle", x: 0, y: 0, label: "Agent" },
        { id: "theirs", type: "rectangle", x: 0, y: 200, label: "Person" },
      ],
      { actor: agent }
    );
    const theirs = canvasElements(doc).get("theirs");
    if (!theirs) {
      throw new Error("missing");
    }
    writeLocalElements(
      doc,
      [{ ...theirs, x: 10, version: theirs.version + 1 }],
      hana
    );
    expect(humanWrittenElements(doc, ["mine", "theirs"])).toEqual(["theirs"]);
  });

  it("restores a version forward and diffs shapes by label", () => {
    const doc = new Y.Doc();
    addShapes(doc, [
      { id: "a", type: "rectangle", x: 0, y: 0, label: "Start" },
    ]);
    const v1 = Y.encodeStateAsUpdate(doc);
    updateShapes(doc, [{ id: "a", label: "Begin" }]);
    addShapes(doc, [
      { id: "b", type: "diamond", x: 0, y: 200, label: "Decide" },
    ]);

    const version = new Y.Doc();
    Y.applyUpdate(version, v1);
    expect(diffCanvases(version, doc)).toEqual([
      { id: "a", type: "rectangle", label: "Begin", kind: "changed" },
      { id: "b", type: "diamond", label: "Decide", kind: "added" },
    ]);

    const open = new Y.Doc();
    Y.applyUpdate(open, Y.encodeStateAsUpdate(doc));
    restoreCanvas(doc, version);
    sync(doc, open);
    expect(readCanvas(open).shapes.map((s) => [s.id, s.label])).toEqual([
      ["a", "Start"],
    ]);
    expect(canvasElements(open).get("b")?.isDeleted).toBe(true);
  });
});
