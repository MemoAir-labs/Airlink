import http from "node:http";
import net from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isBlockedHost } from "./index.ts";
import { createPinningProxy } from "./proxy.ts";

const listen = (server: net.Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : 0);
    });
  });

const rawRequest = (port: number, request: string) =>
  new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("close", () => resolve(data));
    setTimeout(() => socket.destroy(), 500);
  });

describe("pinning proxy", () => {
  const target = http.createServer((req, res) => {
    res.end(`hello ${req.headers.host} ${req.url}`);
  });
  const answers: string[][] = [];
  const proxy = createPinningProxy({
    lookup: async () => {
      const next = answers.shift();
      if (!next) {
        throw new Error("no answer");
      }
      return next;
    },
    // The test's only reachable target is loopback; everything else keeps the real rules.
    blocked: (address) => address !== "127.0.0.1" && isBlockedHost(address),
  });
  let targetPort = 0;
  let proxyPort = 0;

  beforeAll(async () => {
    targetPort = await listen(target);
    proxyPort = await listen(proxy);
  });
  afterAll(() => {
    target.close();
    proxy.close();
  });

  it("tunnels CONNECT to the address it resolved and refuses a later private answer", async () => {
    answers.push(["127.0.0.1"], ["10.0.0.5"]);
    const first = await rawRequest(
      proxyPort,
      `CONNECT pinned.example:${targetPort} HTTP/1.1\r\nHost: pinned.example:${targetPort}\r\n\r\n` +
        "GET /tunnel HTTP/1.1\r\nHost: pinned.example\r\nConnection: close\r\n\r\n"
    );
    expect(first).toContain("HTTP/1.1 200 Connection Established");
    expect(first).toContain("hello pinned.example /tunnel");

    const second = await rawRequest(
      proxyPort,
      `CONNECT pinned.example:${targetPort} HTTP/1.1\r\nHost: pinned.example:${targetPort}\r\n\r\n`
    );
    expect(second).toContain("HTTP/1.1 403");
    expect(answers).toEqual([]);
  });

  it("forwards plain http to the resolved address and blocks private literals without resolving", async () => {
    answers.push(["127.0.0.1"]);
    const forwarded = await rawRequest(
      proxyPort,
      `GET http://pinned.example:${targetPort}/plain HTTP/1.1\r\nHost: pinned.example:${targetPort}\r\nConnection: close\r\n\r\n`
    );
    expect(forwarded).toContain("HTTP/1.1 200");
    expect(forwarded).toContain(`hello pinned.example:${targetPort} /plain`);

    const metadata = await rawRequest(
      proxyPort,
      "GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n"
    );
    expect(metadata).toContain("HTTP/1.1 403");

    const direct = await rawRequest(
      proxyPort,
      "GET /not-a-proxy-request HTTP/1.1\r\nHost: whatever\r\nConnection: close\r\n\r\n"
    );
    expect(direct).toContain("HTTP/1.1 400");
    expect(answers).toEqual([]);
  });
});
