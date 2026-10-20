import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { createControlHandler } from "./control.mjs";

const calls = [];
const server = createServer(
  createControlHandler({
    token: "secret",
    exec: async (file, args) => {
      calls.push(["exec", file, ...args]);
      return Buffer.from("1280 800\n");
    },
    detach: async (file, args) => {
      calls.push(["detach", file, ...args]);
    },
    shot: async () => Buffer.from("PNG"),
  })
);
let base = "";

const op = (name, args, token = "secret") =>
  fetch(`${base}/op`, {
    method: "POST",
    headers: { "x-desktop-token": token },
    body: JSON.stringify({ name, args }),
  });

describe("desktop control", () => {
  before(
    () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          base = `http://127.0.0.1:${server.address().port}`;
          resolve();
        });
      })
  );
  after(() => server.close());
  beforeEach(() => {
    calls.length = 0;
  });

  it("rejects a missing or wrong token before running anything", async () => {
    assert.equal((await op("move", [1, 2], "wrong")).status, 401);
    assert.equal((await fetch(`${base}/shot.png`)).status, 401);
    assert.deepEqual(calls, []);
  });

  it("maps each op to an xdotool argv", async () => {
    for (const [name, args] of [
      ["move", [10, 20]],
      ["press", [1]],
      ["release", [3]],
      ["click", [5, 6, 3, 2]],
      ["drag", [1, 2, 3, 4]],
      ["scroll", ["down", 3]],
      ["key", ["ctrl+s", "Return"]],
      ["type", ["-rf hello"]],
    ]) {
      assert.equal((await op(name, args)).status, 200, name);
    }
    assert.deepEqual(calls, [
      ["exec", "xdotool", "mousemove", "10", "20"],
      ["exec", "xdotool", "mousedown", "1"],
      ["exec", "xdotool", "mouseup", "3"],
      ["exec", "xdotool", "mousemove", "5", "6", "click", "--repeat", "2", "3"],
      [
        "exec",
        "xdotool",
        "mousemove",
        "1",
        "2",
        "mousedown",
        "1",
        "sleep",
        "0.1",
        "mousemove",
        "3",
        "4",
        "sleep",
        "0.1",
        "mouseup",
        "1",
      ],
      ["exec", "xdotool", "click", "--repeat", "3", "5"],
      ["exec", "xdotool", "key", "ctrl+s", "Return"],
      ["exec", "xdotool", "type", "--delay", "12", "--", "-rf hello"],
    ]);
  });

  it("reads the screen size and streams a screenshot", async () => {
    assert.deepEqual(await (await op("size", [])).json(), {
      ok: true,
      result: { width: 1280, height: 800 },
    });
    const shot = await fetch(`${base}/shot.png`, {
      headers: { "x-desktop-token": "secret" },
    });
    assert.equal(shot.headers.get("content-type"), "image/png");
    assert.equal(await shot.text(), "PNG");
  });

  it("rejects bad arguments", async () => {
    for (const [name, args] of [
      ["move", [Number.NaN, 1]],
      ["move", ["1", 1]],
      ["press", [4]],
      ["click", [1, 1, 1, 0]],
      ["scroll", ["left", 1]],
      ["key", ["--window"]],
      ["key", ["a", "exec", "sh"]],
      ["key", ["sleep"]],
      ["key", []],
      ["type", ["x".repeat(4097)]],
      ["open", ["--help"]],
      ["open", ["relative/path"]],
      ["open", ["/usr/share/applications/xfce4-terminal.desktop"]],
      ["open", ["file:///tmp/x%2Edesktop"]],
      ["open", ["macro:///Standard.Module1.Main"]],
      ["open", ["vnd.sun.star.script:Standard.Module1.Main"]],
      ["launch", ["calc", "macro:///x"]],
      ["shell", []],
    ]) {
      assert.equal((await op(name, args)).status, 400, `${name} ${args}`);
    }
    assert.deepEqual(calls, []);
  });

  it("rejects a body over 64 KB", async () => {
    assert.equal((await op("type", ["x".repeat(70_000)])).status, 400);
    assert.deepEqual(calls, []);
  });

  it("launches only allowlisted apps, detached", async () => {
    assert.equal((await op("launch", ["terminal"])).status, 200);
    assert.equal((await op("launch", ["calc", "/tmp/a.csv"])).status, 200);
    assert.equal((await op("open", ["https://example.com"])).status, 200);
    assert.equal((await op("launch", ["bash"])).status, 400);
    assert.equal((await op("launch", ["toString"])).status, 400);
    assert.equal((await op("launch", ["editor", "-x"])).status, 400);
    assert.deepEqual(calls, [
      ["detach", "xfce4-terminal"],
      ["detach", "libreoffice", "--calc", "/tmp/a.csv"],
      ["detach", "xdg-open", "https://example.com"],
    ]);
  });
});
