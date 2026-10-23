import { Redis } from "@hocuspocus/extension-redis";
import type { Extension } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import type { BrowserProvider } from "@memo-air/browser/session";
import { canvasSuggestions, pendingCanvasSuggestions } from "@memo-air/canvas";
import { observeNewMessages } from "@memo-air/chat";
import type { Decide } from "@memo-air/decide";
import { noOpinion } from "@memo-air/decide";
import type { DesktopProvider } from "@memo-air/desktop/session";
import type { MediaSpeaker, MediaTokens } from "@memo-air/media/server";
import type { LiveAccess, LiveActor } from "@memo-air/protocol";
import { allows, systemActor, watchDocPrefix } from "@memo-air/protocol";
import {
  verifyLiveToken,
  verifyLiveWatchToken,
} from "@memo-air/protocol/tokens";
import { docFragment, readOutline, suggestionBlocks } from "@memo-air/richtext";
import { pendingSheetSuggestions, sheetSuggestions } from "@memo-air/sheet";
import { deckSuggestions, pendingSlideSuggestions } from "@memo-air/slides";
import { migrateCanvasDeck } from "@memo-air/slides/migrate";
import pg from "pg";
import type { Logger } from "pino";
import pino from "pino";
import * as Y from "yjs";

import type { LiveActivity } from "./activity.ts";
import { createActivity } from "./activity.ts";
import { createAgentOps } from "./agent_ops.ts";
import type { LiveBrowserRooms } from "./browser.ts";
import { createBrowserRooms } from "./browser.ts";
import type { LiveDesktopRooms } from "./desktop.ts";
import { createDesktopRooms } from "./desktop.ts";
import type { DocKind } from "./kind.ts";
import { kindOf } from "./kind.ts";
import type { LiveMediaRooms } from "./media.ts";
import { createMediaRooms } from "./media.ts";
import { createMetrics, isSyncUpdate } from "./metrics.ts";
import { createPersistence, settledStatus } from "./persistence.ts";
import { createPresence } from "./presence.ts";
import type { LiveTurns, Turn } from "./turns.ts";
import { createTurns } from "./turns.ts";

export { systemOneProvider } from "@memo-air/decide";
export type { Turn } from "./turns.ts";
export { docText, turnWebhook } from "./turns.ts";

export type LiveConnectionContext = {
  actor: LiveActor;
  access: LiveAccess;
  workspaceId: string;
  watchedDocNames?: string[];
  via?: "extension";
};

const isWatchDoc = (documentName: string) =>
  documentName.startsWith(watchDocPrefix);

