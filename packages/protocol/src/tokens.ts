import type {
  LiveServiceClaims,
  LiveTokenClaims,
  LiveWatchClaims,
} from "@memo-air/protocol";
import {
  liveServiceClaimsSchema,
  liveTokenClaimsSchema,
  liveWatchClaimsSchema,
} from "@memo-air/protocol";
import jwt from "jsonwebtoken";
import type { z } from "zod";

// Signing and verifying live tokens is server-only: this entry pulls in jsonwebtoken, which must
// never reach a browser bundle. Browsers import the schemas from the package root.

export function signLiveToken(
  claims: LiveTokenClaims,
  secret: string,
  expiresInSeconds = 300
): string {
  return jwt.sign(claims, secret, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
  });
}

function verifyClaims<T>(
  token: string,
  secret: string,
  schema: z.ZodType<T>
): T | null {
  let raw: unknown;
  try {
    raw = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function verifyLiveToken(
  token: string,
  secret: string
): LiveTokenClaims | null {
  return verifyClaims(token, secret, liveTokenClaimsSchema);
}

export function signLiveServiceToken(
  workspaceId: string,
  secret: string,
  expiresInSeconds = 60
): string {
  return jwt.sign({ scope: "service", workspaceId }, secret, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
  });
}

export function verifyLiveServiceToken(
  token: string,
  secret: string
): LiveServiceClaims | null {
  return verifyClaims(token, secret, liveServiceClaimsSchema);
}

export function signLiveWatchToken(
  claims: Omit<LiveWatchClaims, "scope">,
  secret: string,
  expiresInSeconds = 300
): string {
  return jwt.sign({ ...claims, scope: "watch" }, secret, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
  });
}

export function verifyLiveWatchToken(
  token: string,
  secret: string
): LiveWatchClaims | null {
  return verifyClaims(token, secret, liveWatchClaimsSchema);
}
