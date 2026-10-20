import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveAgentClient } from "@memo-air/agent";
import { agentMemory } from "@memo-air/bridge";
import { verifyLiveToken } from "@memo-air/protocol/tokens";
import { createLiveServer } from "@memo-air/server";
import pg from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApi } from "./api.ts";
import { newPerson, personCookie, personCookieValue } from "./identity.ts";
import { createRoom, workspaceId } from "./room.ts";
import { createSettingsFiles, publicSettings } from "./settings.ts";
import { createStore } from "./store.ts";

const databaseUrl = process.env.TEST_LIVE_DATABASE_URI;

const channelBody = z.object({
  channel: z.object({
    id: z.string(),
    chatDoc: z.string(),
    spaceDoc: z.string(),
  }),
});
const tokenBody = z.object({
  token: z.string(),
  liveDoc: z
    .object({ kind: z.string(), conversationId: z.string() })
    .nullable(),
});
const secret = "test-secret";

describe.skipIf(!databaseUrl)("airlink server", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = createStore(pool);
  const live = createLiveServer({
    databaseUrl: databaseUrl ?? "",
    jwtSecret: secret,
    port: 0,
    logger: pino({ level: "silent" }),
  });
  const dataDir = mkdtempSync(join(tmpdir(), "airlink-test-"));
  const files = createSettingsFiles(dataDir);
  const person = newPerson("Ada");
  const cookie = `${personCookie}=${personCookieValue(person, secret)}`;
  let liveUrl = "";
  let apiUrl = "";
  let server: ReturnType<typeof createServer> | null = null;
  const left: string[] = [];

  beforeAll(async () => {
    await store.init();
    liveUrl = `http://127.0.0.1:${await live.listen()}`;
    const handleApi = createApi({
      store,
      allowedHosts: ["127.0.0.1"],
      secret,
      liveUrl,
      livePort: 0,
      agents: files.agents,
      saveAgents: files.saveAgents,
      settings: () => publicSettings(files.settings(), {}),
      saveSettings: (input) => {
        const result = files.saveSettings(input);
        return result.ok
          ? { ok: true, settings: publicSettings(result.settings, {}) }
          : result;
      },
      harnesses: async () => [],
      models: () => [],
      memoryOf: (agent) => agentMemory(join(dataDir, "memory"), agent),
      chatWriters: async () => [],
      transcribeToken: async () => null,
      untouched: async (docName) => {
        const connection = await live.hocuspocus.openDirectConnection(docName, {
          actor: { kind: "human", id: "airlink", name: "AirLink" },
          access: "read",
          workspaceId,
        });
        const empty = (connection.document?.store.clients.size ?? 0) === 0;
        await connection.disconnect();
        return empty;
      },
      onConfigChanged: () => undefined,
      logger: pino({ level: "silent" }),
      voice: {
        isAvailable: () => false,
        join: async () => {},
        leave: async (callDoc, identity) => {
          left.push(`${callDoc} ${identity}`);
        },
        voices: async () => ({ provider: null, voices: [] }),
        preview: async () => null,
      },
      runner: {
        reachable: async () => false,
        rerun: () => "unavailable",
        setPaused: async () => {},
        forget: () => {},
      },
    });
    server = createServer((request, response) => {
      void handleApi(request, response);
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const address = server.address();
    apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    server?.close();
    await live.destroy();
    await pool.end();
  });

  const call = (path: string, init: RequestInit = {}, withCookie = cookie) =>
    fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(withCookie ? { Cookie: withCookie } : {}),
      },
    });

  const newChannel = async () => {
    const response = await call("/api/channels", {
      method: "POST",
      body: JSON.stringify({ name: `t-${crypto.randomUUID().slice(0, 8)}` }),
    });
    return channelBody.parse(await response.json()).channel;
  };

  it("shows an agent's memory folder and what agents remember about a person", async () => {
    expect((await call("/api/me")).status).toBe(200);
    const [agent] = files.agents();
    const memory = agentMemory(join(dataDir, "memory"), agent);
    await memory.store.write({
      type: "person",
      title: `${person.name} prefers async updates`,
      body: "Send a written summary instead of a call.",
    });
    await memory.store.write({
      type: "project",
      title: "Vendor review",
      body: "Acme renews in March.",
    });
    const agentBody = z
      .object({
        dir: z.string(),
        entries: z.array(z.object({ title: z.string() })),
      })
      .parse(await (await call(`/api/agents/${agent.id}/memory`)).json());
    expect(agentBody.dir).toBe(memory.dir);
    expect(agentBody.entries.map((entry) => entry.title).sort()).toEqual([
      `${person.name} prefers async updates`,
      "Vendor review",
    ]);
    const personBody = z
      .object({
        entries: z.array(
          z.object({ title: z.string(), agent: z.object({ id: z.string() }) })
        ),
      })
      .parse(await (await call(`/api/people/${person.id}/memory`)).json());
    expect(
      personBody.entries.map((entry) => [entry.title, entry.agent.id])
    ).toEqual([[`${person.name} prefers async updates`, agent.id]]);
    expect((await call("/api/people/nobody/memory")).status).toBe(404);
  });

  it("deletes an object from its channel only, for a person", async () => {
    const channel = await newChannel();
    const created = z
      .object({ object: z.object({ docName: z.string() }) })
      .parse(
        await (
          await call(`/api/channels/${channel.id}/objects`, {
            method: "POST",
            body: JSON.stringify({ kind: "doc", title: "Old notes" }),
          })
        ).json()
      );
    const path = `/api/channels/${channel.id}/objects/${encodeURIComponent(created.object.docName)}`;
    expect(await (await call(path, { method: "DELETE" })).json()).toEqual({
      ok: true,
      deleted: true,
    });
    expect(await (await call(path, { method: "DELETE" })).json()).toEqual({
      ok: true,
      deleted: false,
    });
    expect(await store.objects(channel.id)).toEqual([]);
  });

  it("drops an object on close only while nobody has written in it", async () => {
    const channel = await newChannel();
    const add = async (title: string) =>
      z.object({ object: z.object({ docName: z.string() }) }).parse(
        await (
          await call(`/api/channels/${channel.id}/objects`, {
            method: "POST",
            body: JSON.stringify({ kind: "doc", title }),
          })
        ).json()
      ).object.docName;
    const close = async (docName: string) =>
      (
        await call(
          `/api/channels/${channel.id}/objects/${encodeURIComponent(docName)}`,
          { method: "DELETE", body: JSON.stringify({ ifUntouched: true }) }
        )
      ).json();
    const written = await add("Written");
    const connection = await live.hocuspocus.openDirectConnection(written, {
      actor: { kind: "human", id: person.id, name: person.name },
      access: "write",
      workspaceId,
    });
    await connection.transact((doc) => doc.getText("t").insert(0, "hi"));
    await connection.disconnect();
    expect(await close(written)).toEqual({ ok: true, deleted: false });
    expect(await close(await add("Empty"))).toEqual({
      ok: true,
      deleted: true,
    });
    expect((await store.objects(channel.id)).map((o) => o.title)).toEqual([
      "Written",
    ]);
  });

  it("keeps an uploaded file's bytes, serves them sandboxed and drops them with the object", async () => {
    const channel = await newChannel();
    const upload = (headers: Record<string, string>) =>
      fetch(`${apiUrl}/api/channels/${channel.id}/files`, {
        method: "POST",
        headers: { Cookie: cookie, ...headers },
        body: "<script>alert(1)</script>",
      });
    expect((await upload({ "Content-Type": "text/html" })).status).toBe(415);
    const created = z
      .object({ object: z.object({ docName: z.string(), kind: z.string() }) })
      .parse(
        await (
          await upload({
            "Content-Type": "text/html",
            "X-File-Name": encodeURIComponent("page é.html"),
          })
        ).json()
      );
    expect(created.object.kind).toBe("file");
    const filePath = `/api/files/${encodeURIComponent(created.object.docName)}`;
    expect(await (await call(`${filePath}/info`)).json()).toEqual({
      name: "page é.html",
      mime: "text/html",
      sizeBytes: 25,
    });
    const served = await call(filePath);
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(await served.text()).toBe("<script>alert(1)</script>");
    await call(
      `/api/channels/${channel.id}/objects/${encodeURIComponent(created.object.docName)}`,
      { method: "DELETE" }
    );
    expect((await call(`${filePath}/info`)).status).toBe(404);
    expect(await store.fileInfo(created.object.docName)).toBeNull();
  });

  it("lets only members into an invite-only channel, by request or by being added", async () => {
    const channel = await newChannel();
    const outsider = newPerson("Lin");
    await store.seePerson(outsider);
    const outsiderCookie = `${personCookie}=${personCookieValue(outsider, secret)}`;
    const asOutsider = (path: string, init: RequestInit = {}) =>
      call(path, init, outsiderCookie);
    const listed = z
      .object({
        channels: z.array(
          z.object({
            id: z.string(),
            isMember: z.boolean(),
            requested: z.boolean(),
          })
        ),
      })
      .parse(await (await asOutsider("/api/channels")).json())
      .channels.find((each) => each.id === channel.id);
    expect(listed).toEqual({
      id: channel.id,
      isMember: false,
      requested: false,
    });
    expect((await asOutsider(`/api/channels/${channel.id}`)).status).toBe(403);
    const tokenBodyFor = (docName: string) => ({
      method: "POST",
      body: JSON.stringify({ docName }),
    });
    expect(
      (await asOutsider("/api/tokens", tokenBodyFor(channel.chatDoc))).status
    ).toBe(403);

    await asOutsider(`/api/channels/${channel.id}/join-requests`, {
      method: "POST",
    });
    const members = async () =>
      (await call(`/api/channels/${channel.id}/members`)).json();
    expect(await members()).toMatchObject({
      open: false,
      humans: [person.id],
      agents: [],
      requests: [{ personId: outsider.id }],
    });
    await call(`/api/channels/${channel.id}/members`, {
      method: "POST",
      body: JSON.stringify({ kind: "human", id: outsider.id }),
    });
    expect(await members()).toMatchObject({
      humans: [person.id, outsider.id],
      requests: [],
    });
    expect((await asOutsider(`/api/channels/${channel.id}`)).status).toBe(200);
    expect(
      (await asOutsider("/api/tokens", tokenBodyFor(channel.chatDoc))).status
    ).toBe(200);
    const [agent] = files.agents();
    await call(`/api/channels/${channel.id}/members`, {
      method: "POST",
      body: JSON.stringify({ kind: "agent", id: agent.id }),
    });
    const room = createRoom({ store, liveUrl, jwtSecret: secret });
    expect(await room.agentIdsOf?.(channel.chatDoc)).toEqual([agent.id]);
    await asOutsider(
      `/api/channels/${channel.id}/members/human/${outsider.id}`,
      {
        method: "DELETE",
      }
    );
    expect((await asOutsider(`/api/channels/${channel.id}`)).status).toBe(403);
  });

  it("refuses a missing, forged or tampered cookie", async () => {
    expect((await call("/api/channels", {}, "")).status).toBe(401);
    const forged = `${personCookie}=${personCookieValue(person, "other-secret")}`;
    expect((await call("/api/channels", {}, forged)).status).toBe(401);
    const [payload, signature] = personCookieValue(person, secret).split(".");
    const renamed = Buffer.from(
      JSON.stringify({ id: person.id, name: "Mallory" })
    ).toString("base64url");
    expect(
      (
        await call(
          "/api/channels",
          {},
          `${personCookie}=${renamed}.${signature}`
        )
      ).status
    ).toBe(401);
    expect(payload).not.toBe(renamed);
    expect((await call("/api/channels")).status).toBe(200);
  });

  it("refuses a rebound hostname, a cross-origin write and a non-JSON write", async () => {
    const post = (headers: Record<string, string>) =>
      fetch(`${apiUrl}/api/channels`, {
        method: "POST",
        headers: { Cookie: cookie, ...headers },
        body: JSON.stringify({ name: "x" }),
      });
    // fetch drops a Host header, so the rebound request goes through node:http.
    const reboundStatus = await new Promise<number | undefined>((resolve) =>
      httpRequest(
        `${apiUrl}/api/channels`,
        { headers: { Cookie: cookie, Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      ).end()
    );
    expect(reboundStatus).toBe(403);
    expect(
      (
        await post({
          "Content-Type": "application/json",
          Origin: "http://evil.example",
        })
      ).status
    ).toBe(403);
    expect((await post({ "Content-Type": "text/plain" })).status).toBe(415);
  });

  it("says whether agents can speak in calls, and lists voices for the speech key", async () => {
    expect(await (await call("/api/voice")).json()).toEqual({
      available: false,
    });
    expect(await (await call("/api/voices")).json()).toEqual({
      provider: null,
      voices: [],
    });
  });

  it("lets a person take only their own connection out of a call", async () => {
    const channel = await newChannel();
    const leave = (identity: string) =>
      call(`/api/live/${encodeURIComponent(channel.chatDoc)}/left`, {
        method: "POST",
        body: JSON.stringify({ identity }),
      });
    expect((await leave("user:someone-else")).status).toBe(403);
    expect(left).toEqual([]);
    expect((await leave(`user:${person.id}`)).status).toBe(200);
    expect(left).toEqual([`${channel.chatDoc} user:${person.id}`]);
  });

  it("mints a write token for a channel's docs and none for any other doc", async () => {
    const channel = await newChannel();
    const response = await call("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ docName: channel.chatDoc }),
    });
    expect(response.status).toBe(200);
    const body = tokenBody.parse(await response.json());
    expect(verifyLiveToken(body.token, secret)).toMatchObject({
      actor: { kind: "human", id: person.id, name: "Ada" },
      docName: channel.chatDoc,
      access: "write",
    });
    expect(body.liveDoc).toBeNull();

    const space = tokenBody.parse(
      await (
        await call("/api/tokens", {
          method: "POST",
          body: JSON.stringify({ docName: channel.spaceDoc }),
        })
      ).json()
    );
    expect(space.liveDoc).toMatchObject({
      kind: "space",
      conversationId: channel.id,
    });

    const stranger = await call("/api/tokens", {
      method: "POST",
      body: JSON.stringify({ docName: "someone-elses-doc" }),
    });
    expect(stranger.status).toBe(403);
  });

  it("never returns an LLM key; an update without one keeps it and null removes it", async () => {
    await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        keys: { anthropic: "sk-test-123", openai: "sk-test-456" },
      }),
    });
    const first = await (await call("/api/settings")).text();
    expect(first).not.toContain("sk-test-123");
    expect(first).toContain(
      '{"id":"anthropic","name":"Anthropic","saved":"-123"}'
    );

    await call("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        keys: { anthropic: "", openai: null },
        model: "anthropic/claude-sonnet-5-5",
      }),
    });
    expect(files.settings()).toMatchObject({
      keys: { anthropic: "sk-test-123" },
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(files.settings().keys).not.toHaveProperty("openai");
  });

  it("reads settings saved with a single provider key", () => {
    const dir = mkdtempSync(join(tmpdir(), "airlink-old-settings-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        llm: { provider: "openai", apiKey: "sk-old", model: "gpt-5" },
        memoryRoot: "/vault",
      })
    );
    expect(createSettingsFiles(dir).settings()).toMatchObject({
      keys: { openai: "sk-old" },
      model: "openai/gpt-5",
      memoryRoot: "/vault",
    });
  });

  it("answers an object's channel, and an agent's new sheet joins and is placed in that channel's space", async () => {
    const channel = await newChannel();
    const room = createRoom({ store, liveUrl, jwtSecret: secret });
    const agent = files.agents()[0];
    const created = await room.createObject({
      chatDoc: channel.chatDoc,
      agent,
      tool: "create_live_sheet",
      args: { title: "Vendors", values: [["Vendor", "Price"]] },
    });
    expect(created.ok).toBe(true);

    const objects = await room.objectsOf(channel.chatDoc);
    expect(objects).toEqual([
      { id: expect.any(String), title: "Vendors", kind: "sheet" },
    ]);
    expect(await room.chatDocOf(objects[0].id)).toBe(channel.chatDoc);

    const again = await room.createObject({
      chatDoc: channel.chatDoc,
      agent,
      tool: "create_live_sheet",
      args: { title: "vendors ", values: [["x"]] },
    });
    expect(again.text).toContain("already has");
    expect(await room.objectsOf(channel.chatDoc)).toHaveLength(1);

    const space = await createLiveAgentClient({
      baseUrl: liveUrl,
      docName: channel.spaceDoc,
      token: tokenBody.parse(
        await (
          await call("/api/tokens", {
            method: "POST",
            body: JSON.stringify({ docName: channel.spaceDoc }),
          })
        ).json()
      ).token,
    }).readSpace();
    expect(space.objects.map((object) => object.docName)).toEqual([
      objects[0].id,
    ]);
  });

  it("gives two agents asking at once for the same object the one object", async () => {
    const channel = await newChannel();
    const claim = (title: string) =>
      store.findOrAddObject({
        channelId: channel.id,
        kind: "sheet",
        title,
        onePerRoom: false,
        createdBy: "agent",
      });
    await Promise.all(Array.from({ length: 8 }, () => pool.query("SELECT 1")));
    const claims = await Promise.all(
      ["Budget", " budget", "BUDGET ", "budget", "Budget ", " BUDGET"].map(
        claim
      )
    );
    expect(new Set(claims.map((claimed) => claimed.object.docName)).size).toBe(
      1
    );
    expect(claims.filter((claimed) => !claimed.existing)).toHaveLength(1);
    expect(await store.objects(channel.id)).toHaveLength(1);
  });
});
