import type { Connection, Document, Hocuspocus } from "@hocuspocus/server";
import type { InputMux, Outline } from "@memo-air/browser";
import {
  addressToUrl,
  blankUrl,
  createInputMux,
  diffOutline,
  formatOutline,
  initBrowser,
  isBrowserDoc,
  readBrowserState,
  recordVisit,
} from "@memo-air/browser";
import type {
  BrowserLease,
  BrowserProvider,
  BrowserSession,
  PageInfo,
  ScreencastFrame,
} from "@memo-air/browser/session";
import {
  BrowserPoolExhausted,
  createBrowserSession,
} from "@memo-air/browser/session";
import type {
  BrowserInput,
  BrowserMessage,
  BrowserOp,
  BrowserOpsResponse,
  BrowserPage,
  BrowserVideoResponse,
  LiveActor,
  LiveTokenClaims,
} from "@memo-air/protocol";
import {
  allows,
  browserInputSchema,
  browserOpsRequestSchema,
  liveAccessSchema,
  liveActorSchema,
  systemActor,
} from "@memo-air/protocol";
import type { Logger } from "pino";
import type * as Y from "yjs";

import type { LiveActivity } from "./activity.ts";
import type { ExtensionSession } from "./extension_session.ts";
import { createExtensionSession } from "./extension_session.ts";
import type { LiveMetrics } from "./metrics.ts";
import type { LivePersistence } from "./persistence.ts";
import type { LivePresence } from "./presence.ts";

const idleStopMs = 120_000;
const keyframeIntervalMs = 10_000;
const jpegFallbackIntervalMs = 1000;
const typedBurstMs = 1000;
const maxRooms = 20;
const settleAfterActionMs = 400;

type RoomStatus = "starting" | "running" | "stopped" | "unavailable";

