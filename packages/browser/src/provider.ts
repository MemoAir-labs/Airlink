import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Where a room's Chromium comes from. The session code only needs a CDP WebSocket URL, so an E2B
// sandbox per room plugs in here without touching the rest.
export type BrowserVideoLease = {
  // Where a viewer reaches the browser's own WebRTC server.
  publicUrl: string;
  // A viewer session in the browser's own server, named after the person or agent watching.
  mint(name: string): Promise<string>;
};

export type BrowserLease = {
  cdpUrl: string;
  // One browser for this room alone, as opposed to a browser context in a shared process.
  dedicated: boolean;
  video: BrowserVideoLease | null;
  release(): Promise<void>;
};

export type BrowserProvider = {
  acquire(docName: string): Promise<BrowserLease>;
};

export class BrowserPoolExhausted extends Error {
  constructor() {
    super("every browser in the pool is in use");
    this.name = "BrowserPoolExhausted";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Chromium's DevTools endpoint refuses a Host header that is neither an IP nor localhost, and
// reports whatever address it was asked for, which inside Compose is not the one we dial: dial
// the configured host by address, for the version probe and the socket alike.
async function byAddress(url: URL): Promise<URL> {
  const dialed = new URL(url);
  if (dialed.hostname !== "localhost" && isIP(dialed.hostname) === 0) {
    const { address, family } = await lookup(dialed.hostname);
    dialed.hostname = family === 6 ? `[${address}]` : address;
  }
  return dialed;
}

async function resolveCdpUrl(base: URL): Promise<string> {
  const dialed = await byAddress(base);
  const response = await fetch(new URL("/json/version", dialed));
  if (!response.ok) {
    throw new Error(`browser endpoint answered ${response.status}`);
  }
  const info: unknown = await response.json();
  if (!isRecord(info) || typeof info.webSocketDebuggerUrl !== "string") {
    throw new Error("browser endpoint gave no webSocketDebuggerUrl");
  }
  const cdpUrl = new URL(new URL(info.webSocketDebuggerUrl).pathname, dialed);
  cdpUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return cdpUrl.toString();
}

// One Chromium shared by every room on this node, each room in its own browser context.
// ponytail: one process for all rooms; upgrade: a container or an E2B sandbox per room (G4).
export function cdpEndpointProvider({ url }: { url: string }): BrowserProvider {
  const base = new URL(url);
  return {
    async acquire() {
      return {
        cdpUrl: await resolveCdpUrl(base),
        dedicated: false,
        video: null,
        release: async () => {},
      };
    },
  };
}

export type NekoInstance = { cdp: string; neko: string; publicUrl: string };

export function parseNekoInstances(json: string): NekoInstance[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("LIVE_BROWSERS must be a JSON array");
  }
  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.cdp !== "string" ||
      typeof entry.neko !== "string" ||
      typeof entry.publicUrl !== "string"
    ) {
      throw new Error("LIVE_BROWSERS entries need cdp, neko and publicUrl");
    }
    return { cdp: entry.cdp, neko: entry.neko, publicUrl: entry.publicUrl };
  });
}

// A pool of neko browsers (Chromium on its own X screen, encoded to WebRTC by the container), one
// room per browser. Viewer sessions are logged in on the viewer's behalf with the shared user
// password, so the password never leaves the server, and deleted when the room lets go.
// ponytail: a fixed pool sized by env; upgrade: spawn a container per room through the Docker API.
export function nekoPoolProvider({
  instances,
  password,
  apiToken,
}: {
  instances: NekoInstance[];
  password: string;
  apiToken: string;
}): BrowserProvider {
  const busy = new Set<NekoInstance>();
  return {
    async acquire() {
      const instance = instances.find((candidate) => !busy.has(candidate));
      if (!instance) {
        throw new BrowserPoolExhausted();
      }
      busy.add(instance);
      let cdpUrl: string;
      try {
        cdpUrl = await resolveCdpUrl(new URL(instance.cdp));
      } catch (err) {
        busy.delete(instance);
        throw err;
      }
      const sessionIds = new Set<string>();
      return {
        cdpUrl,
        dedicated: true,
        video: {
          publicUrl: instance.publicUrl,
          async mint(name) {
            const response = await fetch(new URL("/api/login", instance.neko), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: name, password }),
            });
            if (!response.ok) {
              throw new Error(
                `browser video login answered ${response.status}`
              );
            }
            const session: unknown = await response.json();
            if (
              !isRecord(session) ||
              typeof session.id !== "string" ||
              typeof session.token !== "string"
            ) {
              throw new Error("browser video login gave no token");
            }
            sessionIds.add(session.id);
            return session.token;
          },
        },
        async release() {
          await Promise.allSettled(
            [...sessionIds].map((id) =>
              fetch(new URL(`/api/sessions/${id}`, instance.neko), {
                method: "DELETE",
                headers: { authorization: `Bearer ${apiToken}` },
              })
            )
          );
          sessionIds.clear();
          busy.delete(instance);
        },
      };
    },
  };
}
