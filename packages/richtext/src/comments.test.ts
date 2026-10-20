import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  addThread,
  deleteBlock,
  docFragment,
  insertBlocks,
  readOutline,
  readThreads,
  replyToThread,
  setThreadResolved,
} from "./index.ts";

const ada = { kind: "human" as const, id: "u1", name: "Ada" };
const juno = { kind: "agent" as const, id: "a1", name: "Juno" };

function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
}

describe("comments", () => {
  it("merges concurrent replies, resolves, and detaches when the block goes", () => {
    const a = new Y.Doc();
    insertBlocks(docFragment(a), null, "Intro.\n\nPrice: $10.");
    const [, price] = readOutline(docFragment(a)).map((block) => block.blockId);
    const threadId = addThread(a, {
      blockId: price,
      quote: "$10",
      actor: ada,
      body: "@Juno is this right?",
    });

    const b = new Y.Doc();
    sync(a, b);
    replyToThread(a, threadId, { actor: ada, body: "Also check tax." });
    replyToThread(b, threadId, { actor: juno, body: "It should be $12." });
    sync(a, b);
    sync(b, a);

    const [thread] = readThreads(a);
    expect(thread.messages.map((message) => message.body).sort()).toEqual([
      "@Juno is this right?",
      "Also check tax.",
      "It should be $12.",
    ]);
    expect(readThreads(b)[0].messages).toHaveLength(3);
    expect(thread).toMatchObject({
      quote: "$10",
      resolved: false,
      detached: false,
    });

    setThreadResolved(a, threadId, true);
    deleteBlock(docFragment(a), price);
    expect(readThreads(a)[0]).toMatchObject({ resolved: true, detached: true });
    expect(replyToThread(a, "missing", { actor: ada, body: "x" })).toBe(false);
  });
});
