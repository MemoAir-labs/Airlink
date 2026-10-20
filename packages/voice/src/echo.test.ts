import { describe, expect, it } from "vitest";

import { createEchoFilter } from "./echo.ts";

describe("echo filter", () => {
  it("drops a human line that repeats what an agent just said, and keeps real replies", () => {
    const echo = createEchoFilter();
    echo.agentSaid(
      "Yes, I can hear you. I'm here in the call and ready to help.",
      1000
    );
    expect(
      echo.isEcho(
        "Yes, TMKC, I can hear you. I'm here in the call and ready to help.",
        2500
      )
    ).toBe(true);
    expect(echo.isEcho("Great, can you pull the Q3 numbers?", 2500)).toBe(
      false
    );
    expect(echo.isEcho("Yes I can hear you here in the call", 60_000)).toBe(
      false
    );
  });
});
