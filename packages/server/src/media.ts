import type { Connection, Document, Hocuspocus } from "@hocuspocus/server";
import {
  addTranscript,
  initMedia,
  isMediaDoc,
  readMediaState,
  readTranscript,
} from "@memo-air/media";
import type { MediaSpeaker, MediaTokens } from "@memo-air/media/server";
import type {
  LiveActor,
  LiveTokenClaims,
  MediaMessage,
  MediaTokenResponse,
  SpeakResponse,
  TranscriptRequest,
  TranscriptResponse,
} from "@memo-air/protocol";
import {
  allows,
  liveAccessSchema,
  liveActorSchema,
  mediaSignalInputSchema,
  speakRequestSchema,
  transcriptRequestSchema,
} from "@memo-air/protocol";
import type { Logger } from "pino";

import type { LiveActivity } from "./activity.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function claimsOf(
  connection: Connection,
  docName: string
): LiveTokenClaims | null {
  const context: unknown = connection.context;
  const actor = liveActorSchema.safeParse(
    isRecord(context) ? context.actor : null
  );
  const access = liveAccessSchema.safeParse(
    isRecord(context) ? context.access : null
  );
  if (!actor.success || !access.success) {
    return null;
  }
  return {
    actor: actor.data,
    access: access.data,
    docName,
    workspaceId:
      isRecord(context) && typeof context.workspaceId === "string"
        ? context.workspaceId
        : "",
  };
}

