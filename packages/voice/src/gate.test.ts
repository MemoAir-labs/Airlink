import { describe, expect, it } from "vitest";

import { isBargeIn } from "./gate.ts";

describe("isBargeIn", () => {
  it("stops an agent for real words held long enough, not for backchannels, coughs or blips", () => {
    expect(
      isBargeIn({ voicedMs: 600, words: "wait, that's the wrong quarter" })
    ).toBe(true);
    expect(isBargeIn({ voicedMs: 600, words: "mm-hm" })).toBe(false);
    expect(isBargeIn({ voicedMs: 700, words: "yeah, right" })).toBe(false);
    expect(isBargeIn({ voicedMs: 900, words: "" })).toBe(false);
    expect(isBargeIn({ voicedMs: 200, words: "stop" })).toBe(false);
  });
});
