import * as Y from "yjs";

// A space is one Y.Map of object maps: each live object of a room placed as a window. People
// arrange through their own connection; agents through `space-ops`. Every object keeps who last
// arranged it, and an agent never moves or resizes what a person arranged — the op is refused,
// not turned into a suggestion: a window's place is not binding content. Closing a window
// destroys nothing (it waits on the desktop to be opened again), so anyone may close one.

export type SpaceEditor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type WindowState = "open" | "minimized" | "maximized";

export type SpaceObjectView = {
  id: string;
  docName: string;
  kind: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  state: WindowState;
  by: SpaceEditor;
};

export type PlaceInput = {
  docName: string;
  kind: string;
  title: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export type SpaceOpResult =
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "arranged_by_person"; by?: string };

export type SpaceChange = {
  id: string;
  title: string;
  kind:
    | "placed"
    | "moved"
    | "resized"
    | "removed"
    | "minimized"
    | "maximized"
    | "restored";
};

export const slotSize = { w: 720, h: 480, gap: 24, perRow: 3 };

export const spaceObjects = (doc: Y.Doc) =>
  doc.getMap<Y.Map<unknown>>("spaceObjects");

export const isSpaceDoc = (doc: Y.Doc) => spaceObjects(doc).size > 0;

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEditor(value: unknown): value is SpaceEditor {
  return (
    isRecord(value) &&
    (value.kind === "human" || value.kind === "agent") &&
    typeof value.id === "string" &&
    typeof value.name === "string"
  );
}

const readState = (value: unknown): WindowState =>
  value === "minimized" || value === "maximized" ? value : "open";

function readObject(object: Y.Map<unknown>): SpaceObjectView | null {
  const view = {
    id: object.get("id"),
    docName: object.get("docName"),
    kind: object.get("kind"),
    title: object.get("title"),
    x: object.get("x"),
    y: object.get("y"),
    w: object.get("w"),
    h: object.get("h"),
    z: object.get("z"),
    by: object.get("by"),
  };
  return typeof view.id === "string" &&
    typeof view.docName === "string" &&
    typeof view.kind === "string" &&
    typeof view.title === "string" &&
    typeof view.x === "number" &&
    typeof view.y === "number" &&
    typeof view.w === "number" &&
    typeof view.h === "number" &&
    typeof view.z === "number" &&
    isEditor(view.by)
    ? {
        id: view.id,
        docName: view.docName,
        kind: view.kind,
        title: view.title,
        x: view.x,
        y: view.y,
        w: view.w,
        h: view.h,
        z: view.z,
        state: readState(object.get("state")),
        by: view.by,
      }
    : null;
}

const isRemoved = (object: Y.Map<unknown>) => object.get("removed") === true;
const isBinned = (object: Y.Map<unknown>) => object.get("binned") === true;
const isDeleted = (object: Y.Map<unknown>) => object.get("deleted") === true;

function liveObjects(
  doc: Y.Doc
): { map: Y.Map<unknown>; view: SpaceObjectView }[] {
  const live: { map: Y.Map<unknown>; view: SpaceObjectView }[] = [];
  for (const map of spaceObjects(doc).values()) {
    const view = readObject(map);
    if (view && !isRemoved(map)) {
      live.push({ map, view });
    }
  }
  return live;
}

// Two peers can place the same doc before they sync; the lowest id is the one every peer keeps.
function findByDocName(doc: Y.Doc, docName: string): Y.Map<unknown> | null {
  let found: Y.Map<unknown> | null = null;
  for (const map of spaceObjects(doc).values()) {
    const id = map.get("id");
    if (
      map.get("docName") === docName &&
      typeof id === "string" &&
      (!found || id < String(found.get("id")))
    ) {
      found = map;
    }
  }
  return found;
}

export function placedDocNames(doc: Y.Doc): Set<string> {
  const names = new Set<string>();
  for (const map of spaceObjects(doc).values()) {
    const docName = map.get("docName");
    if (typeof docName === "string") {
      names.add(docName);
    }
  }
  return names;
}