function watchedDocNames(context: unknown): string[] {
  return isRecord(context) && Array.isArray(context.watchedDocNames)
    ? context.watchedDocNames.filter(
        (name): name is string => typeof name === "string"
      )
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function actorFromContext(context: unknown): LiveActor {
  if (isRecord(context) && isRecord(context.actor)) {
    const { kind, id, name } = context.actor;
    if (
      (kind === "human" || kind === "agent") &&
      typeof id === "string" &&
      typeof name === "string"
    ) {
      return { kind, id, name };
    }
  }
  return systemActor;
}

const migrationActor: LiveActor = {
  kind: "agent",
  id: "memoair",
  name: "Memoair",
};

function agentActor(id: string, name: string): LiveActor {
  return { kind: "agent", id, name };
}

// Only a doc's own kind can hold its suggestions; the rich-text ledger reads the fragment directly.
function kindSuggestions(document: Y.Doc, kind: DocKind) {
  switch (kind) {
    case "sheet":
      return {
        status: statusOf(sheetSuggestions(document).values()),
        pending: pendingSheetSuggestions(document),
      };
    case "canvas":
      return {
        status: statusOf(canvasSuggestions(document).values()),
        pending: pendingCanvasSuggestions(document),
      };
    case "slides":
      return {
        status: statusOf(deckSuggestions(document).values()),
        pending: pendingSlideSuggestions(document),
      };
    case "doc":
    case "browser":
    case "desktop":
    case "media":
    case "chat":
    case "space":
      return { status: new Map<string, string>(), pending: [] };
  }
}

function statusOf(
  suggestions: Iterable<{ id: string; status: string }>
): Map<string, string> {
  return new Map([...suggestions].map((s) => [s.id, s.status]));
}

function workspaceIdFromContext(context: unknown): string | null {
  return isRecord(context) && typeof context.workspaceId === "string"
    ? context.workspaceId
    : null;
}

function isRedisOrigin(origin: unknown): boolean {
  return isRecord(origin) && origin.source === "redis";
}

function redisExtension(redisUrl: string): Extension {
  const url = new URL(redisUrl);
  return new Redis({
    host: url.hostname,
    port: Number(url.port || 6379),
    options: {
      username: url.username || undefined,
      password: url.password || undefined,
    },
    prefix: "memoair-live",
  });
}

export function createLiveServer({
  databaseUrl,
  jwtSecret,
  redisUrl,
  browserProvider = null,
  desktopProvider = null,
  media = null,
  decide = noOpinion,
  onTurn = null,
  onSpoken = null,
  onStored = null,
  browserHistoryFrames,
  turnSettleMs,
  port,
  address,
  logger = pino({ name: "live-server" }),
}: {
  databaseUrl: string;
  jwtSecret: string;
  redisUrl?: string;
  browserProvider?: BrowserProvider | null;
  desktopProvider?: DesktopProvider | null;
  media?: {
    url: string;
    tokens: MediaTokens;
    speaker: MediaSpeaker | null;
  } | null;
  decide?: Decide;
  onTurn?: ((turn: Turn) => Promise<void>) | null;
  // A person's finished line in a call, for a host whose agents answer by voice.
  onSpoken?: ((turn: Turn) => Promise<void>) | null;
  // After a doc's changes are saved (debounced), for a host that keeps a derived copy such as a
  // search index. A failure is logged and never blocks the save.
  onStored?: ((docName: string, document: Y.Doc) => Promise<void>) | null;
  // Screenshots kept per browser and desktop for the frames history route, one per navigation and
  // one per 10 s of change (default 500); a host that never reads them passes 0.
  browserHistoryFrames?: number;
  turnSettleMs?: number;
  port: number;
  // Defaults to every interface; a host on a person's machine passes its loopback address.
  address?: string;
  logger?: Logger;
}) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const persistence = createPersistence({
    pool,
    logger,
    maxFramesPerDoc: browserHistoryFrames,
  });

  const logEvent = (
    docName: string,
    type: string,
    context: unknown,
    payload: Record<string, unknown> = {}
  ) => {
    const actor = actorFromContext(context);
    persistence
      .logEvent(docName, type, actor, payload)
      .catch((err) =>
        logger.error({ err, docName, type }, "live: event failed")
      );
    turns.consider(docName, type, actor, payload);
  };

  // ponytail: a settled suggestion is attributed to the doc's last writer before the store, not to
  // the exact transaction author; upgrade by settling through an explicit, authenticated op.
  const reconcileSuggestions = async (
    docName: string,
    document: Y.Doc,
    lastContext: unknown
  ) => {
    const workspaceId = workspaceIdFromContext(lastContext);
    if (!workspaceId) {
      return;
    }
    const fragment = docFragment(document);
    const presentBlockIds = new Set(
      readOutline(fragment).map((block) => block.blockId)
    );
    const { status: storedStatus, pending } = kindSuggestions(
      document,
      kindOf(document)
    );
    try {
      const settled = await persistence.reconcileSuggestions(
        docName,
        workspaceId,
        [
          ...suggestionBlocks(fragment).map((suggestion) => ({
            id: suggestion.id,
            actor: agentActor(suggestion.actorId, suggestion.actorName),
            approverId: suggestion.approverId ?? null,
            approverName: suggestion.approver ?? null,
            insertBlockIds: suggestion.insertBlockIds,
            deleteBlockIds: suggestion.deleteBlockIds,
          })),
          ...pending.map((suggestion) => ({
            id: suggestion.id,
            actor: agentActor(suggestion.actorId, suggestion.actorName),
            approverId: suggestion.approverId ?? null,
            approverName: suggestion.approver ?? null,
            insertBlockIds: [],
            deleteBlockIds: [],
          })),
        ],
        (row) => {
          const status = storedStatus.get(row.id);
          return status === "accepted" || status === "rejected"
            ? status
            : settledStatus(row, presentBlockIds);
        },
        actorFromContext(lastContext)
      );
      for (const { id, status } of settled) {
        logEvent(docName, `suggestion_${status}`, lastContext, {
          suggestionId: id,
        });
      }
      await activity.refreshPending(docName, workspaceId);
    } catch (err) {
      logger.error({ err, docName }, "live: suggestion reconcile failed");
    }
  };

  const metrics = createMetrics({
    connections: () => server.hocuspocus.getConnectionsCount(),
    rooms: () => server.hocuspocus.getDocumentsCount(),
  });
  const handleStartedAt = new WeakMap<Uint8Array, number>();

  let handleAgentRequest: ReturnType<typeof createAgentOps> | null = null;
  let activity: LiveActivity;
  let turns: LiveTurns;
  let browserRooms: LiveBrowserRooms;
  let desktopRooms: LiveDesktopRooms;
  let mediaRooms: LiveMediaRooms;

  const server = new Server<LiveConnectionContext>({
    port,
    ...(address ? { address } : {}),
    quiet: true,
    stopOnSignals: false,
    extensions: redisUrl ? [redisExtension(redisUrl)] : [],

    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (isWatchDoc(documentName)) {
        const watch = verifyLiveWatchToken(token, jwtSecret);
        if (!watch || documentName !== `${watchDocPrefix}${watch.watchId}`) {
          throw new Error("live: unauthorized");
        }
        connectionConfig.readOnly = true;
        return {
          actor: watch.actor,
          access: "read",
          workspaceId: watch.workspaceId,
          watchedDocNames: watch.docNames,
        };
      }
      const claims = verifyLiveToken(token, jwtSecret);
      if (!claims || !allows(claims, documentName, "read")) {
        throw new Error("live: unauthorized");
      }
      // Only `write` may change the doc over the socket; `suggest` goes through ops and comments,
      // which turn every change into a suggestion or a thread.
      connectionConfig.readOnly = !allows(claims, documentName, "write");
      return {
        actor: claims.actor,
        access: claims.access,
        workspaceId: claims.workspaceId,
        ...(claims.via === "extension" && claims.access === "write"
          ? { via: claims.via }
          : {}),
      };
    },

    async onLoadDocument({ documentName }) {
      if (isWatchDoc(documentName)) {
        return undefined;
      }
      const startedAt = performance.now();
      const state = await persistence.load(documentName);
      metrics.loadMs.observe(performance.now() - startedAt);
      if (!state) {
        return undefined;
      }
      // P4 decks were Excalidraw frames; convert them once, logged as their own update so the
      // log before it is the restore point.
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const before = Y.encodeStateVector(doc);
      if (!migrateCanvasDeck(doc)) {
        return state;
      }
      persistence.append(
        documentName,
        Y.encodeStateAsUpdate(doc, before),
        migrationActor
      );
      persistence
        .logEvent(documentName, "migrated_slides", migrationActor, {})
        .catch((err) =>
          logger.error({ err, documentName }, "live: migration event failed")
        );
      return Y.encodeStateAsUpdate(doc);
    },

    async afterLoadDocument({ documentName, document }) {
      if (isWatchDoc(documentName)) {
        return;
      }
      observeNewMessages(document, (message, origin) => {
        if (!isRedisOrigin(origin)) {
          turns.noteMessage(documentName, message);
        }
      });
    },

    async beforeHandleMessage({ update }) {
      if (isSyncUpdate(update)) {
        handleStartedAt.set(update, performance.now());
      }
    },

    async afterHandleMessage({ update }) {
      const startedAt = handleStartedAt.get(update);
      if (startedAt !== undefined) {
        metrics.fanoutMs.observe(performance.now() - startedAt);
      }
    },

    async onChange({ update, context, documentName, transactionOrigin }) {
      if (isRedisOrigin(transactionOrigin) || isWatchDoc(documentName)) {
        return;
      }
      const actor = actorFromContext(context);
      persistence.append(documentName, update, actor);
      activity.noteWorkspace(documentName, workspaceIdFromContext(context));
      turns.noteWorkspace(documentName, workspaceIdFromContext(context));
      if (actor.id !== systemActor.id) {
        activity.noteEdit(documentName, actor);
        turns.noteEdit(documentName, actor);
      }
    },

    async connected({ documentName, context, instance, connection }) {
      if (isWatchDoc(documentName)) {
        activity.watch(documentName, watchedDocNames(context));
        return;
      }
      logEvent(documentName, "join", context);
      activity.noteWorkspace(documentName, workspaceIdFromContext(context));
      turns.noteWorkspace(documentName, workspaceIdFromContext(context));
      activity.schedule(documentName);
      const document = instance.documents.get(documentName);
      if (isRecord(context) && context.via === "extension") {
        browserRooms.attachExtension(
          documentName,
          connection,
          actorFromContext(context)
        );
      }
      if (document) {
        browserRooms
          .join(documentName, document, connection)
          .catch((err) =>
            logger.error({ err, documentName }, "live: browser join failed")
          );
        desktopRooms
          .join(documentName, document, connection)
          .catch((err) =>
            logger.error({ err, documentName }, "live: desktop join failed")
          );
      }
    },

    async onDisconnect({ documentName, context, socketId }) {
      if (isWatchDoc(documentName)) {
        activity.unwatch(documentName, watchedDocNames(context));
        return;
      }
      if (isRecord(context) && context.via === "extension") {
        browserRooms.detachExtension(documentName, socketId);
      }
      logEvent(documentName, "leave", context);
      activity.schedule(documentName);
      browserRooms.leave(documentName);
      desktopRooms.leave(documentName);
    },

    async onStateless({ documentName, document, connection, payload }) {
      if (isWatchDoc(documentName)) {
        return;
      }
      const handled = await browserRooms.handleInput(
        documentName,
        document,
        connection,
        payload
      );
      if (!handled) {
        const desktopHandled = await desktopRooms.handleInput(
          documentName,
          document,
          connection,
          payload
        );
        if (!desktopHandled) {
          await mediaRooms.handleInput(
            documentName,
            document,
            connection,
            payload
          );
        }
      }
    },

    async onAwarenessUpdate({ documentName }) {
      if (!isWatchDoc(documentName)) {
        activity.schedule(documentName);
      }
    },

    async afterStoreDocument({ documentName, document, lastContext }) {
      if (isWatchDoc(documentName)) {
        return;
      }
      await persistence.compactIfNeeded(documentName, document);
      await reconcileSuggestions(documentName, document, lastContext);
      await onStored?.(documentName, document).catch((err) =>
        logger.error({ err, docName: documentName }, "live: onStored failed")
      );
    },

    async afterUnloadDocument({ documentName }) {
      activity.forget(documentName);
      browserRooms.unloaded(documentName);
      desktopRooms.unloaded(documentName);
    },

    async onRequest({ request, response }) {
      if (request.url === "/healthz") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("ok");
        // Hocuspocus treats an empty rejection as "handled" and skips its default response.
        return Promise.reject();
      }
      if (request.url === "/metrics") {
        response.writeHead(200, {
          "Content-Type": metrics.registry.contentType,
        });
        response.end(await metrics.registry.metrics());
        return Promise.reject();
      }
      if (await handleAgentRequest?.(request, response)) {
        return Promise.reject();
      }
    },
  });

  activity = createActivity({
    hocuspocus: server.hocuspocus,
    persistence,
    logger,
  });
  turns = createTurns({
    hocuspocus: server.hocuspocus,
    persistence,
    decide,
    onTurn,
    metrics,
    logger,
    ...(turnSettleMs !== undefined ? { settleMs: turnSettleMs } : {}),
  });

  const logActorEvent = (
    docName: string,
    type: string,
    actor: LiveActor,
    payload: Record<string, unknown>
  ) => {
    persistence
      .logEvent(docName, type, actor, payload)
      .catch((err) =>
        logger.error({ err, docName, type }, "live: event failed")
      );
    turns.consider(docName, type, actor, payload);
  };
  const presence = createPresence({ activity });
  browserRooms = createBrowserRooms({
    hocuspocus: server.hocuspocus,
    persistence,
    activity,
    presence,
    provider: browserProvider,
    metrics,
    logger,
    logEvent: logActorEvent,
  });

  desktopRooms = createDesktopRooms({
    hocuspocus: server.hocuspocus,
    persistence,
    activity,
    presence,
    provider: desktopProvider,
    logger,
    logEvent: logActorEvent,
  });

  mediaRooms = createMediaRooms({
    hocuspocus: server.hocuspocus,
    activity,
    tokens: media?.tokens ?? null,
    liveKitUrl: media?.url ?? null,
    speaker: media?.speaker ?? null,
    logger,
    logEvent: logActorEvent,
    onSpoken: (docName, claims, text) =>
      void onSpoken?.({
        docName,
        workspaceId: claims.workspaceId,
        event: {
          type: "spoken",
          actor: claims.actor,
          payload: { text },
          summary: text,
        },
        decision: null,
      }).catch((err) =>
        logger.error({ err, docName }, "media: spoken turn failed")
      ),
  });

  handleAgentRequest = createAgentOps({
    hocuspocus: server.hocuspocus,
    persistence,
    activity,
    presence,
    browserRooms,
    desktopRooms,
    mediaRooms,
    turns,
    jwtSecret,
    metrics,
    logger,
    logEvent: logActorEvent,
  });

  return {
    server,
    hocuspocus: server.hocuspocus,
    persistence,
    async listen() {
      await persistence.init();
      await server.listen();
      return server.address.port;
    },
    async destroy() {
      turns.destroy();
      await browserRooms.destroy();
      await desktopRooms.destroy();
      await server.destroy();
      await persistence.close();
      await pool.end();
    },
  };
}
