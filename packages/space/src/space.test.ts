import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  binObject,
  bringToFront,
  diffSpaces,
  forgetObject,
  isSpaceDoc,
  moveObject,
  placedDocNames,
  placeObject,
  readBinned,
  readHidden,
  readSpace,
  removeObject,
  resizeObject,
  restoreSpace,
  setWindowState,
  slotSize,
} from "./index.ts";

const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
const hana = { kind: "human" as const, id: "u1", name: "Hana" };

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

const brief = { docName: "ldoc_brief", kind: "doc", title: "Brief" };

describe("space", () => {
  it("merges a concurrent move and resize of the same object", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const placed = placeObject(a, brief, hana);
    expect(placed.ok).toBe(true);
    const id = placed.ok ? placed.id : "";
    sync(a, b);
    expect(moveObject(a, id, 900, 300, hana).ok).toBe(true);
    expect(resizeObject(b, id, 400, 260, hana).ok).toBe(true);
    sync(a, b);
    for (const doc of [a, b]) {
      const [object] = readSpace(doc);
      expect(object).toMatchObject({ id, x: 900, y: 300, w: 400, h: 260 });
    }
    expect(isSpaceDoc(a)).toBe(true);
    expect(isSpaceDoc(new Y.Doc())).toBe(false);
  });

  it("places once per doc and fills the grid slot by slot", () => {
    const doc = new Y.Doc();
    const first = placeObject(doc, brief, juno);
    const again = placeObject(doc, brief, juno);
    expect(again).toEqual(first);
    const second = placeObject(
      doc,
      { docName: "ldoc_sheet", kind: "sheet", title: "Numbers" },
      juno
    );
    const [one, two] = readSpace(doc);
    expect(one.docName).toBe("ldoc_brief");
    expect(two.docName).toBe("ldoc_sheet");
    expect(two.x).toBe(one.x + slotSize.w + slotSize.gap);
    expect(two.y).toBe(one.y);
    expect(two.z).toBeGreaterThan(one.z);
    expect(second.ok && bringToFront(doc, one.id, juno).ok).toBe(true);
    expect(readSpace(doc).map((o) => o.docName)).toEqual([
      "ldoc_sheet",
      "ldoc_brief",
    ]);
  });

  it("refuses an agent's move of an object a person arranged", () => {
    const doc = new Y.Doc();
    const own = placeObject(doc, brief, juno);
    const theirs = placeObject(
      doc,
      { docName: "ldoc_plan", kind: "doc", title: "Plan", x: 10, y: 20 },
      hana
    );
    const ownId = own.ok ? own.id : "";
    const theirsId = theirs.ok ? theirs.id : "";
    expect(moveObject(doc, theirsId, 0, 0, juno)).toEqual({
      ok: false,
      error: "arranged_by_person",
      by: "Hana",
    });
    expect(moveObject(doc, ownId, 50, 60, juno).ok).toBe(true);
    expect(bringToFront(doc, theirsId, juno).ok).toBe(true);
    expect(moveObject(doc, theirsId, 1, 1, hana).ok).toBe(true);
    expect(moveObject(doc, "missing", 0, 0, hana)).toEqual({
      ok: false,
      error: "not_found",
    });
    // Closing destroys nothing, so an agent may close even a window a person arranged.
    expect(removeObject(doc, theirsId, juno).ok).toBe(true);
    expect(readSpace(doc).map((o) => o.id)).toEqual([ownId]);
  });

  it("keeps one window per doc when two peers place it before they sync", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    placeObject(a, brief, hana);
    placeObject(b, brief, juno);
    sync(a, b);
    expect(readSpace(a).map((o) => o.docName)).toEqual(["ldoc_brief"]);
    expect(readSpace(a)[0].id).toBe(readSpace(b)[0].id);
    const [kept] = readSpace(a);
    expect(moveObject(b, kept.id, 5, 5, hana).ok).toBe(true);
    sync(a, b);
    expect(readSpace(a)[0]).toMatchObject({ x: 5, y: 5 });
    expect(placeObject(a, brief, juno)).toEqual({ ok: true, id: kept.id });
    expect([...placedDocNames(a)]).toEqual(["ldoc_brief"]);
    removeObject(a, kept.id, hana);
    expect(readHidden(a).map((o) => o.docName)).toEqual(["ldoc_brief"]);
  });

  it("brings a removed object back from a version and lists the change", () => {
    const doc = new Y.Doc();
    const placed = placeObject(doc, brief, hana);
    const id = placed.ok ? placed.id : "";
    const before = Y.encodeStateAsUpdate(doc);
    expect(removeObject(doc, id, hana).ok).toBe(true);
    expect(readSpace(doc)).toEqual([]);
    const version = new Y.Doc();
    Y.applyUpdate(version, before);
    expect(diffSpaces(version, doc)).toEqual([
      { id, title: "Brief", kind: "removed" },
    ]);
    restoreSpace(doc, version);
    expect(readSpace(doc).map((o) => o.id)).toEqual([id]);
    expect(placeObject(doc, brief, juno)).toEqual({ ok: true, id });
  });

  it("shares a window's state, lets an agent change a person's window, and reopens it open", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const placed = placeObject(a, brief, hana);
    const id = placed.ok ? placed.id : "";
    sync(a, b);
    expect(setWindowState(b, id, "minimized", juno)).toEqual({ ok: true, id });
    sync(a, b);
    expect(readSpace(a)[0]).toMatchObject({ state: "minimized", by: hana });
    const before = new Y.Doc();
    Y.applyUpdate(before, Y.encodeStateAsUpdate(a));
    setWindowState(a, id, "maximized", hana);
    expect(diffSpaces(before, a)).toEqual([
      { id, title: "Brief", kind: "maximized" },
    ]);
    removeObject(a, id, hana);
    expect(setWindowState(a, id, "open", hana)).toEqual({
      ok: false,
      error: "not_found",
    });
    placeObject(a, brief, hana);
    expect(readSpace(a)[0].state).toBe("open");
  });

  it("bins an object off the desktop, restores it, and forgets it when the bin is emptied", () => {
    const doc = new Y.Doc();
    const placed = placeObject(doc, brief, hana);
    const id = placed.ok ? placed.id : "";
    removeObject(doc, id, hana);
    expect(binObject(doc, id)).toEqual({ ok: true, id });
    expect(readHidden(doc)).toEqual([]);
    expect(readBinned(doc).map((o) => o.id)).toEqual([id]);
    placeObject(doc, brief, hana);
    expect(readBinned(doc)).toEqual([]);
    expect(readSpace(doc).map((o) => o.id)).toEqual([id]);
    binObject(doc, id);
    forgetObject(doc, id);
    expect([readSpace(doc), readHidden(doc), readBinned(doc)]).toEqual([
      [],
      [],
      [],
    ]);
    // Still known as placed, so a viewer with a stale list never puts it back.
    expect([...placedDocNames(doc)]).toEqual(["ldoc_brief"]);
    expect(placeObject(doc, brief, hana).ok).toBe(false);
  });
});
