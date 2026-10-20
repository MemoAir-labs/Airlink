import http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserPoolExhausted, nekoPoolProvider } from "./provider.ts";

type Call = { method: string; url: string; body: string; auth: string };

// A neko that answers the three calls the pool makes, recording each.
function fakeNeko() {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        auth: req.headers.authorization ?? "",
      });
      if (req.url === "/json/version") {
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: "ws://localhost:9222/devtools/browser/abc",
          })
        );
      } else if (req.url === "/api/login") {
        res.end(
          JSON.stringify({ id: `${JSON.parse(body).username}-1`, token: "tok" })
        );
      } else if (req.url?.startsWith("/api/sessions/")) {
        res.statusCode = 204;
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  return { server, calls };
}

describe("neko pool provider", () => {
  const one = fakeNeko();
  const two = fakeNeko();
  let urls: string[] = [];

  beforeAll(async () => {
    urls = await Promise.all(
      [one, two].map(
        ({ server }) =>
          new Promise<string>((resolve) =>
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              resolve(
                `http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}`
              );
            })
          )
      )
    );
  });

  afterAll(() => {
    one.server.close();
    two.server.close();
  });

  it("leases one browser per room, mints named viewer sessions and deletes them on release", async () => {
    const provider = nekoPoolProvider({
      instances: urls.map((url, i) => ({
        cdp: url,
        neko: url,
        publicUrl: `http://public-${i}`,
      })),
      password: "pw",
      apiToken: "admin-token",
    });
    const first = await provider.acquire("doc-1");
    const second = await provider.acquire("doc-2");
    expect(first.cdpUrl).toBe(
      `${urls[0].replace("http", "ws")}/devtools/browser/abc`
    );
    expect(first.dedicated).toBe(true);
    expect(second.video?.publicUrl).toBe("http://public-1");
    await expect(provider.acquire("doc-3")).rejects.toBeInstanceOf(
      BrowserPoolExhausted
    );

    expect(await first.video?.mint("Ada")).toBe("tok");
    expect(one.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/login",
      body: JSON.stringify({ username: "Ada", password: "pw" }),
    });

    await first.release();
    expect(one.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "/api/sessions/Ada-1",
      auth: "Bearer admin-token",
    });
    const third = await provider.acquire("doc-3");
    expect(third.cdpUrl).toBe(first.cdpUrl);
  });
});