type Room = {
  docName: string;
  mux: InputMux;
  lease: BrowserLease | null;
  session: BrowserSession | null;
  starting: Promise<BrowserSession | null> | null;
  status: RoomStatus;
  error: string | null;
  page: PageInfo;
  driver: LiveActor;
  lastFrame: ScreencastFrame | null;
  lastFrameAt: number;
  lastJpegSentAt: number;
  inputAt: number;
  frameDirty: boolean;
  keyframeWanted: boolean;
  keyframeTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  lastOutline: Outline | null;
  typed: Map<string, { chars: number; timer: NodeJS.Timeout }>;
  // The person's own tab, when the extension is sharing it; it replaces the provider.
  extension: {
    session: ExtensionSession;
    connection: Connection;
    socketId: string;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function actorOf(connection: Connection): LiveActor | null {
  const context: unknown = connection.context;
  const parsed = liveActorSchema.safeParse(
    isRecord(context) ? context.actor : null
  );
  return parsed.success ? parsed.data : null;
}

// The claims a socket was opened with, rebuilt from its context so the same authorize() answers
// for socket input as for HTTP routes.
function claimsOf(
  connection: Connection,
  docName: string
): LiveTokenClaims | null {
  const context: unknown = connection.context;
  const actor = actorOf(connection);
  const access = liveAccessSchema.safeParse(
    isRecord(context) ? context.access : null
  );
  if (!actor || !access.success) {
    return null;
  }
  return {
    actor,
    access: access.data,
    docName,
    workspaceId:
      isRecord(context) && typeof context.workspaceId === "string"
        ? context.workspaceId
        : "",
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A room's browser: one Chromium context per doc, driven by whoever holds the input mux, watched
// by everyone connected to the doc. Pixels and input travel as stateless messages on the doc
// socket; where the page went is written into the doc as the driver, so History and the card work
// the way they do for every other kind.
export function createBrowserRooms({
  hocuspocus,
  persistence,
  activity,
  presence,
  provider,
  metrics,
  logger,
  logEvent,
}: {
  hocuspocus: Hocuspocus;
  persistence: LivePersistence;
  activity: LiveActivity;
  presence: LivePresence;
  provider: BrowserProvider | null;
  metrics: LiveMetrics;
  logger: Logger;
  logEvent: (
    docName: string,
    type: string,
    actor: LiveActor,
    payload: Record<string, unknown>
  ) => void;
}) {
  const rooms = new Map<string, Room>();

  const roomOf = (docName: string): Room => {
    const existing = rooms.get(docName);
    if (existing) {
      return existing;
    }
    const room: Room = {
      docName,
      mux: createInputMux(),
      lease: null,
      session: null,
      starting: null,
      status: provider ? "stopped" : "unavailable",
      error: provider ? null : "No browser is configured on this server.",
      page: { url: blankUrl, title: "" },
      driver: systemActor,
      lastFrame: null,
      lastFrameAt: 0,
      lastJpegSentAt: 0,
      inputAt: 0,
      frameDirty: false,
      keyframeWanted: false,
      keyframeTimer: null,
      stopTimer: null,
      lastOutline: null,
      typed: new Map(),
      extension: null,
    };
    rooms.set(docName, room);
    return room;
  };

  const gotFrame = (room: Room, frame: ScreencastFrame) => {
    const now = performance.now();
    if (room.lastFrameAt > 0) {
      metrics.frameIntervalMs.observe(now - room.lastFrameAt);
    }
    room.lastFrame = frame;
    room.lastFrameAt = now;
    room.frameDirty = true;
    if (room.inputAt > 0) {
      metrics.inputToFrameMs.observe(now - room.inputAt);
      room.inputAt = 0;
    }
    if (room.keyframeWanted) {
      room.keyframeWanted = false;
      void keyframe(room);
    }
    // With the browser's own video up, the JPEG stream is only the fallback and first paint, so
    // it goes out once a second instead of riding the doc socket at full rate next to the keystrokes.
    if (
      !hasVideo(room) ||
      now - room.lastJpegSentAt >= jpegFallbackIntervalMs
    ) {
      room.lastJpegSentAt = now;
      broadcast(room, { type: "browser_frame", ...frame });
    }
  };

  const hasVideo = (room: Room) =>
    room.session !== null && room.lease?.video != null;

  const broadcast = (room: Room, message: BrowserMessage) => {
    hocuspocus.documents
      .get(room.docName)
      ?.broadcastStateless(JSON.stringify(message));
  };

  const statusMessage = (room: Room): BrowserMessage => ({
    type: "browser_status",
    status: room.status,
    url: room.page.url,
    title: room.page.title,
    controller: room.mux.holder(),
    video: hasVideo(room),
    ...(room.error ? { error: room.error } : {}),
  });

  const sendStatus = (room: Room) => broadcast(room, statusMessage(room));

  // Bring one connection up to date: the status and the last frame, so a viewer paints at once.
  const catchUp = (room: Room, connection: Connection) => {
    connection.sendStateless(JSON.stringify(statusMessage(room)));
    if (room.lastFrame) {
      connection.sendStateless(
        JSON.stringify({ type: "browser_frame", ...room.lastFrame })
      );
    }
  };

  const withDoc = async (
    room: Room,
    actor: LiveActor,
    write: (doc: Y.Doc) => void
  ) => {
    const connection = await hocuspocus.openDirectConnection(room.docName, {
      actor,
      access: "write",
      workspaceId: null,
    });
    try {
      await connection.transact(write);
    } finally {
      await connection.disconnect();
    }
  };

  const keyframe = async (room: Room) => {
    const frame = room.lastFrame;
    if (!frame || !room.frameDirty) {
      return;
    }
    room.frameDirty = false;
    try {
      await persistence.appendFrame(
        room.docName,
        room.page.url,
        room.driver,
        Buffer.from(frame.data, "base64")
      );
    } catch (err) {
      logger.error({ err, docName: room.docName }, "live: keyframe failed");
    }
  };

  const stop = async (room: Room) => {
    if (room.stopTimer) {
      clearTimeout(room.stopTimer);
      room.stopTimer = null;
    }
    if (room.keyframeTimer) {
      clearInterval(room.keyframeTimer);
      room.keyframeTimer = null;
    }
    const session = room.session;
    const lease = room.lease;
    room.session = null;
    room.lease = null;
    room.lastOutline = null;
    if (session) {
      await keyframe(room);
      await session.close();
    }
    await lease?.release();
    if (room.status !== "unavailable") {
      room.status = "stopped";
    }
    sendStatus(room);
    rooms.delete(room.docName);
  };

  const scheduleStop = (room: Room) => {
    if (room.stopTimer) {
      clearTimeout(room.stopTimer);
    }
    room.stopTimer = setTimeout(() => {
      room.stopTimer = null;
      const connections =
        hocuspocus.documents.get(room.docName)?.getConnectionsCount() ?? 0;
      if (connections === 0) {
        void stop(room).catch((err) =>
          logger.error({ err, docName: room.docName }, "live: stop failed")
        );
      } else {
        scheduleStop(room);
      }
    }, idleStopMs);
  };

  const onNavigated = (room: Room, page: PageInfo) => {
    const changed = page.url !== room.page.url;
    room.page = page;
    room.frameDirty = true;
    sendStatus(room);
    if (!changed) {
      return;
    }
    // History keeps the first frame of every page, not whatever the 10 s timer catches.
    room.keyframeWanted = true;
    const driver = room.driver;
    void withDoc(room, driver, (doc) => recordVisit(doc, page, driver)).catch(
      (err) =>
        logger.error({ err, docName: room.docName }, "live: visit not saved")
    );
    activity.noteEdit(room.docName, driver);
    logEvent(room.docName, "browser_navigate", driver, { url: page.url });
  };

  const start = (
    room: Room,
    startUrl: string
  ): Promise<BrowserSession | null> => {
    if (room.extension?.session.isOpen()) {
      return Promise.resolve(room.extension.session);
    }
    if (room.session?.isOpen()) {
      return Promise.resolve(room.session);
    }
    if (room.starting) {
      return room.starting;
    }
    if (!provider) {
      room.status = "unavailable";
      room.error =
        "No browser is configured on this server; a person can share a tab from the extension instead.";
      sendStatus(room);
      return Promise.resolve(null);
    }
    if (rooms.size > maxRooms) {
      room.status = "unavailable";
      room.error = "Too many live browsers are open on this server right now.";
      sendStatus(room);
      return Promise.resolve(null);
    }
    room.status = "starting";
    room.error = null;
    sendStatus(room);
    room.starting = (async () => {
      try {
        const lease = await provider.acquire(room.docName);
        const session = await createBrowserSession({
          cdpUrl: lease.cdpUrl,
          dedicated: lease.dedicated,
          viewport: readBrowserState(
            hocuspocus.documents.get(room.docName)?.getMap("browserState")
              .doc ?? (await loadDoc(room))
          ).viewport,
          onFrame: (frame) => gotFrame(room, frame),
          onNavigated: (page) => onNavigated(room, page),
          onClosed: () => {
            if (room.session === session) {
              room.session = null;
              const lease = room.lease;
              room.lease = null;
              void lease?.release().catch(() => {});
              room.status = "stopped";
              room.error = "The browser closed.";
              sendStatus(room);
            }
          },
        });
        room.lease = lease;
        room.session = session;
        room.status = "running";
        room.keyframeTimer = setInterval(
          () => void keyframe(room),
          keyframeIntervalMs
        );
        sendStatus(room);
        if (startUrl !== blankUrl) {
          const result = await session.navigate(startUrl);
          if (!result.ok) {
            room.error = result.reason;
            sendStatus(room);
          }
        }
        return session;
      } catch (err) {
        logger.error(
          { err, docName: room.docName },
          "live: browser start failed"
        );
        room.status = "stopped";
        room.error =
          err instanceof BrowserPoolExhausted
            ? "Every shared browser on this server is in use right now; try again in a moment."
            : "The browser could not be started.";
        sendStatus(room);
        return null;
      } finally {
        room.starting = null;
      }
    })();
    return room.starting;
  };

  const loadDoc = async (room: Room): Promise<Y.Doc> => {
    const connection = await hocuspocus.openDirectConnection(room.docName, {
      actor: systemActor,
      access: "read",
      workspaceId: null,
    });
    try {
      const doc = connection.document;
      if (!doc) {
        throw new Error("live: document unavailable");
      }
      return doc;
    } finally {
      await connection.disconnect();
    }
  };

  const ensure = async (room: Room, document: Y.Doc | null) => {
    const url = document
      ? readBrowserState(document).url
      : readBrowserState(await loadDoc(room)).url;
    return start(room, url);
  };

  const recordTyped = (room: Room, actor: LiveActor, chars: number) => {
    const burst = room.typed.get(actor.id);
    if (burst) {
      burst.chars += chars;
      return;
    }
    room.typed.set(actor.id, {
      chars,
      timer: setTimeout(() => {
        const done = room.typed.get(actor.id);
        room.typed.delete(actor.id);
        logEvent(room.docName, "browser_typed", actor, {
          chars: done?.chars ?? chars,
        });
      }, typedBurstMs),
    });
  };

  const claim = (room: Room, actor: LiveActor) => {
    const before = room.mux.holder();
    const claimed = room.mux.claim(actor);
    if (claimed.ok) {
      room.driver = actor;
      if (before?.id !== actor.id) {
        sendStatus(room);
        logEvent(room.docName, "browser_control", actor, {});
      }
    }
    return claimed;
  };

  const readPage = async (
    room: Room,
    session: BrowserSession,
    screenshot: boolean
  ): Promise<BrowserPage> => {
    const outline = await session.readOutline();
    const changed = room.lastOutline
      ? diffOutline(room.lastOutline, outline)
      : undefined;
    room.lastOutline = outline;
    const page = await session.pageInfo();
    room.page = page;
    return {
      url: page.url,
      title: page.title,
      controller: room.mux.holder(),
      outline: formatOutline(outline),
      ...(changed ? { changed } : {}),
      ...(screenshot ? { screenshot: await session.screenshot() } : {}),
    };
  };

  const runOp = async (
    room: Room,
    session: BrowserSession,
    document: Document,
    actor: LiveActor,
    op: BrowserOp
  ): Promise<BrowserOpsResponse["results"][number]> => {
    const point = (at: { x: number; y: number }) =>
      presence.show(
        document,
        room.docName,
        actor,
        { pointer: at },
        room.page.title || room.page.url
      );
    switch (op.type) {
      case "navigate": {
        const result = await session.navigate(op.url);
        return result.ok ? { ok: true } : { ok: false, error: result.reason };
      }
      case "click": {
        const at = await session.click(op.ref);
        point(at);
        logEvent(room.docName, "browser_click", actor, { ref: op.ref });
        await sleep(settleAfterActionMs);
        return { ok: true };
      }
      case "type": {
        const at = await session.type(op.ref, op.text, op.submit);
        point(at);
        recordTyped(room, actor, op.text.length);
        await sleep(settleAfterActionMs);
        return { ok: true };
      }
      case "press":
        await session.press(op.key);
        await sleep(settleAfterActionMs);
        return { ok: true };
      case "scroll": {
        const { viewport } = readBrowserState(document);
        await session.wheel({
          x: viewport.width / 2,
          y: viewport.height / 2,
          deltaX: 0,
          deltaY: op.dy,
        });
        await sleep(settleAfterActionMs);
        return { ok: true };
      }
      case "wait":
        await sleep(op.ms);
        return { ok: true };
    }
  };

  const detachExtension = (room: Room) => {
    if (!room.extension) {
      return;
    }
    room.extension = null;
    room.status = provider ? "stopped" : "unavailable";
    room.error = "The shared tab was closed.";
    sendStatus(room);
    room.error = null;
  };

  return {
    // The extension is sharing the person's tab: it becomes this room's browser. A provider
    // session, if one was running, is dropped so the room has one page.
    attachExtension(docName: string, connection: Connection, actor: LiveActor) {
      const room = roomOf(docName);
      const previous = room.extension;
      const session = createExtensionSession({
        connection,
        actor,
        onFrame: (frame) => gotFrame(room, frame),
        onNavigated: (page) => onNavigated(room, page),
        onClosed: () => {
          if (room.extension?.session === session) {
            detachExtension(room);
          }
        },
        logger,
      });
      room.extension = { session, connection, socketId: connection.socketId };
      previous?.session.detach();
      if (room.session) {
        const stale = room.session;
        room.session = null;
        void stale.close().catch(() => {});
        void room.lease?.release().catch(() => {});
        room.lease = null;
      }
      room.status = "running";
      room.error = null;
      room.driver = actor;
      if (!room.keyframeTimer) {
        room.keyframeTimer = setInterval(
          () => void keyframe(room),
          keyframeIntervalMs
        );
      }
      sendStatus(room);
      logEvent(docName, "browser_tab_shared", actor, {});
    },

    detachExtension(docName: string, socketId: string) {
      const room = rooms.get(docName);
      if (room?.extension?.socketId === socketId) {
        room.extension.session.detach();
      }
    },

    // A viewer joined the doc: start the browser if it is not running, and bring the newcomer up
    // to date with the last frame and the status.
    async join(docName: string, document: Document, connection: Connection) {
      if (!isBrowserDoc(document) && !rooms.has(docName)) {
        return;
      }
      const room = roomOf(docName);
      if (room.stopTimer) {
        clearTimeout(room.stopTimer);
        room.stopTimer = null;
      }
      catchUp(room, connection);
      await ensure(room, document);
    },

    leave(docName: string) {
      const room = rooms.get(docName);
      if (room) {
        scheduleStop(room);
      }
    },

    unloaded(docName: string) {
      const room = rooms.get(docName);
      if (room && !room.stopTimer) {
        scheduleStop(room);
      }
    },

    async handleInput(
      docName: string,
      document: Document,
      connection: Connection,
      payload: string
    ): Promise<boolean> {
      const sharing = rooms.get(docName)?.extension;
      if (
        sharing?.connection === connection &&
        sharing.session.handle(payload)
      ) {
        return true;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return false;
      }
      const input = browserInputSchema.safeParse(raw);
      if (!input.success) {
        return false;
      }
      if (input.data.type === "status") {
        const existing = rooms.get(docName);
        if (existing) {
          catchUp(existing, connection);
        }
        return true;
      }
      const claims = claimsOf(connection, docName);
      if (!claims || !allows(claims, docName, "drive")) {
        return true;
      }
      const actor = claims.actor;
      if (rooms.get(docName)?.extension) {
        // The person's own tab takes input from them directly, not from the room.
        return true;
      }
      const room = roomOf(docName);
      if (input.data.type === "release") {
        room.mux.release(actor.id);
        sendStatus(room);
        return true;
      }
      const claimed = claim(room, actor);
      if (!claimed.ok) {
        connection.sendStateless(
          JSON.stringify({ type: "browser_denied", heldBy: claimed.heldBy })
        );
        return true;
      }
      if (input.data.type === "claim") {
        return true;
      }
      const session = await ensure(room, document);
      if (!session) {
        return true;
      }
      // Strokes, not navigations: a page load's first frame is not the input budget.
      if (
        input.data.type === "mouse" ||
        input.data.type === "wheel" ||
        input.data.type === "key" ||
        input.data.type === "text"
      ) {
        room.inputAt = performance.now();
      }
      await dispatchInput(room, session, actor, input.data).catch((err) =>
        logger.warn(
          { err, docName, type: input.data.type },
          "live: input failed"
        )
      );
      return true;
    },

    async runOps(
      docName: string,
      claims: LiveTokenClaims,
      body: unknown
    ): Promise<{ status: number; body: unknown }> {
      const parsed = browserOpsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.message } };
      }
      const room = roomOf(docName);
      if (!provider && !room.extension) {
        return { status: 503, body: { error: room.error } };
      }
      const connection = await hocuspocus.openDirectConnection(docName, {
        actor: claims.actor,
        access: claims.access,
        workspaceId: claims.workspaceId,
      });
      try {
        const document = connection.document;
        if (!document) {
          return { status: 500, body: { error: "document unavailable" } };
        }
        const first = parsed.data.ops[0];
        if (!isBrowserDoc(document) && first.type === "navigate") {
          await connection.transact((doc) =>
            initBrowser(doc, { url: first.url })
          );
        }
        room.driver = claims.actor;
        room.extension?.session.actingFor(claims.actor);
        const session = await ensure(room, document);
        if (!session) {
          return {
            status: 503,
            body: { error: room.error ?? "The browser is not available." },
          };
        }
        const results: BrowserOpsResponse["results"] = [];
        for (const op of parsed.data.ops) {
          const claimed = claim(room, claims.actor);
          if (!claimed.ok) {
            results.push({
              ok: false,
              error: `${claimed.heldBy.name} is driving the browser; wait until they stop.`,
              heldBy: claimed.heldBy,
            });
            break;
          }
          try {
            results.push(
              await runOp(room, session, document, claims.actor, op)
            );
          } catch (err) {
            results.push({
              ok: false,
              error: err instanceof Error ? err.message : "the step failed",
            });
          }
          if (!results[results.length - 1].ok) {
            break;
          }
        }
        logEvent(docName, "agent_ops", claims.actor, {
          mode: "edit",
          suggestionId: null,
          ops: parsed.data.ops.map((op) => op.type),
        });
        const page = await readPage(room, session, false);
        const response: BrowserOpsResponse = { results, page };
        return { status: 200, body: response };
      } finally {
        await connection.disconnect();
      }
    },

    // A viewer's way onto the browser's own video: a session in the browser's WebRTC server,
    // minted here in the viewer's name so the shared password never leaves live-server.
    async videoGrant(
      docName: string,
      claims: LiveTokenClaims
    ): Promise<{ status: number; body: unknown }> {
      const room = rooms.get(docName);
      const video = room?.lease?.video;
      if (!room || !video || !hasVideo(room)) {
        return {
          status: 503,
          body: { error: "This browser has no video; it shows snapshots." },
        };
      }
      try {
        const response: BrowserVideoResponse = {
          url: video.publicUrl,
          token: await video.mint(claims.actor.name),
        };
        return { status: 200, body: response };
      } catch (err) {
        logger.warn(
          { err, docName },
          "live: browser video server did not answer"
        );
        return {
          status: 503,
          body: {
            error: "The browser's video is not answering; snapshots only.",
          },
        };
      }
    },

    async read(
      docName: string,
      claims: LiveTokenClaims,
      screenshot: boolean
    ): Promise<{ status: number; body: unknown }> {
      const room = roomOf(docName);
      if (!provider && !room.extension) {
        return { status: 503, body: { error: room.error } };
      }
      const connection = await hocuspocus.openDirectConnection(docName, {
        actor: claims.actor,
        access: "read",
        workspaceId: claims.workspaceId,
      });
      try {
        const session = await ensure(room, connection.document ?? null);
        if (!session) {
          return {
            status: 503,
            body: { error: room.error ?? "The browser is not available." },
          };
        }
        return { status: 200, body: await readPage(room, session, screenshot) };
      } finally {
        await connection.disconnect();
      }
    },

    async destroy() {
      await Promise.all([...rooms.values()].map((room) => stop(room)));
    },
  };

  async function dispatchInput(
    room: Room,
    session: BrowserSession,
    actor: LiveActor,
    input: BrowserInput
  ) {
    switch (input.type) {
      case "mouse":
        await session.mouse({
          type: input.kind,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
        if (input.kind === "down") {
          logEvent(room.docName, "browser_click", actor, {
            x: Math.round(input.x),
            y: Math.round(input.y),
          });
        }
        return;
      case "wheel":
        await session.wheel(input);
        return;
      case "key":
        await session.key({
          type: input.kind,
          key: input.key,
          code: input.code,
          text: input.text,
          modifiers: input.modifiers,
        });
        if (input.kind === "down" && input.key.length === 1) {
          recordTyped(room, actor, 1);
        }
        return;
      case "text":
        await session.insertText(input.text);
        recordTyped(room, actor, input.text.length);
        return;
      case "navigate": {
        const result = await session.navigate(addressToUrl(input.url));
        if (!result.ok) {
          room.error = result.reason;
          sendStatus(room);
          room.error = null;
        }
        return;
      }
      case "back":
        await session.back();
        return;
      case "forward":
        await session.forward();
        return;
      case "reload":
        await session.reload();
        return;
      case "claim":
      case "release":
        return;
    }
  }
}

export type LiveBrowserRooms = ReturnType<typeof createBrowserRooms>;
