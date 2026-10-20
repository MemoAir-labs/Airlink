import type { DesktopScreen } from "./index.ts";
import { toE2bKey } from "./index.ts";

export type MouseButton = "left" | "right" | "middle";

// What a desktop room needs from whichever provider runs the machine. E2B Desktop is the first;
// a self-hosted VM behind the same calls plugs in without touching the room.
export type DesktopSession = {
  streamUrl(options: { viewOnly: boolean }): string;
  screenSize(): Promise<DesktopScreen>;
  screenshot(): Promise<Uint8Array>;
  move(x: number, y: number): Promise<void>;
  press(button: MouseButton): Promise<void>;
  release(button: MouseButton): Promise<void>;
  click(x: number, y: number, button: MouseButton, count: 1 | 2): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  scroll(direction: "up" | "down", amount: number): Promise<void>;
  key(keys: string | string[]): Promise<void>;
  type(text: string): Promise<void>;
  open(fileOrUrl: string): Promise<void>;
  launch(application: string, uri?: string): Promise<void>;
  isOpen(): boolean;
  close(): Promise<void>;
};

export type DesktopLease = {
  session: DesktopSession;
  release(): Promise<void>;
};

export type DesktopProvider = {
  acquire(docName: string): Promise<DesktopLease>;
};

export class DesktopBusy extends Error {
  constructor() {
    super("The desktop is in use by another object.");
    this.name = "DesktopBusy";
  }
}

const defaultLifetimeMs = 55 * 60 * 1000;
const streamReadyTimeoutMs = 20_000;
const streamPollMs = 500;

// stream.start() returns before the viewer's web server answers. A viewer that loads the page in
// that gap stays black and never retries, so the room is only "running" once the page responds.
async function waitForStream(url: string): Promise<void> {
  const deadline = Date.now() + streamReadyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, streamPollMs));
  }
  throw new Error("desktop: the stream did not come up in time");
}

export function e2bDesktopProvider({
  apiKey,
  template,
  lifetimeMs = defaultLifetimeMs,
}: {
  apiKey: string;
  template?: string;
  lifetimeMs?: number;
}): DesktopProvider {
  return {
    async acquire() {
      // Imported here: @e2b/desktop is an optional peer, needed only by hosts that use E2B.
      const { Sandbox } = await import("@e2b/desktop");
      const sandbox = template
        ? await Sandbox.create(template, { apiKey, timeoutMs: lifetimeMs })
        : await Sandbox.create({ apiKey, timeoutMs: lifetimeMs });
      await sandbox.stream.start({ requireAuth: true });
      await waitForStream(
        sandbox.stream.getUrl({ authKey: sandbox.stream.getAuthKey() })
      );
      let open = true;
      const session: DesktopSession = {
        streamUrl: ({ viewOnly }) =>
          sandbox.stream.getUrl({
            authKey: sandbox.stream.getAuthKey(),
            autoConnect: true,
            viewOnly,
            resize: "scale",
          }),
        screenSize: () => sandbox.getScreenSize(),
        screenshot: () => sandbox.screenshot(),
        move: (x, y) => sandbox.moveMouse(x, y),
        press: (button) => sandbox.mousePress(button),
        release: (button) => sandbox.mouseRelease(button),
        click: async (x, y, button, count) => {
          if (count === 2) {
            await sandbox.doubleClick(x, y);
          } else if (button === "right") {
            await sandbox.rightClick(x, y);
          } else {
            await sandbox.leftClick(x, y);
          }
        },
        drag: (from, to) => sandbox.drag(from, to),
        scroll: (direction, amount) => sandbox.scroll(direction, amount),
        key: (keys) =>
          sandbox.press(
            Array.isArray(keys) ? keys.map(toE2bKey) : toE2bKey(keys)
          ),
        type: (text) => sandbox.write(text),
        open: (fileOrUrl) => sandbox.open(fileOrUrl),
        launch: (application, uri) => sandbox.launch(application, uri),
        isOpen: () => open,
        close: async () => {
          if (!open) {
            return;
          }
          open = false;
          await sandbox.kill();
        },
      };
      return { session, release: () => session.close() };
    },
  };
}

const xButtons: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 };
// The view scales pointer positions, so they arrive fractional; xdotool takes whole pixels.
const round = (value: number) => Math.max(0, Math.round(value));

function isScreen(value: unknown): value is DesktopScreen {
  return (
    typeof value === "object" &&
    value !== null &&
    "width" in value &&
    "height" in value &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

// One neko XFCE desktop in Docker (docker/desktop.Dockerfile), driven through its control server
// with xdotool keysyms, so no E2B key mapping applies. There is one machine, so one object holds it
// at a time. ponytail: a single shared desktop; upgrade: a pool of containers like the browser's.
export function selfHostedDesktopProvider({
  controlUrl,
  viewerUrl,
  viewerPassword,
  token,
}: {
  controlUrl: string;
  viewerUrl: string;
  viewerPassword: string;
  token: string;
}): DesktopProvider {
  let busy = false;

  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, controlUrl), {
      ...init,
      headers: {
        "x-desktop-token": token,
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(
        `desktop: control answered ${response.status}: ${await response.text()}`
      );
    }
    return response;
  };
  const op = async (name: string, args: unknown[] = []): Promise<unknown> => {
    const body: unknown = await (
      await call("/op", {
        method: "POST",
        body: JSON.stringify({ name, args }),
      })
    ).json();
    return typeof body === "object" && body !== null && "result" in body
      ? body.result
      : null;
  };
  const run = async (name: string, args: unknown[] = []) => {
    await op(name, args);
  };

  return {
    async acquire() {
      if (busy) {
        throw new DesktopBusy();
      }
      busy = true;
      // Nothing else in acquire touches the network, so a stopped container would otherwise hold
      // the desktop busy for a lease nobody can use.
      try {
        await op("size");
      } catch (err) {
        busy = false;
        throw err;
      }
      let open = true;
      // neko's client logs in from usr/pwd and drops them from the address bar; the viewer profile
      // cannot take control, so the password only ever lets someone watch.
      const stream = new URL(viewerUrl);
      stream.searchParams.set("usr", "AirLink");
      stream.searchParams.set("pwd", viewerPassword);
      stream.searchParams.set("embed", "1");
      const session: DesktopSession = {
        streamUrl: () => stream.toString(),
        screenSize: async () => {
          const size = await op("size");
          if (!isScreen(size)) {
            throw new Error("desktop: control gave no screen size");
          }
          return size;
        },
        screenshot: async () =>
          new Uint8Array(await (await call("/shot.png")).arrayBuffer()),
        move: (x, y) => run("move", [round(x), round(y)]),
        press: (button) => run("press", [xButtons[button]]),
        release: (button) => run("release", [xButtons[button]]),
        click: (x, y, button, count) =>
          run("click", [round(x), round(y), xButtons[button], count]),
        drag: (from, to) => run("drag", [...from, ...to].map(round)),
        scroll: (direction, amount) =>
          run("scroll", [direction, Math.max(1, round(amount))]),
        key: (keys) =>
          run("key", [Array.isArray(keys) ? keys.join("+") : keys]),
        type: (text) => run("type", [text]),
        open: (fileOrUrl) => run("open", [fileOrUrl]),
        launch: (application, uri) =>
          run("launch", uri === undefined ? [application] : [application, uri]),
        isOpen: () => open,
        close: async () => {
          if (!open) {
            return;
          }
          open = false;
          busy = false;
        },
      };
      return { session, release: () => session.close() };
    },
  };
}