function nextZ(doc: Y.Doc): number {
  let top = 0;
  for (const map of spaceObjects(doc).values()) {
    const z = map.get("z");
    if (typeof z === "number" && z > top) {
      top = z;
    }
  }
  return top + 1;
}

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// The first grid slot, row by row, that no live object touches — so agents never compute layout.
function freeSlot(doc: Y.Doc, w: number, h: number): { x: number; y: number } {
  const taken = liveObjects(doc).map(({ view }) => view);
  const { gap, perRow } = slotSize;
  for (let i = 0; ; i += 1) {
    const slot = {
      x: gap + (i % perRow) * (slotSize.w + gap),
      y: gap + Math.floor(i / perRow) * (slotSize.h + gap),
      w,
      h,
    };
    if (!taken.some((object) => overlaps(slot, object))) {
      return { x: slot.x, y: slot.y };
    }
  }
}

export function placeObject(
  doc: Y.Doc,
  input: PlaceInput,
  actor: SpaceEditor
): SpaceOpResult {
  const existing = findByDocName(doc, input.docName);
  const existingId = existing?.get("id");
  if (existing && isDeleted(existing)) {
    return { ok: false, error: "not_found" };
  }
  if (existing && typeof existingId === "string" && !isRemoved(existing)) {
    return { ok: true, id: existingId };
  }
  const w = input.w ?? slotSize.w;
  const h = input.h ?? slotSize.h;
  const at =
    input.x !== undefined && input.y !== undefined
      ? { x: input.x, y: input.y }
      : freeSlot(doc, w, h);
  const id = existing && typeof existingId === "string" ? existingId : newId();
  doc.transact(() => {
    const object =
      existing ??
      (() => {
        const created = new Y.Map<unknown>();
        spaceObjects(doc).set(id, created);
        return created;
      })();
    object.set("id", id);
    object.set("docName", input.docName);
    object.set("kind", input.kind);
    object.set("title", input.title);
    object.set("x", at.x);
    object.set("y", at.y);
    object.set("w", w);
    object.set("h", h);
    object.set("z", nextZ(doc));
    object.set("by", actor);
    object.delete("removed");
    object.delete("state");
    object.delete("binned");
  });
  return { ok: true, id };
}

function arrangeable(
  doc: Y.Doc,
  id: string,
  actor: SpaceEditor
): { ok: true; object: Y.Map<unknown> } | Exclude<SpaceOpResult, { ok: true }> {
  const object = spaceObjects(doc).get(id);
  if (!object || isRemoved(object)) {
    return { ok: false, error: "not_found" };
  }
  const by = object.get("by");
  if (actor.kind === "agent" && isEditor(by) && by.kind === "human") {
    return { ok: false, error: "arranged_by_person", by: by.name };
  }
  return { ok: true, object };
}

export function moveObject(
  doc: Y.Doc,
  id: string,
  x: number,
  y: number,
  actor: SpaceEditor
): SpaceOpResult {
  const found = arrangeable(doc, id, actor);
  if (!found.ok) {
    return found;
  }
  doc.transact(() => {
    found.object.set("x", x);
    found.object.set("y", y);
    found.object.set("by", actor);
  });
  return { ok: true, id };
}

export function resizeObject(
  doc: Y.Doc,
  id: string,
  w: number,
  h: number,
  actor: SpaceEditor
): SpaceOpResult {
  const found = arrangeable(doc, id, actor);
  if (!found.ok) {
    return found;
  }
  doc.transact(() => {
    found.object.set("w", w);
    found.object.set("h", h);
    found.object.set("by", actor);
  });
  return { ok: true, id };
}

// A removal is a tombstone: a later placement of the same doc revives it in place, and a version
// restore can bring it back. Like a window's state, it is anyone's to change, and the arranger
// stays who it was.
export function removeObject(
  doc: Y.Doc,
  id: string,
  _actor: SpaceEditor
): SpaceOpResult {
  const object = spaceObjects(doc).get(id);
  if (!object || isRemoved(object)) {
    return { ok: false, error: "not_found" };
  }
  object.set("removed", true);
  return { ok: true, id };
}

// The bin is a person's: moving an object there takes it off the desktop but keeps it, so it can
// be put back; only emptying the bin (forgetObject, with the host deleting the object) ends it.
// Agents are never offered either.
export function binObject(doc: Y.Doc, id: string): SpaceOpResult {
  const object = spaceObjects(doc).get(id);
  if (!object) {
    return { ok: false, error: "not_found" };
  }
  doc.transact(() => {
    object.set("removed", true);
    object.set("binned", true);
  });
  return { ok: true, id };
}

