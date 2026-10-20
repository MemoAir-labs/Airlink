import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveAgentClient } from "@memo-air/agent";
import { agentConfigSchema } from "@memo-air/agents";
import { agentMemory } from "@memo-air/bridge";
import { systemActor } from "@memo-air/protocol";
import { signLiveToken } from "@memo-air/protocol/tokens";
import { notSetUpText, readRunnerState, runnerState } from "@memo-air/runner";
import { createLiveServer } from "@memo-air/server";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { z } from "zod";

import type { RunnerControls } from "./api.ts";
import { createApi } from "./api.ts";
import type { Person } from "./identity.ts";
import { newPerson, personCookie, personCookieValue } from "./identity.ts";
import { createRoom, workspaceId } from "./room.ts";
import type { ControlRequest, ControlResult, RunnerControl } from "./runner.ts";
import {
  controlClient,
  createRunner,
  describeRun,
  docStateWriter,
  inputFiles,
} from "./runner.ts";
import { createSettingsFiles, publicSettings } from "./settings.ts";
import { createStore } from "./store.ts";

const databaseUrl = process.env.TEST_LIVE_DATABASE_URI;
const secret = "runner-test-secret";
const runnerInfo = z.object({ available: z.boolean(), frameBase: z.string() });

const controlUrl =
  process.env.AIRLINK_RUNNER_CONTROL_URL ?? "http://localhost:3036";
const controlToken = process.env.AIRLINK_RUNNER_TOKEN ?? "airlink-runner";
const runnerUp = await fetch(`${controlUrl}/health`, {
  headers: { "x-runner-token": controlToken },
}).then(
  (response) => response.ok,
  () => false
);

const answer = (overrides: Partial<ControlResult> = {}): ControlResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  outputs: [],
  notes: [],
  ...overrides,
});

const fakeClock = () => {
  const timers: { ms: number; run: () => void }[] = [];
  return {
    timers,
    after: (ms: number, run: () => void) => {
      const timer = { ms, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) {
          timers.splice(at, 1);
        }
      };
    },
    fire: () => {
      for (const timer of timers.splice(0)) {
        timer.run();
      }
    },
  };
};

describe("inputFiles", () => {
  it("gives every upload one plain name in /files, a second data.csv becoming data (2).csv", () => {
    const named = (name: string) => ({ name, bytes: Buffer.from(name) });
    expect(
      inputFiles([
        named("data.csv"),
        named("data.csv"),
        named("../etc/passwd"),
        named(".."),
        named("a\\b.txt"),
        named("README"),
        named("README"),
      ]).files.map((file) => file.name)
    ).toEqual([
      "data.csv",
      "data (2).csv",
      ".._etc_passwd",
      "_",
      "a_b.txt",
      "README",
      "README (2)",
    ]);
  });

  it("gives a run at most 200 files and says which it left out", () => {
    const many = Array.from({ length: 201 }, (_, at) => ({
      name: `f${at}.txt`,
      bytes: Buffer.from("x"),
    }));
    const given = inputFiles(many, ["late.csv"]);
    expect(given.files).toHaveLength(200);
    expect(given.notes).toEqual([
      "2 of the channel's files were not given to the run (f200.txt, late.csv): a run gets at most 200 files and 32 MB, newest upload first.",
    ]);
  });

  it("says which audio and video uploads it kept out", () => {
    expect(inputFiles([], [], ["call.mp4"]).notes).toEqual([
      "1 audio or video file was not given to the run (call.mp4): runs get no audio or video.",
    ]);
  });
});

describe("controlClient", () => {
  it("waits out a busy runner's 429 and takes the answer that follows", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(bodies.length < 3 ? 429 : 200, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify(
            bodies.length < 3 ? { error: "busy" } : answer({ stdout: "done" })
          )
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const request: ControlRequest = {
      language: "python",
      code: "print(1)",
      files: [],
      timeoutMs: 1000,
    };
    try {
      expect(
        await controlClient({
          controlUrl: `http://127.0.0.1:${port}`,
          token: "t",
          busyRetryMs: 1,
        }).run(request)
      ).toEqual(answer({ stdout: "done" }));
      expect(bodies).toEqual(Array(3).fill(JSON.stringify(request)));
    } finally {
      server.close();
    }
  });
});

