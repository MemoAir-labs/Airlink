import { AccessToken, TokenVerifier } from "livekit-server-sdk";

import type { MediaActor } from "./index.ts";

export type MediaGrant = {
  room: string;
  actor: MediaActor;
  canPublish: boolean;
  canSubscribe: boolean;
  hidden?: boolean;
  ttlSeconds?: number;
};

export type MediaTokenClaims = {
  room: string;
  identity: string;
  name: string;
  kind: "human" | "agent";
  canPublish: boolean;
  canSubscribe: boolean;
};

// LiveKit is the media plane (G5): one room per live doc, one participant per actor, agents
// included. live-server mints the join token so an agent's rights never exceed its owner's.
export function createMediaTokens({
  apiKey,
  apiSecret,
}: {
  apiKey: string;
  apiSecret: string;
}) {
  const verifier = new TokenVerifier(apiKey, apiSecret);
  return {
    async mint({
      room,
      actor,
      canPublish,
      canSubscribe,
      hidden,
      ttlSeconds = 3600,
    }: MediaGrant): Promise<string> {
      const token = new AccessToken(apiKey, apiSecret, {
        identity: actor.id,
        name: actor.name,
        ttl: ttlSeconds,
        metadata: JSON.stringify({ kind: actor.kind }),
      });
      token.addGrant({
        room,
        roomJoin: true,
        canPublish,
        canSubscribe,
        canPublishData: true,
        hidden,
      });
      return token.toJwt();
    },

    async verify(token: string): Promise<MediaTokenClaims | null> {
      try {
        const claims = await verifier.verify(token);
        const grant = claims.video;
        let kind: "human" | "agent" = "human";
        try {
          const metadata: unknown = JSON.parse(claims.metadata ?? "{}");
          if (
            typeof metadata === "object" &&
            metadata !== null &&
            "kind" in metadata &&
            metadata.kind === "agent"
          ) {
            kind = "agent";
          }
        } catch {}
        if (!grant?.room || !claims.sub) {
          return null;
        }
        return {
          room: grant.room,
          identity: claims.sub,
          name: claims.name ?? claims.sub,
          kind,
          canPublish: grant.canPublish === true,
          canSubscribe: grant.canSubscribe !== false,
        };
      } catch {
        return null;
      }
    },
  };
}

export type MediaTokens = ReturnType<typeof createMediaTokens>;

export type { MediaSpeaker, TtsProvider } from "./speaker.ts";
export { liveKitSpeaker, openAiTts } from "./speaker.ts";
