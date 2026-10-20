import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  initDesktop,
  isDesktopDoc,
  readActions,
  readDesktopState,
  recordAction,
  setDesktopStatus,
  toE2bKey,
} from "./index.ts";

const juno = { kind: "agent" as const, id: "a1", name: "Juno" };

describe("desktop model", () => {
  it("starts stopped, remembers the app, and keeps the last 200 actions", () => {
    const doc = new Y.Doc();
    expect(isDesktopDoc(doc)).toBe(false);
    initDesktop(doc, { app: "firefox" });
    expect(readDesktopState(doc)).toEqual({
      status: "stopped",
      screen: { width: 1024, height: 768 },
      app: "firefox",
    });
    setDesktopStatus(doc, "running", { width: 1280, height: 800 });
    for (let i = 0; i < 205; i++) {
      recordAction(doc, juno, "click", `${i}`, "2026-10-17T00:00:00.000Z");
    }
    recordAction(
      doc,
      juno,
      "open",
      "https://example.com",
      "2026-10-17T00:00:01.000Z"
    );
    expect(readActions(doc, 3).map((a) => a.detail)).toEqual([
      "203",
      "204",
      "https://example.com",
    ]);
    expect(readActions(doc, 1000)).toHaveLength(200);
    expect(readDesktopState(doc)).toEqual({
      status: "running",
      screen: { width: 1280, height: 800 },
      app: "https://example.com",
    });
  });

  it("maps X key names the E2B SDK would otherwise lowercase into nothing", () => {
    expect(
      ["Return", "KP_Enter", "BackSpace", "Page_Up", "ctrl", "s"].map(toE2bKey)
    ).toEqual(["enter", "enter", "BackSpace", "Page_Up", "ctrl", "s"]);
  });

  it("merges two actors' logs", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    initDesktop(a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    recordAction(a, juno, "type", "hello", "2026-10-17T00:00:00.000Z");
    recordAction(
      b,
      { kind: "human", id: "u1", name: "Hana" },
      "click",
      "ok",
      "2026-10-17T00:00:00.000Z"
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readActions(a)).toHaveLength(2);
    expect(readActions(b)).toEqual(readActions(a));
  });
});