describe.skipIf(!databaseUrl)("airlink runners", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = createStore(pool);
  const live = createLiveServer({
    databaseUrl: databaseUrl ?? "",
    jwtSecret: secret,
    port: 0,
    logger: pino({ level: "silent" }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "airlink-runner-test-"));
  const files = createSettingsFiles(dataDir);
  const ada = newPerson("Ada");
  const eve = newPerson("Eve");
  const juno = { kind: "agent" as const, id: "juno", name: "Juno" };
  const cookieOf = (who: Person) =>
    `${personCookie}=${personCookieValue(who, secret)}`;
  const servers: Server[] = [];
  let liveUrl = "";

  beforeAll(async () => {
    await store.init();
    liveUrl = `http://127.0.0.1:${await live.listen()}`;
  });

  afterAll(async () => {
    for (const server of servers) {
      server.close();
    }
    await live.destroy();
    await pool.end();
  });

  const serveApi = async (runner: RunnerControls) => {
    const handleApi = createApi({
      store,
      allowedHosts: ["127.0.0.1"],
      secret,
      liveUrl,
      livePort: 0,
      agents: () => [],
      saveAgents: () => ({ ok: false, error: "not in this test" }),
      settings: () => publicSettings(files.settings(), {}),
      saveSettings: () => ({ ok: false, error: "not in this test" }),
      harnesses: async () => [],
      models: () => [],
      memoryOf: (agent) => agentMemory(join(dataDir, "memory"), agent),
      chatWriters: async () => [],
      transcribeToken: async () => null,
      untouched: async () => false,
      onConfigChanged: () => undefined,
      logger: pino({ level: "silent" }),
      voice: {
        isAvailable: () => false,
        join: async () => {},
        leave: async () => {},
        voices: async () => ({ provider: null, voices: [] }),
        preview: async () => null,
      },
      runner,
    });
    const server = createServer((request, response) => {
      void handleApi(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  };

  const newChannel = async () => {
    const channel = await store.createChannel(
      `r-${crypto.randomUUID().slice(0, 8)}`,
      ada.id
    );
    if (!channel) {
      throw new Error("the channel name was taken");
    }
    return channel;
  };

  const addRunner = (channelId: string, title = "Q3", code = "print(1)") =>
    store.addRunner({
      channelId,
      title,
      language: "python",
      code,
      createdBy: "juno",
    });

  const requests: ControlRequest[] = [];
  let respond: (request: ControlRequest) => Promise<ControlResult> = async () =>
    answer();
  const control: RunnerControl = {
    run: (request) => {
      requests.push(request);
      return respond(request);
    },
    health: async () => true,
  };
  const notes: string[] = [];
  const runnerWith = (withControl: RunnerControl | null, clock = fakeClock()) =>
    createRunner({
      store,
      control: withControl,
      writeState: docStateWriter(live.hocuspocus),
      postNote: async (chatDoc, text) => {
        notes.push(`${chatDoc} ${text}`);
      },
      logger: pino({ level: "silent" }),
      after: clock.after,
    });
  const readState = async (docName: string) => {
    const connection = await live.hocuspocus.openDirectConnection(docName, {
      actor: { kind: "human", id: ada.id, name: ada.name },
      access: "read",
      workspaceId,
    });
    const state = readRunnerState(connection.document ?? new Y.Doc());
    await connection.disconnect();
    return state;
  };

  it("keeps a runner's code, its newest 100 runs and its last run's files, and closes runs a stopped AirLink left open", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    expect(object.kind).toBe("runner");
    await store.updateRunner(object.docName, {
      title: "Q3 revenue",
      language: "node",
      code: "console.log(1)",
    });
    expect(await store.runner(object.docName)).toMatchObject({
      title: "Q3 revenue",
      language: "node",
      code: "console.log(1)",
      refreshMinutes: 0,
      paused: false,
      failures: 0,
      channel: { id: channel.id },
    });
    await store.setRunnerSchedule(object.docName, { refreshMinutes: 5 });
    expect(await store.scheduledRunners()).toContain(object.docName);
    await store.setRunnerSchedule(object.docName, { paused: true });
    expect(await store.scheduledRunners()).not.toContain(object.docName);

    for (let i = 0; i < 102; i++) {
      const runId = await store.startRun(object.docName, juno);
      await store.finishRun(runId, object.docName, {
        status: "ok",
        exitCode: 0,
        stdout: `${i}`,
        stderr: "",
        files: [
          {
            name: "n.txt",
            mime: "text/plain; charset=utf-8",
            bytes: Buffer.from(`${i}`),
          },
        ],
      });
    }
    const runs = await pool.query(
      "SELECT stdout FROM airlink_runs WHERE doc_name = $1 ORDER BY id",
      [object.docName]
    );
    expect(runs.rows.length).toBe(100);
    expect(runs.rows[0].stdout).toBe("2");
    expect(
      (await store.runFile(object.docName, "n.txt"))?.bytes.toString()
    ).toBe("101");

    const open = await store.startRun(object.docName, juno);
    expect(
      await store.failUnfinishedRuns("AirLink restarted during this run.")
    ).toContain(object.docName);
    expect(
      (
        await pool.query(
          "SELECT status, stderr FROM airlink_runs WHERE id = $1",
          [open]
        )
      ).rows[0]
    ).toEqual({
      status: "error",
      stderr: "AirLink restarted during this run.",
    });

    await store.addFile({
      channelId: channel.id,
      name: "a.csv",
      mime: "text/csv",
      bytes: Buffer.from("a"),
      createdBy: ada.id,
    });
    await store.addFile({
      channelId: channel.id,
      name: "b.csv",
      mime: "text/csv",
      bytes: Buffer.from("b"),
      createdBy: ada.id,
    });
    expect(
      await store.channelFiles(channel.id, { maxFiles: 200, maxBytes: 100 })
    ).toEqual({
      files: [
        { name: "b.csv", bytes: Buffer.from("b") },
        { name: "a.csv", bytes: Buffer.from("a") },
      ],
      skipped: [],
      media: [],
    });
    expect(
      await store.channelFiles(channel.id, { maxFiles: 1, maxBytes: 100 })
    ).toEqual({
      files: [{ name: "b.csv", bytes: Buffer.from("b") }],
      skipped: ["a.csv"],
      media: [],
    });
    expect(
      (await store.channelFiles(channel.id, { maxFiles: 200, maxBytes: 1 }))
        .skipped
    ).toEqual(["a.csv"]);
    await store.addFile({
      channelId: channel.id,
      name: "standup.m4a",
      mime: "audio/mp4",
      bytes: Buffer.from("AUDIO-LARGER-THAN-THE-CAP"),
      createdBy: ada.id,
    });
    expect(
      await store.channelFiles(channel.id, { maxFiles: 2, maxBytes: 2 })
    ).toEqual({
      files: [
        { name: "b.csv", bytes: Buffer.from("b") },
        { name: "a.csv", bytes: Buffer.from("a") },
      ],
      skipped: [],
      media: ["standup.m4a"],
    });

    const late = await store.startRun(object.docName, juno);
    await store.deleteObject(channel.id, object.docName);
    expect(
      await store.finishRun(late, object.docName, {
        status: "ok",
        exitCode: 0,
        stdout: "",
        stderr: "",
        files: [],
      })
    ).toBe(false);
    expect(await store.runner(object.docName)).toBeNull();
  });

  it("serves a run's files sandboxed with scripts allowed, to members only, and to the dashboard frame by its link", async () => {
    const forgotten: string[] = [];
    const apiUrl = await serveApi({
      reachable: async () => true,
      rerun: () => "started",
      setPaused: async () => {},
      forget: (docName) => {
        forgotten.push(docName);
      },
    });
    const get = (path: string, cookie?: string) =>
      fetch(`${apiUrl}${path}`, cookie ? { headers: { Cookie: cookie } } : {});
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const runId = await store.startRun(object.docName, juno);
    await store.finishRun(runId, object.docName, {
      status: "ok",
      exitCode: 0,
      stdout: "",
      stderr: "",
      files: [
        {
          name: "index.html",
          mime: "text/html; charset=utf-8",
          bytes: Buffer.from(
            '<img src="chart.png"><script>fetch("data/q3.json")</script>'
          ),
        },
        { name: "chart.png", mime: "image/png", bytes: Buffer.from("PNG") },
        {
          name: "data/q3.json",
          mime: "application/json",
          bytes: Buffer.from("[1,2]"),
        },
        {
          name: "report.pdf",
          mime: "application/pdf",
          bytes: Buffer.from("%PDF-1.4"),
        },
      ],
    });
    const doc = encodeURIComponent(object.docName);

    const pdf = await get(`/api/runs/${doc}/out/report.pdf`, cookieOf(ada));
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-security-policy")).toBeNull();
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");

    const chart = await get(`/api/runs/${doc}/out/chart.png`, cookieOf(ada));
    expect(chart.status).toBe(200);
    expect(chart.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts"
    );
    expect(chart.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await chart.text()).toBe("PNG");
    expect(
      await (
        await get(`/api/runs/${doc}/out/data/q3.json`, cookieOf(ada))
      ).text()
    ).toBe("[1,2]");
    expect(
      (await get(`/api/runs/${doc}/out/chart.png`, cookieOf(eve))).status
    ).toBe(403);
    expect((await get(`/api/runs/${doc}`, cookieOf(eve))).status).toBe(403);

    // The frame's document is an opaque origin: its requests carry no cookie and its fetch is
    // cross-origin, so the link is the credential.
    const info = runnerInfo.parse(
      await (await get(`/api/runs/${doc}`, cookieOf(ada))).json()
    );
    expect(info.available).toBe(true);
    const framed = await get(`${info.frameBase}data/q3.json`);
    expect(framed.status).toBe(200);
    expect(framed.headers.get("access-control-allow-origin")).toBe("*");
    expect(framed.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts"
    );
    expect(await framed.text()).toBe("[1,2]");

    const grant = info.frameBase.split("/")[5];
    const liveToken = signLiveToken(
      {
        actor: { kind: "human", id: ada.id, name: ada.name },
        workspaceId,
        docName: object.docName,
        access: "read",
      },
      secret
    );
    expect(
      (await get(`/api/runs/${doc}/frame/${liveToken}/chart.png`)).status
    ).toBe(403);
    const other = await addRunner(channel.id, "Other");
    expect(
      (
        await get(
          `/api/runs/${encodeURIComponent(other.docName)}/frame/${grant}/chart.png`
        )
      ).status
    ).toBe(403);

    const bob = newPerson("Bob");
    await store.addMembers(channel.id, [{ kind: "human", id: bob.id }], ada.id);
    const bobFrame = runnerInfo.parse(
      await (await get(`/api/runs/${doc}`, cookieOf(bob))).json()
    ).frameBase;
    expect((await get(`${bobFrame}chart.png`)).status).toBe(200);
    await store.removeMember(channel.id, { kind: "human", id: bob.id });
    expect((await get(`${bobFrame}chart.png`)).status).toBe(403);

    await fetch(`${apiUrl}/api/channels/${channel.id}/objects/${doc}`, {
      method: "DELETE",
      headers: { Cookie: cookieOf(ada), "Content-Type": "application/json" },
    });
    expect(forgotten).toEqual([object.docName]);
    expect(await store.runFile(object.docName, "chart.png")).toBeNull();
    expect(
      (
        await pool.query("SELECT 1 FROM airlink_runs WHERE doc_name = $1", [
          object.docName,
        ])
      ).rowCount
    ).toBe(0);
  });

  it("re-runs and pauses a runner for its channel's members only, and refuses a second run while one is going", async () => {
    const reruns: string[] = [];
    const paused: string[] = [];
    let busy = false;
    const apiUrl = await serveApi({
      reachable: async () => true,
      rerun: (docName, actor) => {
        if (busy) {
          return "running";
        }
        reruns.push(`${docName} ${actor.id}`);
        return "started";
      },
      setPaused: async (docName, value) => {
        paused.push(`${docName} ${value}`);
      },
      forget: () => {},
    });
    const post = (base: string, path: string, body: unknown, cookie: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const doc = encodeURIComponent(object.docName);

    expect(
      (await post(apiUrl, `/api/runs/${doc}/run`, {}, cookieOf(ada))).status
    ).toBe(202);
    expect(reruns).toEqual([`${object.docName} ${ada.id}`]);
    busy = true;
    expect(
      (await post(apiUrl, `/api/runs/${doc}/run`, {}, cookieOf(ada))).status
    ).toBe(409);
    expect(
      (await post(apiUrl, `/api/runs/${doc}/run`, {}, cookieOf(eve))).status
    ).toBe(403);
    expect(
      (
        await post(
          apiUrl,
          `/api/runs/${doc}/paused`,
          { paused: true },
          cookieOf(ada)
        )
      ).status
    ).toBe(200);
    expect(paused).toEqual([`${object.docName} true`]);
    const sheet = await store.addObject({
      channelId: channel.id,
      kind: "sheet",
      title: "Q3",
      createdBy: ada.id,
    });
    expect(
      (
        await post(
          apiUrl,
          `/api/runs/${encodeURIComponent(sheet.docName)}/run`,
          {},
          cookieOf(ada)
        )
      ).status
    ).toBe(404);

    const offUrl = await serveApi({
      reachable: async () => false,
      rerun: () => "unavailable",
      setPaused: async () => {},
      forget: () => {},
    });
    const off = await post(offUrl, `/api/runs/${doc}/run`, {}, cookieOf(ada));
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: notSetUpText });
  });

  it("runs the stored code with only its channel's files, records the run and shows it in the doc", async () => {
    const mine = await newChannel();
    const theirs = await newChannel();
    for (const text of ["x,1", "x,2"]) {
      await store.addFile({
        channelId: mine.id,
        name: "data.csv",
        mime: "text/csv",
        bytes: Buffer.from(text),
        createdBy: ada.id,
      });
    }
    await store.addFile({
      channelId: mine.id,
      name: "call.webm",
      mime: "video/webm",
      bytes: Buffer.from("VIDEO"),
      createdBy: ada.id,
    });
    await store.addFile({
      channelId: theirs.id,
      name: "secret.txt",
      mime: "text/plain",
      bytes: Buffer.from("TOP-SECRET"),
      createdBy: ada.id,
    });
    const object = await addRunner(mine.id);
    requests.length = 0;
    respond = async () =>
      answer({
        stdout: "hello",
        outputs: [
          {
            name: "index.html",
            mime: "text/html; charset=utf-8",
            contentBase64: Buffer.from("<h1>Q3</h1>").toString("base64"),
          },
        ],
      });

    const outcome = await runnerWith(control).run(object.docName, juno);

    expect(requests).toEqual([
      {
        language: "python",
        code: "print(1)",
        files: [
          {
            name: "data.csv",
            contentBase64: Buffer.from("x,2").toString("base64"),
          },
          {
            name: "data (2).csv",
            contentBase64: Buffer.from("x,1").toString("base64"),
          },
        ],
        timeoutMs: 60_000,
      },
    ]);
    expect(await readState(object.docName)).toMatchObject({
      title: "Q3",
      code: "print(1)",
      status: "ok",
      stdout: "hello",
      lastRunBy: juno,
      hasDashboard: true,
      outputs: [
        { name: "index.html", mime: "text/html; charset=utf-8", sizeBytes: 11 },
      ],
      notes: [
        "1 audio or video file was not given to the run (call.webm): runs get no audio or video.",
      ],
    });
    expect(
      (
        await pool.query(
          "SELECT status, exit_code, ended_at IS NOT NULL AS ended FROM airlink_runs WHERE doc_name = $1",
          [object.docName]
        )
      ).rows
    ).toEqual([{ status: "ok", exit_code: 0, ended: true }]);
    expect(
      (await store.runFile(object.docName, "index.html"))?.bytes.toString()
    ).toBe("<h1>Q3</h1>");
    const text = describeRun(outcome);
    expect(text).toContain(`Runner ${object.docName} ("Q3"): ok, exit code 0.`);
    expect(text).toContain("hello");
    expect(text).toContain("index.html is shown as the runner's dashboard.");
  });

  it("never runs a person's edit to the code, and never runs one runner twice at once", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const runner = runnerWith(control);
    const edit = await live.hocuspocus.openDirectConnection(object.docName, {
      actor: { kind: "human", id: ada.id, name: ada.name },
      access: "write",
      workspaceId,
    });
    await edit.transact((doc) => {
      runnerState(doc).set("code", "import shutil; shutil.rmtree('/out')");
    });
    await edit.disconnect();
    requests.length = 0;
    let release = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve(answer());
      });

    expect(
      runner.rerun(object.docName, {
        kind: "human",
        id: ada.id,
        name: ada.name,
      })
    ).toBe("started");
    expect(runner.rerun(object.docName, juno)).toBe("running");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    release();
    await vi.waitFor(async () =>
      expect((await readState(object.docName)).status).toBe("ok")
    );
    expect(requests[0].code).toBe("print(1)");
    expect((await readState(object.docName)).code).toBe("print(1)");
  });

  it("turns a timeout, an unreachable container and a mid-run failure into a status and a note the next run clears", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const runner = runnerWith(control);

    respond = async () =>
      answer({ exitCode: null, timedOut: true, stdout: "partial" });
    const timedOut = await runner.run(object.docName, juno);
    expect(timedOut).toMatchObject({
      ok: true,
      status: "timeout",
      exitCode: null,
      stdout: "partial",
    });
    expect(describeRun(timedOut)).toContain("It was stopped after 60 s");

    respond = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3036"), {
          code: "ECONNREFUSED",
        }),
      });
    };
    await runner.run(object.docName, juno);
    expect(await readState(object.docName)).toMatchObject({
      status: "error",
      notes: [`${notSetUpText} (the runner container is not reachable)`],
    });

    respond = async () => {
      throw new Error("socket hang up");
    };
    await runner.run(object.docName, juno);
    expect(await readState(object.docName)).toMatchObject({
      status: "error",
      notes: ["The runner stopped during this run: socket hang up"],
    });

    respond = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        }),
      });
    };
    await runner.run(object.docName, juno);
    expect((await readState(object.docName)).notes).toEqual([
      "The runner stopped during this run: fetch failed (read ECONNRESET)",
    ]);

    respond = async () => answer({ stdout: "fine" });
    await runner.run(object.docName, juno);
    expect(await readState(object.docName)).toMatchObject({
      status: "ok",
      notes: [],
    });

    const off = runnerWith(null);
    expect(off.available).toBe(false);
    expect(await off.reachable()).toBe(false);
    expect(off.rerun(object.docName, juno)).toBe("unavailable");
    expect(await off.run(object.docName, juno)).toEqual({
      ok: false,
      text: notSetUpText,
    });
  });

  it("re-runs on its schedule, skips a tick while a run is going, and pauses after three failed refreshes with a note in chat", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const clock = fakeClock();
    const runner = runnerWith(control, clock);
    requests.length = 0;
    notes.length = 0;
    respond = async () => answer();

    await runner.setRefresh(object.docName, 1);
    expect(clock.timers.map((timer) => timer.ms)).toEqual([60_000]);
    expect(await readState(object.docName)).toMatchObject({
      refreshMinutes: 1,
      paused: false,
    });
    clock.fire();
    await vi.waitFor(() => expect(clock.timers).toHaveLength(1));
    expect(requests).toHaveLength(1);
    expect((await readState(object.docName)).lastRunBy).toEqual(systemActor);

    let release = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve(answer());
      });
    expect(runner.rerun(object.docName, juno)).toBe("started");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    clock.fire();
    await vi.waitFor(() => expect(clock.timers).toHaveLength(1));
    expect(requests).toHaveLength(2);
    release();
    await vi.waitFor(async () =>
      expect((await readState(object.docName)).status).toBe("ok")
    );

    respond = async () =>
      answer({ exitCode: 1, stderr: "KeyError: 'revenue'" });
    for (let failed = 1; failed <= 3; failed++) {
      await vi.waitFor(() => expect(clock.timers).toHaveLength(1));
      clock.fire();
      await vi.waitFor(async () =>
        expect((await store.runner(object.docName))?.failures).toBe(failed)
      );
    }
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]).toContain(
      `${channel.chatDoc} "Q3" failed 3 scheduled runs in a row`
    );
    expect(await store.runner(object.docName)).toMatchObject({
      paused: true,
      failures: 3,
    });
    expect((await readState(object.docName)).paused).toBe(true);
    expect(clock.timers).toHaveLength(0);

    await runner.setPaused(object.docName, false);
    expect(await store.runner(object.docName)).toMatchObject({
      paused: false,
      failures: 0,
    });
    expect(clock.timers).toHaveLength(1);
    runner.close();
    expect(clock.timers).toHaveLength(0);
  });

  it("makes a runner for an agent's run_code, places it in the channel's space, and re-runs that one by id", async () => {
    const channel = await newChannel();
    const agent = agentConfigSchema.parse({ id: "juno", name: "Juno" });
    respond = async () => answer({ stdout: "1" });
    const room = createRoom({
      store,
      liveUrl,
      jwtSecret: secret,
      runner: runnerWith(control),
    });

    const first = await room.runCode?.({
      chatDoc: channel.chatDoc,
      agent,
      language: "python",
      code: "print(1)",
      title: "Q3",
      runnerId: null,
    });

    expect(first?.ok).toBe(true);
    const objects = await room.objectsOf(channel.chatDoc);
    expect(objects).toEqual([
      { id: expect.any(String), title: "Q3", kind: "runner" },
    ]);
    expect(first?.text).toContain(`Runner ${objects[0].id} ("Q3"): ok`);
    const space = await createLiveAgentClient({
      baseUrl: liveUrl,
      docName: channel.spaceDoc,
      token: signLiveToken(
        {
          actor: { kind: "human", id: ada.id, name: ada.name },
          workspaceId,
          docName: channel.spaceDoc,
          access: "write",
        },
        secret
      ),
    }).readSpace();
    expect(space.objects.map((object) => object.docName)).toEqual([
      objects[0].id,
    ]);

    await room.runCode?.({
      chatDoc: channel.chatDoc,
      agent,
      language: "node",
      code: "console.log(2)",
      title: "Q3 v2",
      runnerId: objects[0].id,
    });
    expect(await room.objectsOf(channel.chatDoc)).toHaveLength(1);
    expect(await store.runner(objects[0].id)).toMatchObject({
      title: "Q3 v2",
      language: "node",
      code: "console.log(2)",
    });
    expect(
      await room.scheduleRunner?.({
        chatDoc: channel.chatDoc,
        agent,
        runnerId: objects[0].id,
        refreshMinutes: 2,
      })
    ).toEqual({
      ok: true,
      text: "The runner re-runs every 2 minutes while the channel exists; anyone in the channel can pause it.",
    });

    expect(
      createRoom({
        store,
        liveUrl,
        jwtSecret: secret,
        runner: runnerWith(null),
      }).runCode
    ).toBeUndefined();
    expect(
      createRoom({ store, liveUrl, jwtSecret: secret }).runCode
    ).toBeUndefined();
  });

  it("refuses a busy runner's new code unsaved, and a runner of another channel", async () => {
    const mine = await newChannel();
    const theirs = await newChannel();
    const agent = agentConfigSchema.parse({ id: "juno", name: "Juno" });
    const object = await addRunner(mine.id);
    const other = await addRunner(theirs.id);
    const room = createRoom({
      store,
      liveUrl,
      jwtSecret: secret,
      runner: runnerWith(control),
    });
    let release = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve(answer());
      });
    const call = { chatDoc: mine.chatDoc, agent, language: "python" as const };
    requests.length = 0;

    const running = room.runCode?.({
      ...call,
      code: "print(1)",
      title: "Q3",
      runnerId: object.docName,
    });
    await vi.waitFor(async () =>
      expect((await store.runner(object.docName))?.code).toBe("print(1)")
    );
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const busy = await room.runCode?.({
      ...call,
      code: "print(2)",
      title: "New",
      runnerId: object.docName,
    });
    expect(busy).toEqual({
      ok: false,
      text: "That runner is still running its last job; wait for it to finish, then call run_code again.",
    });
    expect(await store.runner(object.docName)).toMatchObject({
      code: "print(1)",
      title: "Q3",
    });
    release();
    await running;

    expect(
      await room.runCode?.({
        ...call,
        code: "print(3)",
        title: "Stolen",
        runnerId: other.docName,
      })
    ).toEqual({
      ok: false,
      text: `No runner ${other.docName} is in this room.`,
    });
    expect((await store.runner(other.docName))?.code).toBe("print(1)");
    expect(
      await room.scheduleRunner?.({
        chatDoc: mine.chatDoc,
        agent,
        runnerId: other.docName,
        refreshMinutes: 1,
      })
    ).toMatchObject({ ok: false });
    expect(
      await room.scheduleRunner?.({
        chatDoc: mine.chatDoc,
        agent,
        runnerId: "gone",
        refreshMinutes: 1,
      })
    ).toMatchObject({ ok: false });
  });

  it("closes a run a stopped AirLink left open and arms every schedule again at start", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    await store.setRunnerSchedule(object.docName, { refreshMinutes: 5 });
    await docStateWriter(live.hocuspocus)(object.docName, {
      status: "running",
    });
    await store.startRun(object.docName, juno);
    const clock = fakeClock();

    await runnerWith(control, clock).start();

    expect(await readState(object.docName)).toMatchObject({
      status: "error",
      notes: ["AirLink restarted during this run."],
    });
    expect(clock.timers.map((timer) => timer.ms)).toContain(300_000);
  });

  it("drops a run whose runner was deleted while it ran, and forgetting a runner disarms its schedule", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const clock = fakeClock();
    const runner = runnerWith(control, clock);
    let release = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve(answer());
      });
    requests.length = 0;
    const pending = runner.run(object.docName, juno);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await store.deleteObject(channel.id, object.docName);
    release();
    expect(await pending).toEqual({ ok: false, text: "That runner is gone." });

    const other = await addRunner(channel.id);
    await runner.setRefresh(other.docName, 5);
    expect(clock.timers).toHaveLength(1);
    runner.forget(other.docName);
    expect(clock.timers).toHaveLength(0);
  });

  it("finishes a run as an error when something before the container throws", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    let writes = 0;
    const write = docStateWriter(live.hocuspocus);
    const runner = createRunner({
      store,
      control,
      writeState: async (docName, patch) => {
        writes++;
        if (writes === 1) {
          throw new Error("the doc is gone");
        }
        await write(docName, patch);
      },
      postNote: async () => {},
      logger: pino({ level: "silent" }),
      after: fakeClock().after,
    });
    expect(await runner.run(object.docName, juno)).toMatchObject({
      ok: true,
      status: "error",
      notes: ["The runner stopped during this run: the doc is gone"],
    });
    expect(
      (
        await pool.query(
          "SELECT status, ended_at IS NOT NULL AS ended FROM airlink_runs WHERE doc_name = $1",
          [object.docName]
        )
      ).rows
    ).toEqual([{ status: "error", ended: true }]);
  });

  it("asks the container before run_code makes a runner, and makes none when nothing answers", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve)
    );
    const address = closed.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve) => closed.close(resolve));
    const runner = runnerWith(
      controlClient({ controlUrl: `http://127.0.0.1:${port}`, token: "t" })
    );
    expect(runner.available).toBe(true);
    expect(await runner.reachable()).toBe(false);

    const channel = await newChannel();
    const room = createRoom({ store, liveUrl, jwtSecret: secret, runner });
    expect(
      await room.runCode?.({
        chatDoc: channel.chatDoc,
        agent: agentConfigSchema.parse({ id: "juno", name: "Juno" }),
        language: "python",
        code: "print(1)",
        title: "Q3",
        runnerId: null,
      })
    ).toEqual({
      ok: false,
      text: `${notSetUpText} (the runner container is not reachable)`,
    });
    expect(await room.objectsOf(channel.chatDoc)).toEqual([]);

    const apiUrl = await serveApi(runner);
    const object = await addRunner(channel.id);
    const info = runnerInfo.parse(
      await (
        await fetch(
          `${apiUrl}/api/runs/${encodeURIComponent(object.docName)}`,
          { headers: { Cookie: cookieOf(ada) } }
        )
      ).json()
    );
    expect(info.available).toBe(false);
  });

  it("reports a run that throws after its runner was placed as a failed run, not an unplaced runner", async () => {
    const channel = await newChannel();
    const room = createRoom({
      store,
      liveUrl,
      jwtSecret: secret,
      runner: {
        ...runnerWith(control),
        run: async () => {
          throw new Error("the store went away");
        },
      },
    });
    expect(
      await room.runCode?.({
        chatDoc: channel.chatDoc,
        agent: agentConfigSchema.parse({ id: "juno", name: "Juno" }),
        language: "python",
        code: "print(1)",
        title: "Q3",
        runnerId: null,
      })
    ).toEqual({
      ok: false,
      text: "The code could not be run: the store went away",
    });
    expect(await room.objectsOf(channel.chatDoc)).toHaveLength(1);
  });

  it("finishes the doc as an error when the run's last write fails, never leaving it running", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    let writes = 0;
    const write = docStateWriter(live.hocuspocus);
    respond = async () => answer({ stdout: "fine" });
    const runner = createRunner({
      store,
      control,
      writeState: async (docName, patch) => {
        writes++;
        if (writes === 2) {
          throw new Error("the connection dropped");
        }
        await write(docName, patch);
      },
      postNote: async () => {},
      logger: pino({ level: "silent" }),
      after: fakeClock().after,
    });
    expect(await runner.run(object.docName, juno)).toMatchObject({
      ok: true,
      status: "ok",
    });
    expect(await readState(object.docName)).toMatchObject({
      status: "error",
      notes: [
        "The run finished (ok) but its result could not be shown: the connection dropped",
      ],
    });
  });

  it("arms nothing once closed, even when a tick was in flight", async () => {
    const channel = await newChannel();
    const object = await addRunner(channel.id);
    const clock = fakeClock();
    const runner = runnerWith(control, clock);
    let release = () => {};
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve(answer());
      });
    requests.length = 0;
    await runner.setRefresh(object.docName, 1);
    clock.fire();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    runner.close();
    release();
    await vi.waitFor(async () =>
      expect((await readState(object.docName)).status).toBe("ok")
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(clock.timers).toHaveLength(0);
  });

  describe.skipIf(!runnerUp)("with the runner container up", () => {
    const real = () =>
      runnerWith(controlClient({ controlUrl, token: controlToken }));

    it("turns an uploaded CSV into a PNG and a dashboard the route serves", async () => {
      const channel = await newChannel();
      await store.addFile({
        channelId: channel.id,
        name: "sales.csv",
        mime: "text/csv",
        bytes: Buffer.from("month,revenue\nJul,10\nAug,20\nSep,30\n"),
        createdBy: ada.id,
      });
      const object = await addRunner(
        channel.id,
        "Revenue",
        [
          "import pandas as pd",
          "import matplotlib.pyplot as plt",
          "df = pd.read_csv('/files/sales.csv')",
          "df.plot(x='month', y='revenue', kind='bar', legend=False)",
          "plt.savefig('/out/chart.png')",
          "total = int(df['revenue'].sum())",
          "open('/out/index.html', 'w').write(f'<h1>Revenue {total}</h1><img src=\"chart.png\">')",
          "print(total)",
        ].join("\n")
      );
      const runner = real();
      const outcome = await runner.run(object.docName, juno);
      expect(outcome).toMatchObject({
        ok: true,
        status: "ok",
        exitCode: 0,
        stdout: "60\n",
      });
      expect(outcome.ok && outcome.stderr).not.toContain("font cache");
      const apiUrl = await serveApi(runner);
      const doc = encodeURIComponent(object.docName);
      const chart = await fetch(`${apiUrl}/api/runs/${doc}/out/chart.png`, {
        headers: { Cookie: cookieOf(ada) },
      });
      expect(chart.headers.get("content-type")).toBe("image/png");
      expect(
        Buffer.from(await chart.arrayBuffer())
          .subarray(1, 4)
          .toString()
      ).toBe("PNG");
      const page = await fetch(`${apiUrl}/api/runs/${doc}/out/index.html`, {
        headers: { Cookie: cookieOf(ada) },
      });
      expect(page.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts"
      );
      expect(await page.text()).toContain("Revenue 60");
    }, 90_000);

    it("gives a run only its own channel's files", async () => {
      const mine = await newChannel();
      const theirs = await newChannel();
      await store.addFile({
        channelId: mine.id,
        name: "a.txt",
        mime: "text/plain",
        bytes: Buffer.from("a"),
        createdBy: ada.id,
      });
      await store.addFile({
        channelId: theirs.id,
        name: "secret.txt",
        mime: "text/plain",
        bytes: Buffer.from("TOP-SECRET"),
        createdBy: ada.id,
      });
      const object = await addRunner(
        mine.id,
        "Look around",
        [
          "import glob, os",
          "print(sorted(os.listdir('/files')))",
          "print([p for root in ['/var', '/tmp', '/home', '/run', '/srv', '/opt', '/out', '/files'] for p in glob.glob(root + '/**/secret.txt', recursive=True)])",
        ].join("\n")
      );
      expect(await real().run(object.docName, juno)).toMatchObject({
        status: "ok",
        stdout: "['a.txt']\n[]\n",
      });
    }, 90_000);

    it("kills a runaway script at 60 s and keeps what it printed", async () => {
      const channel = await newChannel();
      const object = await addRunner(
        channel.id,
        "Forever",
        "print('started', flush=True)\nwhile True:\n    pass"
      );
      const startedAtMs = Date.now();
      const outcome = await real().run(object.docName, juno);
      const tookMs = Date.now() - startedAtMs;
      expect(outcome).toMatchObject({
        status: "timeout",
        exitCode: null,
        stdout: "started\n",
      });
      expect(tookMs).toBeGreaterThanOrEqual(60_000);
      expect(tookMs).toBeLessThan(75_000);
    }, 90_000);
  });
});