export function readBinned(doc: Y.Doc): SpaceObjectView[] {
  const binned: SpaceObjectView[] = [];
  for (const map of spaceObjects(doc).values()) {
    const view = readObject(map);
    if (view && isBinned(map) && !isDeleted(map)) {
      binned.push(view);
    }
  }
  return binned.sort(byId);
}

// A deleted object keeps a tombstone that is never shown: a viewer whose list of the channel's
// objects is a moment stale must still see the doc as placed, or it would put it back.
export function forgetObject(doc: Y.Doc, id: string): void {
  const object = spaceObjects(doc).get(id);
  if (!object) {
    return;
  }
  doc.transact(() => {
    object.set("removed", true);
    object.set("deleted", true);
  });
}

// Raising a window is not arranging it: anyone may, and the arranger stays who it was.
export function bringToFront(
  doc: Y.Doc,
  id: string,
  _actor: SpaceEditor
): SpaceOpResult {
  const object = spaceObjects(doc).get(id);
  if (!object || isRemoved(object)) {
    return { ok: false, error: "not_found" };
  }
  object.set("z", nextZ(doc));
  return { ok: true, id };
}

// Minimizing or maximizing changes how the room looks at a window, not where it sits: anyone may,
// person or agent, and the arranger stays who it was. A maximized window comes to the front.
export function setWindowState(
  doc: Y.Doc,
  id: string,
  state: WindowState,
  _actor: SpaceEditor
): SpaceOpResult {
  const object = spaceObjects(doc).get(id);
  if (!object || isRemoved(object)) {
    return { ok: false, error: "not_found" };
  }
  doc.transact(() => {
    if (state === "open") {
      object.delete("state");
    } else {
      object.set("state", state);
    }
    if (state === "maximized") {
      object.set("z", nextZ(doc));
    }
  });
  return { ok: true, id };
}

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function readSpace(doc: Y.Doc): SpaceObjectView[] {
  const firstByDocName = new Map<string, SpaceObjectView>();
  for (const { view } of liveObjects(doc).sort((a, b) =>
    byId(a.view, b.view)
  )) {
    if (!firstByDocName.has(view.docName)) {
      firstByDocName.set(view.docName, view);
    }
  }
  return [...firstByDocName.values()].sort((a, b) => a.z - b.z || byId(a, b));
}

export function readHidden(doc: Y.Doc): SpaceObjectView[] {
  const hidden: SpaceObjectView[] = [];
  for (const map of spaceObjects(doc).values()) {
    const view = readObject(map);
    if (view && isRemoved(map) && !isBinned(map) && !isDeleted(map)) {
      hidden.push(view);
    }
  }
  return hidden.sort(byId);
}

export function restoreSpace(doc: Y.Doc, version: Y.Doc): void {
  const current = spaceObjects(doc);
  const target = spaceObjects(version);
  if (current.size === 0 && target.size === 0) {
    return;
  }
  doc.transact(() => {
    for (const [id, object] of current.entries()) {
      if (!target.has(id) && !isRemoved(object)) {
        object.set("removed", true);
      }
    }
    for (const [id, object] of target.entries()) {
      const now =
        current.get(id) ??
        (() => {
          const created = new Y.Map<unknown>();
          current.set(id, created);
          return created;
        })();
      for (const [key, value] of object.entries()) {
        if (now.get(key) !== value) {
          now.set(key, value);
        }
      }
      if (!isRemoved(object)) {
        now.delete("removed");
      }
    }
  });
}

export function diffSpaces(before: Y.Doc, after: Y.Doc): SpaceChange[] {
  const was = new Map(readSpace(before).map((object) => [object.id, object]));
  const changes: SpaceChange[] = [];
  for (const object of readSpace(after)) {
    const prior = was.get(object.id);
    was.delete(object.id);
    if (!prior) {
      changes.push({ id: object.id, title: object.title, kind: "placed" });
    } else if (prior.x !== object.x || prior.y !== object.y) {
      changes.push({ id: object.id, title: object.title, kind: "moved" });
    } else if (prior.w !== object.w || prior.h !== object.h) {
      changes.push({ id: object.id, title: object.title, kind: "resized" });
    } else if (prior.state !== object.state) {
      changes.push({
        id: object.id,
        title: object.title,
        kind: object.state === "open" ? "restored" : object.state,
      });
    }
  }
  for (const object of was.values()) {
    changes.push({ id: object.id, title: object.title, kind: "removed" });
  }
  return changes;
}
