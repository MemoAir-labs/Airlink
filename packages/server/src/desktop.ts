import type {
  Connection,
  DirectConnection,
  Document,
  Hocuspocus,
} from "@hocuspocus/server";
import type { InputMux } from "@memo-air/browser";
import { createInputMux } from "@memo-air/browser";
import {
  initDesktop,
  isDesktopDoc,
  readActions,
  readDesktopState,
  recordAction,
  setDesktopStatus,
} from "@memo-air/desktop";
import type {
  DesktopLease,
  DesktopProvider,
  DesktopSession,
} from "@memo-air/desktop/session";
import { DesktopBusy } from "@memo-air/desktop/session";
import type {
  DesktopInput,
  DesktopMessage,
  DesktopOp,
  DesktopOpsResponse,
  DesktopView,
  LiveActor,
  LiveTokenClaims,
} from "@memo-air/protocol";
import {
  allows,
  desktopInputSchema,
  desktopOpsRequestSchema,
  liveAccessSchema,
  liveActorSchema,
  systemActor,
} from "@memo-air/protocol";
import type { Logger } from "pino";
import type * as Y from "yjs";

import type { LiveActivity } from "./activity.ts";
import type { LivePersistence } from "./persistence.ts";
import type { LivePresence } from "./presence.ts";

const idleStopMs = 180_000;
const keyframeIntervalMs = 10_000;
const moveThrottleMs = 100;
const maxRooms = 10;
const settleAfterActionMs = 500;

type RoomStatus = "starting" | "running" | "stopped" | "unavailable";

type Room = {
  docName: string;
  mux: InputMux;
  lease: DesktopLease | null;
  session: DesktopSession | null;
  starting: Promise<DesktopSession | null> | null;
  status: RoomStatus;
  error: string | null;
  streamUrl: string | null;
  screen: { width: number; height: number };
  driver: LiveActor;
  cursor: { x: number; y: number } | null;
  lastMoveAt: number;
  pendingMove: { x: number; y: number } | null;
  keyframeTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  dirty: boolean;
};

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(op: DesktopOp): string {
  switch (op.type) {
    case "move":
      return `${op.x},${op.y}`;
    case "click":
      return `${op.button}${op.count === 2 ? " double" : ""} at ${op.x},${op.y}`;
    case "drag":
      return `${op.from.join(",")} → ${op.to.join(",")}`;
    case "scroll":
      return `${op.direction} ${op.amount}`;
    case "key":
      return op.keys.join("+");
    case "type":
      return `${op.text.length} chars`;
    case "open":
      return op.target;
    case "launch":
      return op.uri ? `${op.application} ${op.uri}` : op.application;
    case "wait":
      return `${op.ms} ms`;
  }
}

