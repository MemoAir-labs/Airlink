import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";

import { type AddressLookup, isBlockedHost } from "./index.ts";

// Chromium is launched with --proxy-server pointing here, so every connection a page opens is
// dialed by live-server to an address it resolved and checked itself. Fetch.requestPaused stays
// the cheap first check on the URL; this closes the window between that check and Chromium's own
// resolution, where a public name could start answering with a private address.
const defaultLookup: AddressLookup = async (host) =>
  (await dnsLookup(host, { all: true })).map((entry) => entry.address);

type Dial = { ok: true; address: string } | { ok: false; status: 400 | 403 };

export function createPinningProxy({
  lookup = defaultLookup,
  blocked = isBlockedHost,
  onRefused = () => {},
}: {
  lookup?: AddressLookup;
  blocked?: (address: string) => boolean;
  onRefused?: (host: string) => void;
} = {}): http.Server {
  const resolveDial = async (host: string): Promise<Dial> => {
    const bare = host.replace(/^\[|\]$/g, "");
    if (!bare || blocked(bare)) {
      return { ok: false, status: 403 };
    }
    if (net.isIP(bare)) {
      return { ok: true, address: bare };
    }
    let addresses: string[];
    try {
      addresses = await lookup(bare);
    } catch {
      return { ok: false, status: 403 };
    }
    if (!addresses.length || addresses.some(blocked)) {
      return { ok: false, status: 403 };
    }
    // ponytail: IPv4 first instead of Happy Eyeballs; a host whose resolver answers IPv6 first
    // on a network without an IPv6 route would otherwise never connect. Upgrade: try each
    // address in turn.
    return {
      ok: true,
      address:
        addresses.find((address) => net.isIP(address) === 4) ?? addresses[0],
    };
  };

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const dial = await resolveDial(url.hostname);
    if (!dial.ok) {
      onRefused(url.hostname);
      res.writeHead(dial.status).end();
      return;
    }
    const upstream = http.request(
      {
        host: dial.address,
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, host: url.host },
        setHost: false,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502);
      }
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, socket, head) => {
    let target: URL;
    try {
      target = new URL(`http://${req.url ?? ""}`);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const dial = await resolveDial(target.hostname);
    if (!dial.ok) {
      onRefused(target.hostname);
      socket.end(`HTTP/1.1 ${dial.status} Refused\r\n\r\n`);
      return;
    }
    const upstream = net.connect(
      Number(target.port || 443),
      dial.address,
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      }
    );
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return server;
}
