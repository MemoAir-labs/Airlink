import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  createRunnerHandler,
  hostAllowed,
  jailArgv,
  runJail,
} from "./control.mjs";

const workDir = await mkdtemp(join(tmpdir(), "runner-test-"));
const fontCacheDir = await mkdtemp(join(tmpdir(), "runner-fonts-"));
await writeFile(join(fontCacheDir, "fontlist-v390.json"), "{}");
const calls = [];
const quiet = async () => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
});
let script = quiet;
const server = createServer(
  createRunnerHandler({
    token: "secret",
    workDir,
    fontCacheDir,
    jail: async (file, args, options) => {
      const dir = args[args.indexOf("/out") - 1].slice(0, -"/out".length);
      calls.push({ file, args, options, dir });
      return script(dir);
    },
  })
);
let base = "";

const run = (body, token = "secret") =>
  fetch(`${base}/run`, {
    method: "POST",
    headers: { "x-runner-token": token },
    body: JSON.stringify(body),
  });
const valid = {
  language: "python",
  code: "print(1)",
  files: [],
  timeoutMs: 60_000,
};
const b64 = (text) => Buffer.from(text).toString("base64");

describe("runner control", () => {
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
    script = quiet;
  });

  it("rejects a missing or wrong token before running anything", async () => {
    assert.equal((await run(valid, "wrong")).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.deepEqual(calls, []);
  });

  it("answers only to the names AirLink reaches it by, so a rebound DNS name gets nothing", async () => {
    const status = (host) =>
      new Promise((resolve, reject) => {
        const req = request(`${base}/health`, {
          headers: { host, "x-runner-token": "secret" },
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await status("evil.example:7000"), 421);
    assert.equal(await status("127.0.0.1.nip.io"), 421);
    assert.equal(await status("localhost:3036"), 200);
    assert.equal(await status("runner:7000"), 200);
    assert.ok(hostAllowed("[::1]:7000"));
    assert.ok(hostAllowed("airlink-runner:7000", ["airlink-runner"]));
    assert.ok(!hostAllowed(undefined));
  });

  it("refuses a request it cannot run safely", async () => {
    for (const body of [
      { ...valid, language: "ruby" },
      { ...valid, code: "" },
      { ...valid, timeoutMs: 60_001 },
      { ...valid, files: [{ name: "../x", contentBase64: "" }] },
      { ...valid, files: [{ name: "a/b.csv", contentBase64: "" }] },
      { ...valid, files: [{ name: "..", contentBase64: "" }] },
      {
        ...valid,
        files: [
          { name: "a.csv", contentBase64: "" },
          { name: "a.csv", contentBase64: "" },
        ],
      },
    ]) {
      assert.equal((await run(body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  it("jails the script with only its own directory, a read-only system and the network", async () => {
    let seen = null;
    script = async (dir) => {
      seen = {
        code: await readFile(join(dir, "code", "main.py"), "utf8"),
        csv: await readFile(join(dir, "files", "data.csv"), "utf8"),
        fonts: await readFile(join(dir, "tmp", "fontlist-v390.json"), "utf8"),
      };
      return { exitCode: 0, timedOut: false, stdout: "hi", stderr: "" };
    };
    const response = await run({
      ...valid,
      files: [{ name: "data.csv", contentBase64: b64("a,1") }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, { code: "print(1)", csv: "a,1", fonts: "{}" });
    const [{ file, args, options, dir }] = calls;
    assert.equal(file, "prlimit");
    assert.deepEqual(args, jailArgv({ dir, language: "python" }));
    assert.deepEqual(options, { timeoutMs: 60_000 });
    assert.deepEqual(args.slice(0, 9), [
      "--nproc=256",
      "--fsize=52428800",
      "--as=1073741824",
      "--",
      "choom",
      "-n",
      "1000",
      "--",
      "bwrap",
    ]);
    const sources = (flag) =>
      args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));
    assert.deepEqual(sources("--ro-bind"), [
      "/usr",
      "/etc",
      join(dir, "code"),
      join(dir, "files"),
    ]);
    assert.deepEqual(sources("--bind"), [join(dir, "tmp"), join(dir, "out")]);
    for (const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup",
      "--disable-userns",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(!args.includes("--unshare-net"));
    assert.ok(!args.includes("--unshare-all"));
    assert.deepEqual(args.slice(-3), ["--", "python3", "/code/main.py"]);
    const node = jailArgv({ dir, language: "node" });
    assert.deepEqual(node.slice(-4), [
      "--",
      "node",
      "--max-old-space-size=768",
      "/code/main.mjs",
    ]);
    assert.ok(!node.some((arg) => arg.startsWith("--as=")));
    assert.deepEqual(await readdir(workDir), []);
  });

  it("returns the regular files the run wrote, skips links, and deletes the run's directory", async () => {
    script = async (dir) => {
      const out = join(dir, "out");
      await writeFile(join(out, "chart.png"), "PNG");
      await writeFile(join(out, "index.html"), '<img src="chart.png">');
      await mkdir(join(out, "assets"));
      await writeFile(join(out, "assets", "app.js"), "draw()");
      await symlink("/etc/passwd", join(out, "leak"));
      return { exitCode: 0, timedOut: false, stdout: "done", stderr: "" };
    };
    assert.deepEqual(await (await run(valid)).json(), {
      exitCode: 0,
      timedOut: false,
      stdout: "done",
      stderr: "",
      outputs: [
        {
          name: "assets/app.js",
          mime: "text/javascript; charset=utf-8",
          contentBase64: b64("draw()"),
        },
        { name: "chart.png", mime: "image/png", contentBase64: b64("PNG") },
        {
          name: "index.html",
          mime: "text/html; charset=utf-8",
          contentBase64: b64('<img src="chart.png">'),
        },
      ],
      notes: [
        "1 link or special file was skipped: only regular files are kept.",
      ],
    });
    assert.deepEqual(await readdir(workDir), []);
  });

  it("keeps at most 20 files and 50 MB, and says what it left out", async () => {
    script = async (dir) => {
      for (let i = 0; i < 25; i++) {
        await writeFile(
          join(dir, "out", `f${String(i).padStart(2, "0")}.txt`),
          "x"
        );
      }
      return quiet();
    };
    const many = await (await run(valid)).json();
    assert.equal(many.outputs.length, 20);
    assert.deepEqual(many.notes, [
      "5 files were left out: a run keeps at most 20 files and 50 MB.",
    ]);
    script = async (dir) => {
      await writeFile(
        join(dir, "out", "a.bin"),
        Buffer.alloc(30 * 1024 * 1024)
      );
      await writeFile(
        join(dir, "out", "b.bin"),
        Buffer.alloc(30 * 1024 * 1024)
      );
      return quiet();
    };
    const big = await (await run(valid)).json();
    assert.deepEqual(
      big.outputs.map((output) => output.name),
      ["a.bin"]
    );
    assert.deepEqual(big.notes, [
      "1 file was left out: a run keeps at most 20 files and 50 MB.",
    ]);
  });

  it("kills a run at its time limit and keeps the end of what it printed", async () => {
    const result = await runJail(
      process.execPath,
      [
        "-e",
        "process.stdout.write('a'.repeat(30000) + 'b'.repeat(20000)); setInterval(() => {}, 1000)",
      ],
      { timeoutMs: 500 }
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, "b".repeat(20_000));
  });

  it("refuses a body over the limit without reading it", async () => {
    const status = await new Promise((resolve, reject) => {
      const req = request(`${base}/run`, {
        method: "POST",
        headers: {
          "x-runner-token": "secret",
          "content-length": String(48 * 1024 * 1024 + 1),
        },
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
        req.destroy();
      });
      req.on("error", reject);
      req.flushHeaders();
    });
    assert.equal(status, 400);
    assert.deepEqual(calls, []);
  });

  it("answers a failed run with a generic error and still deletes its directory", async () => {
    script = async () => {
      throw new Error("spawn prlimit ENOENT /secret/path");
    };
    const response = await run(valid);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "the runner failed; see its logs",
    });
    assert.deepEqual(await readdir(workDir), []);
  });

  it("takes back a folder the script locked and still returns and cleans up", async () => {
    script = async (dir) => {
      const locked = join(dir, "out", "locked");
      await mkdir(locked);
      await writeFile(join(locked, "secret.txt"), "s");
      await chmod(locked, 0o000);
      await chmod(join(dir, "tmp"), 0o000);
      return quiet();
    };
    const body = await (await run(valid)).json();
    assert.deepEqual(
      body.outputs.map((output) => output.name),
      ["locked/secret.txt"]
    );
    assert.deepEqual(await readdir(workDir), []);
  });

  it("stops walking a tree deeper than it lists and says so", async () => {
    script = async (dir) => {
      const deep = join(dir, "out", ...Array.from({ length: 20 }, () => "d"));
      await mkdir(deep, { recursive: true });
      await writeFile(join(deep, "bottom.txt"), "x");
      return quiet();
    };
    const body = await (await run(valid)).json();
    assert.deepEqual(body.outputs, []);
    assert.equal(body.notes.length, 1);
    assert.match(body.notes[0], /only partly listed/);
  });

  it("runs at most two at a time and turns the third away", async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    script = async () => {
      await held;
      return quiet();
    };
    const running = Array.from({ length: 2 }, () => run(valid));
    while (calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const third = await run(valid);
    assert.equal(third.status, 429);
    release();
    for (const response of await Promise.all(running)) {
      assert.equal(response.status, 200);
    }
  });
});
