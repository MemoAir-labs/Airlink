import { describe, expect, it } from "vitest";

import { isSyncUpdate } from "./metrics.ts";

// lib0 encoding: varString is varUint(length) + utf8 bytes; varUint is 7 bits per byte, high bit
// set on every byte but the last.
const frame = (bytes: number[]) =>
  Uint8Array.from([3, 0x64, 0x6f, 0x63, ...bytes]);

describe("isSyncUpdate", () => {
  it("accepts only sync update frames", () => {
    expect(isSyncUpdate(frame([0, 2, 1, 5]))).toBe(true);
    expect(isSyncUpdate(frame([0, 0, 1, 0]))).toBe(false);
    expect(isSyncUpdate(frame([0, 1, 1, 0]))).toBe(false);
    expect(isSyncUpdate(frame([1, 2]))).toBe(false);
    expect(isSyncUpdate(frame([5, 2]))).toBe(false);
    expect(isSyncUpdate(Uint8Array.from([0x80 | 1, 1, 0]))).toBe(false);
    expect(isSyncUpdate(new Uint8Array())).toBe(false);
  });
});
