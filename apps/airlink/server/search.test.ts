import { describe, expect, it } from "vitest";
import { chunkText } from "./search.ts";

describe("chunkText", () => {
  it("splits at line ends, repeats the page marker in a part that starts mid-page, and cuts an overlong line", () => {
    const line = "x".repeat(1000);
    const parts = chunkText(
      `--- Page 1 ---\n${line}\n${line}\n--- Page 2 ---\n${"y".repeat(3200)}`
    );

    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe(`--- Page 1 ---\n${line}`);
    expect(parts[1]).toBe(`--- Page 1 ---\n${line}\n--- Page 2 ---`);
    expect(parts[2]).toBe(`--- Page 2 ---\n${"y".repeat(1500)}`);
    expect(parts[4]).toBe(`--- Page 2 ---\n${"y".repeat(200)}`);
  });

  it("returns nothing for empty text", () => {
    expect(chunkText("\n\n")).toEqual([]);
  });
});
