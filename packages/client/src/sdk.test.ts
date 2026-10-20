import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { bindValue } from "./index.ts";

describe("sdk bind", () => {
  it("shares one value between two bound docs and keeps the first writer's initial", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const seenA: number[] = [];
    const seenB: number[] = [];
    const isNumber = (v: unknown): v is number => typeof v === "number";
    const bindA = bindValue(a, "counter", 1, isNumber, (v) => seenA.push(v));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const bindB = bindValue(b, "counter", 99, isNumber, (v) => seenB.push(v));
    expect(bindB.get()).toBe(1);
    bindB.set(5);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(bindA.get()).toBe(5);
    expect(seenA).toEqual([5]);
    bindA.set(7);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(seenB).toEqual([5, 7]);
    expect(seenA).toEqual([5, 7]);
    bindA.unbind();
    bindB.set(8);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(bindA.get()).toBe(8);
    expect(seenA).toEqual([5, 7]);
  });
});
