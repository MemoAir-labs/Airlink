import { describe, expect, it } from "vitest";

import { percentiles } from "./stats.ts";

describe("percentiles", () => {
  it("interpolates linearly between order statistics", () => {
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      p50: 5.5,
      p95: 9.55,
      p99: 9.91,
      n: 10,
    });
    expect(percentiles([3, 1, 2])).toEqual({
      p50: 2,
      p95: 2.9,
      p99: 2.98,
      n: 3,
    });
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, n: 0 });
  });
});
