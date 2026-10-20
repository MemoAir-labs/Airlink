import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";

import { signLiveToken, verifyLiveToken } from "./tokens.ts";

const claims = {
  actor: { kind: "human" as const, id: "u1", name: "Ada" },
  workspaceId: "w1",
  docName: "w1:ldoc_1",
  access: "write" as const,
};

describe("live tokens", () => {
  it("round-trips claims", () => {
    expect(verifyLiveToken(signLiveToken(claims, "s"), "s")).toEqual(claims);
  });

  it("rejects a wrong secret", () => {
    expect(verifyLiveToken(signLiveToken(claims, "s"), "other")).toBeNull();
  });

  it("rejects an expired token", () => {
    expect(verifyLiveToken(signLiveToken(claims, "s", -1), "s")).toBeNull();
  });

  it("rejects claims that fail the schema", () => {
    const token = jwt.sign({ ...claims, access: "admin" }, "s");
    expect(verifyLiveToken(token, "s")).toBeNull();
  });
});
