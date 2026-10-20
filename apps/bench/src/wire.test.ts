import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  authMessage,
  parseFrame,
  stampKeyFor,
  syncStepOneMessage,
  updateMessage,
} from "./wire.ts";

const updateFor = (keys: string[]) => {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const key of keys) {
      doc.getMap("bench").set(key, 1);
    }
  });
  return Y.encodeStateAsUpdate(doc);
};

describe("wire", () => {
  it("reads every stamp off an update frame without applying it", () => {
    const update = updateFor([
      stampKeyFor(3, 0, 1760000000123),
      stampKeyFor(12, 7, 1760000000456),
    ]);
    expect(
      parseFrame(updateMessage("bench:room-1-x".repeat(20), update))
    ).toEqual({
      type: "update",
      stamps: [
        { client: 3, sentAtMs: 1760000000123 },
        { client: 12, sentAtMs: 1760000000456 },
      ],
    });
  });

  it("does not mistake sync step one or auth frames for updates", () => {
    expect(parseFrame(syncStepOneMessage("d"))).toEqual({ type: "other" });
    expect(parseFrame(authMessage("d", "t"))).toEqual({ type: "other" });
    expect(parseFrame(Uint8Array.from([1, 100, 2, 1, 2, 110, 111]))).toEqual({
      type: "denied",
      reason: "no",
    });
    expect(parseFrame(Uint8Array.from([1, 100, 2, 2, 0]))).toEqual({
      type: "authenticated",
    });
  });
});
