import type * as Y from "yjs";

export type DesktopActor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type DesktopScreen = { width: number; height: number };

export type DesktopStatus = "stopped" | "starting" | "running";

export type DesktopAction = {
  at: string;
  actor: DesktopActor;
  action: string;
  detail: string;
};

export type DesktopState = {
  status: DesktopStatus;
  screen: DesktopScreen;
  app: string;
};

export const defaultScreen: DesktopScreen = { width: 1024, height: 768 };

// What a desktop room remembers across sessions: whether it is up, its screen, the app it was
// asked to open, and the last actions with who did them. Pixels and input never enter the doc.
const actionCap = 200;

export const desktopState = (doc: Y.Doc) => doc.getMap<unknown>("desktopState");
export const desktopLog = (doc: Y.Doc) =>
  doc.getArray<DesktopAction>("desktopLog");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDesktopDoc(doc: Y.Doc): boolean {
  return typeof desktopState(doc).get("status") === "string";
}

export function readDesktopState(doc: Y.Doc): DesktopState {
  const state = desktopState(doc);
  const status = state.get("status");
  const screen = state.get("screen");
  const app = state.get("app");
  return {
    status: status === "running" || status === "starting" ? status : "stopped",
    screen:
      isRecord(screen) &&
      typeof screen.width === "number" &&
      typeof screen.height === "number"
        ? { width: screen.width, height: screen.height }
        : defaultScreen,
    app: typeof app === "string" ? app : "",
  };
}

export function initDesktop(doc: Y.Doc, { app = "" }: { app?: string } = {}) {
  const state = desktopState(doc);
  state.set("status", "stopped");
  state.set("screen", defaultScreen);
  state.set("app", app);
}

export function setDesktopStatus(
  doc: Y.Doc,
  status: DesktopStatus,
  screen?: DesktopScreen
) {
  const state = desktopState(doc);
  state.set("status", status);
  if (screen) {
    state.set("screen", screen);
  }
}

export function recordAction(
  doc: Y.Doc,
  actor: DesktopActor,
  action: string,
  detail: string,
  at = new Date().toISOString()
) {
  const log = desktopLog(doc);
  log.push([{ at, actor, action, detail }]);
  if (log.length > actionCap) {
    log.delete(0, log.length - actionCap);
  }
  if (action === "open" || action === "launch") {
    desktopState(doc).set("app", detail);
  }
}

// Rooms, tools and the view speak X key names ("Return", "BackSpace", "Page_Up"). The E2B
// desktop SDK lowercases any name missing from its own table, and "return" is not an X keysym,
// so Enter was silently dropped; every other name survives lowercasing.
const e2bKeyNames: Record<string, string> = {
  return: "enter",
  kp_enter: "enter",
};

export function toE2bKey(key: string): string {
  return e2bKeyNames[key.toLowerCase()] ?? key;
}

export function readActions(doc: Y.Doc, limit = 50): DesktopAction[] {
  const log = desktopLog(doc);
  return log.slice(Math.max(0, log.length - limit));
}
