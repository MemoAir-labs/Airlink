import { verifyLiveToken } from "@memo-air/protocol/tokens";
import { describe, expect, it } from "vitest";

import { tokenFor } from "./server.ts";

const secret = "test-secret";
const request = (query: string) =>
  tokenFor(new URL(`http://localhost/api/token?${query}`), secret);

describe("token endpoint", () => {
  it("signs a five-minute write token for one of the room's docs", () => {
    const result = request("doc=room-sheet&id=guest-1&name=Ada");
    if (result.status !== 200) {
      throw new Error(result.body.error);
    }
    expect(verifyLiveToken(result.body.token, secret)).toEqual({
      actor: { kind: "human", id: "guest-1", name: "Ada" },
      workspaceId: "airlink-room",
      docName: "room-sheet",
      access: "write",
    });
    const claims = JSON.parse(
      Buffer.from(result.body.token.split(".")[1] ?? "", "base64url").toString()
    );
    expect(claims.exp - claims.iat).toBe(300);
  });

  it("refuses a doc outside the room, a bad id and a missing name", () => {
    expect(request("doc=elsewhere&id=guest-1&name=Ada").status).toBe(400);
    expect(request("doc=room-sheet&id=a/b&name=Ada").status).toBe(400);
    expect(request("doc=room-sheet&id=guest-1&name=%20%20").status).toBe(400);
    expect(request("doc=room-sheet&id=guest-1").status).toBe(400);
  });

  it("cuts a long name to 40 characters", () => {
    const result = request(`doc=room-notes&id=guest-1&name=${"a".repeat(500)}`);
    if (result.status !== 200) {
      throw new Error(result.body.error);
    }
    expect(verifyLiveToken(result.body.token, secret)?.actor.name).toBe(
      "a".repeat(40)
    );
  });
});