// A room's desktop: one machine from the provider per doc, driven by whoever holds the mux,
// watched by everyone through the provider's view-only stream. What happened is written into
// the doc as the driver; a screenshot every few seconds and after every agent step records it.
export function createDesktopRooms({
  hocuspocus,
  persistence,
  activity,
  presence,
  provider,
  logger,
  logEvent,
}: {
  hocuspocus: Hocuspocus;
  persistence: LivePersistence;
  activity: LiveActivity;
  presence: LivePresence;
  provider: DesktopProvider | null;
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
      error: provider
        ? null
        : "No desktop provider is configured on this server.",
      streamUrl: null,
      screen: { width: 1024, height: 768 },
      driver: systemActor,
      cursor: null,
      lastMoveAt: 0,
      pendingMove: null,
      keyframeTimer: null,
      stopTimer: null,
      dirty: false,
    };
    rooms.set(docName, room);
    return room;
  };

  const broadcast = (room: Room, message: DesktopMessage) => {
    hocuspocus.documents
      .get(room.docName)
      ?.broadcastStateless(JSON.stringify(message));
  };

  const statusMessage = (room: Room): DesktopMessage => ({
    type: "desktop_status",
    status: room.status,
    streamUrl: room.streamUrl,
    screen: room.screen,
    controller: room.mux.holder(),
    ...(room.error ? { error: room.error } : {}),
  });

  const sendStatus = (room: Room) => broadcast(room, statusMessage(room));

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
    const session = room.session;
    if (!session?.isOpen() || !room.dirty) {
      return;
    }
    room.dirty = false;
    try {
      const png = await session.screenshot();
      await persistence.appendFrame(
        room.docName,
        readDesktopApp(room),
        room.driver,
        Buffer.from(png)
      );
    } catch (err) {
      logger.error(
        { err, docName: room.docName },
        "live: desktop keyframe failed"
      );
    }
  };

  const readDesktopApp = (room: Room) => {
    const document = hocuspocus.documents.get(room.docName);
    return document ? readDesktopState(document).app : "";
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
    const lease = room.lease;
    room.session = null;
    room.lease = null;
    room.streamUrl = null;
    if (lease) {
      await keyframe({ ...room, session: lease.session, dirty: true }).catch(
        () => {}
      );
      await lease
        .release()
        .catch((err) =>
          logger.error(
            { err, docName: room.docName },
            "live: desktop release failed"
          )
        );
      await withDoc(room, systemActor, (doc) =>
        setDesktopStatus(doc, "stopped")
      ).catch(() => {});
    }
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
          logger.error(
            { err, docName: room.docName },
            "live: desktop stop failed"
          )
        );
      } else {
        scheduleStop(room);
      }
    }, idleStopMs);
  };

  const start = (room: Room): Promise<DesktopSession | null> => {
    if (room.session?.isOpen()) {
      return Promise.resolve(room.session);
    }
    if (room.starting) {
      return room.starting;
    }
    if (!provider) {
      return Promise.resolve(null);
    }
    if (rooms.size > maxRooms) {
      room.status = "unavailable";
      room.error =
        "Too many live desktops are running on this server right now.";
      sendStatus(room);
      return Promise.resolve(null);
    }
    room.status = "starting";
    room.error = null;
    sendStatus(room);
    void withDoc(room, systemActor, (doc) =>
      setDesktopStatus(doc, "starting")
    ).catch(() => {});
    room.starting = (async () => {
      try {
        const lease = await provider.acquire(room.docName);
        const { session } = lease;
        room.lease = lease;
        room.session = session;
        room.screen = await session.screenSize();
        room.streamUrl = session.streamUrl({ viewOnly: true });
        room.status = "running";
        room.dirty = true;
        room.keyframeTimer = setInterval(
          () => void keyframe(room),
          keyframeIntervalMs
        );
        await withDoc(room, systemActor, (doc) =>
          setDesktopStatus(doc, "running", room.screen)
        );
        sendStatus(room);
        return session;
      } catch (err) {
        logger.error(
          { err, docName: room.docName },
          "live: desktop start failed"
        );
        // A lease taken before the failure still holds its machine until released.
        const lease = room.lease;
        room.lease = null;
        room.session = null;
        room.streamUrl = null;
        if (room.keyframeTimer) {
          clearInterval(room.keyframeTimer);
          room.keyframeTimer = null;
        }
        await lease
          ?.release()
          .catch((releaseErr) =>
            logger.error(
              { err: releaseErr, docName: room.docName },
              "live: desktop release failed"
            )
          );
        room.status = "stopped";
        room.error =
          err instanceof DesktopBusy
            ? err.message
            : "The desktop could not be started.";
        sendStatus(room);
        return null;
      } finally {
        room.starting = null;
      }
    })();
    return room.starting;
  };

  const claim = (room: Room, actor: LiveActor) => {
    const before = room.mux.holder();
    const claimed = room.mux.claim(actor);
    if (claimed.ok) {
      room.driver = actor;
      if (before?.id !== actor.id) {
        sendStatus(room);
        logEvent(room.docName, "desktop_control", actor, {});
      }
    }
    return claimed;
  };

  // Written through the actor's own direct connection, so onChange attributes the update to
  // them the way it does for every other kind.
  const record = (
    room: Room,
    actor: LiveActor,
    action: string,
    detail: string,
    connection: DirectConnection | null
  ) => {
    room.dirty = true;
    activity.noteEdit(room.docName, actor);
    logEvent(room.docName, `desktop_${action}`, actor, { detail });
    const write = (doc: Y.Doc) => recordAction(doc, actor, action, detail);
    const done = connection
      ? connection.transact(write)
      : withDoc(room, actor, write);
    void done.catch((err) =>
      logger.error(
        { err, docName: room.docName },
        "live: desktop action not saved"
      )
    );
  };

  const view = async (
    room: Room,
    document: Y.Doc,
    screenshot: boolean
  ): Promise<DesktopView> => {
    const state = readDesktopState(document);
    return {
      status: room.status,
      screen: room.screen,
      app: state.app,
      controller: room.mux.holder(),
      cursor: room.cursor,
      actions: readActions(document, 30),
      ...(screenshot && room.session?.isOpen()
        ? {
            screenshot: Buffer.from(await room.session.screenshot()).toString(
              "base64"
            ),
          }
        : {}),
    };
  };

  const runOp = async (
    room: Room,
    session: DesktopSession,
    connection: DirectConnection,
    document: Document,
    actor: LiveActor,
    op: DesktopOp
  ): Promise<DesktopOpsResponse["results"][number]> => {
    const point = (x: number, y: number) => {
      room.cursor = { x, y };
      presence.show(
        document,
        room.docName,
        actor,
        { pointer: { x, y } },
        readDesktopState(document).app || "desktop"
      );
    };
    switch (op.type) {
      case "move":
        await session.move(op.x, op.y);
        point(op.x, op.y);
        return { ok: true };
      case "click":
        await session.click(op.x, op.y, op.button, op.count);
        point(op.x, op.y);
        break;
      case "drag":
        await session.drag(op.from, op.to);
        point(op.to[0], op.to[1]);
        break;
      case "scroll":
        await session.scroll(op.direction, op.amount);
        break;
      case "key":
        await session.key(op.keys);
        break;
      case "type":
        await session.type(op.text);
        break;
      case "open":
        await session.open(op.target);
        break;
      case "launch":
        await session.launch(op.application, op.uri);
        break;
      case "wait":
        await sleep(op.ms);
        return { ok: true };
    }
    record(room, actor, op.type, describe(op), connection);
    await sleep(settleAfterActionMs);
    return { ok: true };
  };

  const dispatchInput = async (
    room: Room,
    session: DesktopSession,
    actor: LiveActor,
    input: DesktopInput
  ) => {
    switch (input.type) {
      case "mouse": {
        if (input.kind === "move") {
          // Each move is a round trip to the provider; coalesce them to a few per second.
          room.cursor = { x: input.x, y: input.y };
          const now = Date.now();
          if (now - room.lastMoveAt < moveThrottleMs) {
            room.pendingMove = { x: input.x, y: input.y };
            return;
          }
          room.lastMoveAt = now;
          room.pendingMove = null;
          await session.move(input.x, input.y);
          return;
        }
        await session.move(input.x, input.y);
        if (input.kind === "down") {
          await session.press(input.button ?? "left");
          record(
            room,
            actor,
            "click",
            `${input.button ?? "left"} at ${input.x},${input.y}`,
            null
          );
        } else {
          await session.release(input.button ?? "left");
        }
        return;
      }
      case "wheel":
        await session.scroll(input.direction, input.amount);
        return;
      case "key":
        await session.key(input.keys);
        record(room, actor, "key", input.keys.join("+"), null);
        return;
      case "text":
        await session.type(input.text);
        record(room, actor, "type", `${input.text.length} chars`, null);
        return;
      case "claim":
      case "release":
        return;
    }
  };

  return {
    async join(docName: string, document: Document, connection: Connection) {
      if (!isDesktopDoc(document) && !rooms.has(docName)) {
        return;
      }
      const room = roomOf(docName);
      if (room.stopTimer) {
        clearTimeout(room.stopTimer);
        room.stopTimer = null;
      }
      connection.sendStateless(JSON.stringify(statusMessage(room)));
      await start(room);
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
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return false;
      }
      const input = desktopInputSchema.safeParse(raw);
      if (!input.success || !isDesktopDoc(document)) {
        return false;
      }
      const claims = claimsOf(connection, docName);
      if (!claims || !allows(claims, docName, "drive")) {
        return true;
      }
      const room = roomOf(docName);
      if (input.data.type === "release") {
        room.mux.release(claims.actor.id);
        sendStatus(room);
        return true;
      }
      const claimed = claim(room, claims.actor);
      if (!claimed.ok) {
        connection.sendStateless(
          JSON.stringify({ type: "desktop_denied", heldBy: claimed.heldBy })
        );
        return true;
      }
      if (input.data.type === "claim") {
        return true;
      }
      const session = await start(room);
      if (!session) {
        return true;
      }
      await dispatchInput(room, session, claims.actor, input.data).catch(
        (err) =>
          logger.warn(
            { err, docName, type: input.data.type },
            "live: desktop input failed"
          )
      );
      return true;
    },

    async runOps(
      docName: string,
      claims: LiveTokenClaims,
      body: unknown
    ): Promise<{ status: number; body: unknown }> {
      const parsed = desktopOpsRequestSchema.safeParse(body);
      if (!parsed.success) {
        return { status: 400, body: { error: parsed.error.message } };
      }
      const room = roomOf(docName);
      if (!provider) {
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
        if (!isDesktopDoc(document)) {
          const first = parsed.data.ops[0];
          await connection.transact((doc) =>
            initDesktop(doc, {
              app:
                first.type === "launch"
                  ? first.application
                  : first.type === "open"
                    ? first.target
                    : "",
            })
          );
        }
        room.driver = claims.actor;
        const session = await start(room);
        if (!session) {
          return {
            status: 503,
            body: { error: room.error ?? "The desktop is not available." },
          };
        }
        const results: DesktopOpsResponse["results"] = [];
        for (const op of parsed.data.ops) {
          const claimed = claim(room, claims.actor);
          if (!claimed.ok) {
            results.push({
              ok: false,
              error: `${claimed.heldBy.name} is driving the desktop; wait until they stop.`,
              heldBy: claimed.heldBy,
            });
            break;
          }
          try {
            results.push(
              await runOp(room, session, connection, document, claims.actor, op)
            );
          } catch (err) {
            results.push({
              ok: false,
              error: err instanceof Error ? err.message : "the step failed",
            });
            break;
          }
        }
        logEvent(docName, "agent_ops", claims.actor, {
          mode: "edit",
          suggestionId: null,
          ops: parsed.data.ops.map((op) => op.type),
        });
        await keyframe(room);
        const response: DesktopOpsResponse = {
          results,
          desktop: await view(room, document, true),
        };
        return { status: 200, body: response };
      } finally {
        await connection.disconnect();
      }
    },

    async read(
      docName: string,
      claims: LiveTokenClaims,
      screenshot: boolean
    ): Promise<{ status: number; body: unknown }> {
      const room = roomOf(docName);
      if (!provider) {
        return { status: 503, body: { error: room.error } };
      }
      const connection = await hocuspocus.openDirectConnection(docName, {
        actor: claims.actor,
        access: "read",
        workspaceId: claims.workspaceId,
      });
      try {
        const document = connection.document;
        if (!document) {
          return { status: 500, body: { error: "document unavailable" } };
        }
        if (isDesktopDoc(document)) {
          await start(room);
        }
        return { status: 200, body: await view(room, document, screenshot) };
      } finally {
        await connection.disconnect();
      }
    },

    async destroy() {
      await Promise.all([...rooms.values()].map((room) => stop(room)));
    },
  };
}

export type LiveDesktopRooms = ReturnType<typeof createDesktopRooms>;