// A media room: the doc's LiveKit room, one participant per actor, join tokens capped by the
// actor's doc access, the transcript written into the doc line by line. An agent speaks through
// the server's speech engine when one is configured, otherwise each viewer voices its line.
export function createMediaRooms({
  hocuspocus,
  activity,
  tokens,
  liveKitUrl,
  speaker,
  logger,
  logEvent,
  onSpoken,
}: {
  hocuspocus: Hocuspocus;
  activity: LiveActivity;
  tokens: MediaTokens | null;
  liveKitUrl: string | null;
  speaker: MediaSpeaker | null;
  logger: Logger;
  logEvent: (
    docName: string,
    type: string,
    actor: LiveActor,
    payload: Record<string, unknown>
  ) => void;
  // A person finished a line in the call; the host decides whether an agent answers it.
  onSpoken: (docName: string, claims: LiveTokenClaims, text: string) => void;
}) {
  const broadcast = (docName: string, message: MediaMessage) => {
    hocuspocus.documents
      .get(docName)
      ?.broadcastStateless(JSON.stringify(message));
  };

  const presentIn = (docName: string): LiveActor[] => {
    const byId = new Map<string, LiveActor>();
    for (const connection of hocuspocus.documents
      .get(docName)
      ?.getConnections() ?? []) {
      const actor = liveActorSchema.safeParse(
        isRecord(connection.context) ? connection.context.actor : null
      );
      if (actor.success) {
        byId.set(actor.data.id, actor.data);
      }
    }
    return [...byId.values()];
  };

  const writeLine = async (
    docName: string,
    claims: LiveTokenClaims,
    line: TranscriptRequest
  ) => {
    const connection = await hocuspocus.openDirectConnection(docName, {
      actor: claims.actor,
      access: "write",
      workspaceId: claims.workspaceId,
    });
    try {
      await connection.transact((doc) => {
        if (!isMediaDoc(doc)) {
          initMedia(doc, docName);
        }
        addTranscript(doc, {
          id: line.id,
          text: line.text,
          final: line.final,
          ...(line.cut ? { cut: true } : {}),
          at: new Date().toISOString(),
          actor: claims.actor,
        });
      });
    } finally {
      await connection.disconnect();
    }
    if (line.final) {
      activity.noteEdit(docName, claims.actor);
      logEvent(docName, "spoke", claims.actor, { chars: line.text.length });
      if (
        claims.actor.kind === "human" &&
        line.text.trim() &&
        line.turn !== false
      ) {
        onSpoken(docName, claims, line.text.trim());
      }
    }
  };

  return {
    configured: tokens !== null && liveKitUrl !== null,

    // One LiveKit identity per actor, so a person is one participant in a call; a `viewer` tag
    // makes a second tab of the same person its own participant, since LiveKit disconnects the
    // earlier holder of a reused identity.
    async token(
      docName: string,
      claims: LiveTokenClaims,
      viewer: string | null = null
    ): Promise<{ status: number; body: unknown }> {
      if (!tokens || !liveKitUrl) {
        return {
          status: 503,
          body: { error: "No media server is configured on this server." },
        };
      }
      const canPublish = allows(claims, docName, "comment");
      const base =
        claims.actor.kind === "agent"
          ? `agent:${claims.actor.id}`
          : `user:${claims.actor.id}`;
      const identity = viewer ? `${base}:${viewer}` : base;
      const token = await tokens.mint({
        room: docName,
        actor: { ...claims.actor, id: identity },
        canPublish,
        canSubscribe: true,
      });
      const body: MediaTokenResponse = {
        url: liveKitUrl,
        token,
        identity,
        room: docName,
        canPublish,
      };
      return { status: 200, body };
    },

    async transcript(
      docName: string,
      claims: LiveTokenClaims
    ): Promise<{ status: number; body: unknown }> {
      const connection = await hocuspocus.openDirectConnection(docName, {
        actor: claims.actor,
        access: "read",
        workspaceId: claims.workspaceId,
      });
      try {
        const doc = connection.document;
        const body: TranscriptResponse = {
          room: docName,
          startedAt: doc ? readMediaState(doc).startedAt : null,
          present: presentIn(docName),
          lines: doc ? readTranscript(doc) : [],
        };
        return { status: 200, body };
      } finally {
        await connection.disconnect();
      }
    },

    async addLine(
      docName: string,
      claims: LiveTokenClaims,
      body: unknown
    ): Promise<{ status: number; body: unknown }> {
      const parsed = transcriptRequestSchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.message } };
      }
      await writeLine(docName, claims, parsed.data);
      return { status: 200, body: { id: parsed.data.id } };
    },

    async speak(
      docName: string,
      claims: LiveTokenClaims,
      body: unknown
    ): Promise<{ status: number; body: unknown }> {
      const parsed = speakRequestSchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.message } };
      }
      const id = crypto.randomUUID();
      await writeLine(docName, claims, {
        id,
        text: parsed.data.text,
        final: true,
      });
      let spoken: SpeakResponse["spoken"] = "clients";
      if (speaker && liveKitUrl && tokens) {
        try {
          const token = await tokens.mint({
            room: docName,
            actor: { ...claims.actor, id: `agent:${claims.actor.id}` },
            canPublish: true,
            canSubscribe: false,
          });
          await speaker.speak({
            url: liveKitUrl,
            token,
            text: parsed.data.text,
          });
          spoken = "server";
        } catch (err) {
          logger.warn(
            { err, docName },
            "live: server speech failed, clients voice it"
          );
        }
      }
      if (spoken === "clients") {
        broadcast(docName, {
          type: "media_speak",
          id,
          actor: claims.actor,
          text: parsed.data.text,
        });
      }
      const response: SpeakResponse = { id, spoken };
      return { status: 200, body: response };
    },

    // Perception signals (P8) come from each person's own browser and go to everyone in the
    // room and the log, never the pixels they were computed from.
    async handleInput(
      docName: string,
      _document: Document,
      connection: Connection,
      payload: string
    ): Promise<boolean> {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return false;
      }
      const input = mediaSignalInputSchema.safeParse(raw);
      if (!input.success) {
        return false;
      }
      const claims = claimsOf(connection, docName);
      if (!claims) {
        return true;
      }
      broadcast(docName, {
        type: "media_signal",
        actor: claims.actor,
        signal: input.data.signal,
        value: input.data.value,
        ...(input.data.score !== undefined ? { score: input.data.score } : {}),
      });
      logEvent(docName, `signal_${input.data.signal}`, claims.actor, {
        value: input.data.value,
        ...(input.data.score !== undefined ? { score: input.data.score } : {}),
      });
      return true;
    },
  };
}

export type LiveMediaRooms = ReturnType<typeof createMediaRooms>;
