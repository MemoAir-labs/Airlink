import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  addTranscript,
  initMedia,
  readHuddleTranscript,
  readTranscript,
  startHuddle,
} from "./index.ts";
import { createMediaTokens } from "./server.ts";

const hana = { kind: "human" as const, id: "u1", name: "Hana" };
const juno = { kind: "agent" as const, id: "a1", name: "Juno" };

describe("media", () => {
  it("mints a join token an agent cannot widen, and rejects a foreign one", async () => {
    const tokens = createMediaTokens({ apiKey: "devkey", apiSecret: "secret" });
    const token = await tokens.mint({
      room: "ldoc_1",
      actor: juno,
      canPublish: true,
      canSubscribe: true,
    });
    expect(await tokens.verify(token)).toEqual({
      room: "ldoc_1",
      identity: "a1",
      name: "Juno",
      kind: "agent",
      canPublish: true,
      canSubscribe: true,
    });
    const listenOnly = await tokens.mint({
      room: "ldoc_1",
      actor: hana,
      canPublish: false,
      canSubscribe: true,
    });
    expect((await tokens.verify(listenOnly))?.canPublish).toBe(false);
    const other = createMediaTokens({ apiKey: "devkey", apiSecret: "other" });
    expect(await other.verify(token)).toBeNull();
  });

  it("replaces an interim transcript line with its final text, in place", () => {
    const doc = new Y.Doc();
    initMedia(doc, "ldoc_1");
    addTranscript(doc, {
      id: "s1",
      at: "t1",
      actor: hana,
      text: "we sho",
      final: false,
    });
    addTranscript(doc, {
      id: "s2",
      at: "t2",
      actor: juno,
      text: "I agree",
      final: true,
    });
    addTranscript(doc, {
      id: "s1",
      at: "t1",
      actor: hana,
      text: "we should ship",
      final: true,
    });
    expect(readTranscript(doc).map((l) => [l.id, l.text, l.final])).toEqual([
      ["s1", "we should ship", true],
      ["s2", "I agree", true],
    ]);
  });

  it("keeps the cut mark on a line an agent was interrupted in", () => {
    const doc = new Y.Doc();
    addTranscript(doc, {
      id: "a1",
      at: "2026-10-20T10:00:00.000Z",
      actor: { kind: "agent", id: "juno", name: "Juno" },
      text: "Q3 closed at four point two million, and the",
      final: true,
      cut: true,
    });
    expect(readTranscript(doc)[0]).toMatchObject({ id: "a1", cut: true });
  });

  it("shows a new huddle only the lines said since it started", () => {
    const doc = new Y.Doc();
    initMedia(doc, "ldoc_1");
    addTranscript(doc, {
      id: "s1",
      at: "2026-10-20T05:00:00.000Z",
      actor: hana,
      text: "last week's call",
      final: true,
    });
    startHuddle(doc, "2026-10-20T06:00:00.000Z");
    expect(readHuddleTranscript(doc)).toEqual([]);
    addTranscript(doc, {
      id: "s2",
      at: "2026-10-20T06:00:05.000Z",
      actor: juno,
      text: "new call",
      final: true,
    });
    expect(readHuddleTranscript(doc).map((l) => l.text)).toEqual(["new call"]);
    expect(readTranscript(doc)).toHaveLength(2);
  });
});
