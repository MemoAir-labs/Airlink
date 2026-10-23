import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  appendMessageText,
  editMessage,
  isChatDoc,
  postMessage,
  react,
  readLastAdded,
  readMessages,
} from "./index.ts";

const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
const hana = { kind: "human" as const, id: "u1", name: "Hana" };

function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe("chat", () => {
  it("reads the latest-arrived messages even when a poster's clock is behind", () => {
    const doc = new Y.Doc();
    postMessage(doc, { id: "m1", text: "first", ts: 5000 }, hana);
    postMessage(doc, { id: "m2", text: "slow clock", ts: 1000 }, juno);

    expect(readLastAdded(doc, 1).map((message) => message.id)).toEqual(["m2"]);
    expect(readLastAdded(doc, 100).map((message) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(
      readMessages(doc, { limit: 1 }).map((message) => message.id)
    ).toEqual(["m1"]);
  });

  it("orders concurrent posts by ts, then id, the same on every peer", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    postMessage(a, { id: "m-b", text: "from a", ts: 1000 }, hana);
    postMessage(b, { id: "m-a", text: "from b", ts: 1000 }, juno);
    postMessage(b, { id: "m-0", text: "earlier", ts: 999 }, juno);
    sync(a, b);
    const order = (doc: Y.Doc) => readMessages(doc).map((m) => m.id);
    expect(order(a)).toEqual(["m-0", "m-a", "m-b"]);
    expect(order(b)).toEqual(order(a));
    expect(isChatDoc(a)).toBe(true);
    expect(isChatDoc(new Y.Doc())).toBe(false);
  });

  it("round-trips mention chips and attachments", () => {
    const doc = new Y.Doc();
    const posted = postMessage(
      doc,
      {
        text: "ping",
        mentions: [juno],
        attachments: [{ docName: "doc:1", title: "Quote" }],
      },
      hana
    );
    expect(posted).toEqual({ ok: true, id: expect.any(String) });
    expect(readMessages(doc)).toMatchObject([
      {
        actor: hana,
        text: "ping",
        mentions: [{ kind: "agent", id: "juno", name: "Juno" }],
        attachments: [{ docName: "doc:1", title: "Quote" }],
        reactions: {},
      },
    ]);
  });

  it("refuses an edit by another actor and keeps the author's edit", () => {
    const doc = new Y.Doc();
    postMessage(doc, { id: "m1", text: "draft", ts: 1 }, hana);
    expect(editMessage(doc, "m1", "hijack", juno)).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(editMessage(doc, "missing", "x", hana)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(editMessage(doc, "m1", "final", hana)).toEqual({
      ok: true,
      id: "m1",
    });
    expect(readMessages(doc)[0]).toMatchObject({
      text: "final",
      editedAt: expect.any(Number),
    });
  });

  it("streams by appending, reads since a time, and toggles reactions", () => {
    const doc = new Y.Doc();
    postMessage(doc, { id: "m1", text: "", ts: 10 }, juno);
    postMessage(doc, { id: "m2", text: "later", ts: 20 }, hana);
    expect(appendMessageText(doc, "m1", "Hel", juno)).toEqual({
      ok: true,
      id: "m1",
    });
    appendMessageText(doc, "m1", "lo", juno);
    expect(appendMessageText(doc, "m1", "!", hana)).toEqual({
      ok: false,
      error: "not_author",
    });
    expect(readMessages(doc).map((m) => m.text)).toEqual(["Hello", "later"]);
    expect(readMessages(doc, { since: 10 }).map((m) => m.id)).toEqual(["m2"]);
    expect(readMessages(doc, { limit: 1 }).map((m) => m.id)).toEqual(["m2"]);

    react(doc, "m2", "👍", juno);
    react(doc, "m2", "👍", hana);
    react(doc, "m2", "👍", juno);
    expect(readMessages(doc)[1].reactions).toEqual({ "👍": ["u1"] });
    expect(react(doc, "nope", "👍", hana)).toEqual({
      ok: false,
      error: "not_found",
    });
  });
});
