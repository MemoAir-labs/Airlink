import type { IncomingMessage, ServerResponse } from "node:http";
import { signLiveToken } from "@memo-air/protocol/tokens";

import { roomDocs } from "./src/room.ts";

const workspaceId = "airlink-room";
const idPattern = /^[A-Za-z0-9_-]{1,40}$/;
const tokenLifetimeSeconds = 300;

export type TokenResult =
  | { status: 200; body: { token: string } }
  | { status: 400; body: { error: string } };

// Signs a five-minute write token for one of the room's docs. A stand-in for your own auth: as
// written, anyone who reaches the dev server gets in, under any name.
export function tokenFor(url: URL, secret: string): TokenResult {
  const docName = url.searchParams.get("doc") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 40);
  if (
    !roomDocs.some((doc) => doc.sId === docName) ||
    !idPattern.test(id) ||
    !name
  ) {
    return {
      status: 400,
      body: { error: "Unknown doc, or a missing id or name." },
    };
  }
  const token = signLiveToken(
    {
      actor: { kind: "human", id, name },
      workspaceId,
      docName,
      access: "write",
    },
    secret,
    tokenLifetimeSeconds
  );
  return { status: 200, body: { token } };
}

export const tokenMiddleware =
  (secret: string) =>
  (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (!request.url?.startsWith("/api/token")) {
      next();
      return;
    }
    const { status, body } = tokenFor(
      new URL(request.url, "http://localhost"),
      secret
    );
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
