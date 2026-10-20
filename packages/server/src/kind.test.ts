import { initBrowser } from "@memo-air/browser";
import { addShapes } from "@memo-air/canvas";
import { postMessage } from "@memo-air/chat";
import { initDesktop } from "@memo-air/desktop";
import { initMedia } from "@memo-air/media";
import { docFragment, insertBlocks } from "@memo-air/richtext";
import { setRange } from "@memo-air/sheet";
import { addSlide } from "@memo-air/slides";
import { placeObject } from "@memo-air/space";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { isBlank, kindOf } from "./kind.ts";

describe("kindOf", () => {
  it("names a doc by the content its roots hold", () => {
    const blank = new Y.Doc();
    expect(kindOf(blank)).toBe("doc");
    expect(isBlank(blank)).toBe(true);

    const text = new Y.Doc();
    insertBlocks(docFragment(text), null, "# Plan");
    expect(kindOf(text)).toBe("doc");
    expect(isBlank(text)).toBe(false);

    const sheet = new Y.Doc();
    setRange(sheet, "A1", [["1"]]);
    expect(kindOf(sheet)).toBe("sheet");
    expect(isBlank(sheet)).toBe(false);

    const browser = new Y.Doc();
    initBrowser(browser, { url: "https://example.com" });
    expect(kindOf(browser)).toBe("browser");

    const canvas = new Y.Doc();
    addShapes(canvas, [{ type: "rectangle", x: 0, y: 0 }]);
    expect(kindOf(canvas)).toBe("canvas");

    const deck = new Y.Doc();
    addSlide(deck, { title: "One" });
    expect(kindOf(deck)).toBe("slides");

    const desktop = new Y.Doc();
    initDesktop(desktop);
    expect(kindOf(desktop)).toBe("desktop");

    const media = new Y.Doc();
    initMedia(media, "room");
    expect(kindOf(media)).toBe("media");
  });

  it("names a space by its first object", () => {
    const space = new Y.Doc();
    expect(isBlank(space)).toBe(true);
    placeObject(
      space,
      { docName: "ldoc_a", kind: "doc", title: "Brief" },
      { kind: "agent", id: "juno", name: "Juno" }
    );
    expect(kindOf(space)).toBe("space");
    expect(isBlank(space)).toBe(false);
  });

  it("names a chat by its first message", () => {
    const chat = new Y.Doc();
    expect(isBlank(chat)).toBe(true);
    postMessage(chat, { text: "hi" }, { kind: "human", id: "h", name: "H" });
    expect(kindOf(chat)).toBe("chat");
    expect(isBlank(chat)).toBe(false);
  });

  it("counts a doc that holds only suggestions as its kind", () => {
    const actor = { id: "juno", name: "Juno" };
    const canvas = new Y.Doc();
    addShapes(canvas, [{ type: "rectangle", x: 0, y: 0 }], {
      actor: { kind: "agent", ...actor },
      suggest: { id: "s1", actor },
    });
    expect(kindOf(canvas)).toBe("canvas");
    expect(isBlank(canvas)).toBe(false);

    const deck = new Y.Doc();
    addSlide(
      deck,
      { title: "One" },
      {
        actor: { kind: "agent", ...actor },
        suggest: { id: "s2", actor },
      }
    );
    expect(kindOf(deck)).toBe("slides");
  });

  it("ignores roots a reader created without writing", () => {
    const text = new Y.Doc();
    insertBlocks(docFragment(text), null, "# Plan");
    text.getArray("sheetRows");
    text.getMap("canvasElements");
    expect(kindOf(text)).toBe("doc");
  });
});
