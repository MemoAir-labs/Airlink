import { describe, expect, it } from "vitest";

import type { LiveAccess, LiveAction, LiveTokenClaims } from "./index.ts";
import { authorize } from "./index.ts";

const claims = (
  kind: "human" | "agent",
  access: LiveAccess,
  docName = "ldoc_1"
): LiveTokenClaims => ({
  actor: { kind, id: `${kind}-1`, name: kind },
  workspaceId: "w1",
  docName,
  access,
});

describe("authorize", () => {
  it("answers every action for every kind and access the same way the routes used to", () => {
    const table: [string, LiveAccess, LiveAction, boolean][] = [
      ["human", "read", "read", true],
      ["human", "read", "write", false],
      ["human", "read", "comment", false],
      ["human", "suggest", "comment", true],
      ["human", "suggest", "write", false],
      ["human", "suggest", "drive", false],
      ["human", "write", "write", true],
      ["human", "write", "restore", true],
      ["human", "write", "drive", true],
      ["human", "write", "agent_ops", false],
      ["agent", "read", "agent_ops", false],
      ["agent", "suggest", "agent_ops", true],
      ["agent", "write", "agent_ops", true],
      ["agent", "write", "restore", true],
    ];
    for (const [kind, access, action, expected] of table) {
      expect(
        authorize(
          claims(kind === "agent" ? "agent" : "human", access),
          "ldoc_1",
          action
        ).ok,
        `${kind} ${access} ${action}`
      ).toBe(expected);
    }
  });

  it("refuses a token minted for another doc before looking at access", () => {
    expect(
      authorize(claims("human", "write", "ldoc_2"), "ldoc_1", "read")
    ).toEqual({
      ok: false,
      reason: "wrong_doc",
    });
  });
});
