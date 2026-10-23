import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentConfig } from "@memo-air/agents";
import type { agentMemory, DetectedHarness } from "@memo-air/bridge";
import type { LiveActor, LiveDocKind } from "@memo-air/protocol";
import { signLiveToken, verifyLiveToken } from "@memo-air/protocol/tokens";
import { notSetUpText } from "@memo-air/runner";
import type { SpeechProviderId, VoiceOption } from "@memo-air/voice";
import { z } from "zod";

import type { Person } from "./identity.ts";
import {
  newPerson,
  personCookie,
  personCookieValue,
  readPerson,
} from "./identity.ts";
import { workspaceId } from "./room.ts";
import type { PublicSettings } from "./settings.ts";
import type { Channel, ChannelDoc, MemberKind, Store } from "./store.ts";

const objectKinds = [
  "doc",
  "sheet",
  "canvas",
  "slides",
  "browser",
  "desktop",
  "media",
] as const;

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });
const channelSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use letters, digits and dashes."),
});
const objectSchema = z.object({
  kind: z.enum(objectKinds),
  title: z.string().trim().min(1).max(200),
});
const tokenSchema = z.object({ docName: z.string().min(1).max(200) });
const memberSchema = z.object({
  kind: z.enum(["human", "agent"]),
  id: z.string().min(1).max(200),
});
const previewSchema = z.object({
  voiceId: z.string().min(1).max(200),
  speed: z.number().min(0.5).max(2),
});
const leaveSchema = z.object({ identity: z.string().min(1).max(200) });
const mediaTokenSchema = z.object({ identity: z.string().min(1) });
const deleteSchema = z.object({ ifUntouched: z.boolean().optional() });
const pausedSchema = z.object({ paused: z.boolean() });
const runRoute = /^\/api\/runs\/([^/]+)(?:\/(run|paused)|\/out\/(.+))?$/;
const runFrameRoute = /^\/api\/runs\/([^/]+)\/frame\/([^/]+)\/(.+)$/;
const frameGrantSeconds = 12 * 60 * 60;

const decodedOrNull = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

// The live-server routes a person's browser reaches through AirLink, which adds the token.
const forwardedRoute =
  /^\/api\/live\/([^/]+)\/(history|versions\/\d+|restore|comments|xlsx|pptx|frames|frames\/\d+|browser-video|media-token|transcript)$/;

const maxBodyBytes = 1_000_000;
export const maxFileBytes = 25_000_000;
// Sent by the upload only. A form on another site cannot set it without a CORS preflight, which
// this server never answers, so a non-JSON body is let through only with it.
const fileNameHeader = "x-file-name";
const mimePattern = /^[\w.+-]+\/[\w.+-]+/;

type Reply = { status: number; body: unknown };

const fail = (status: number, error: string): Reply => ({
  status,
  body: { error },
});

// The one error the request itself can cause: a body over the limit.
async function readBody(
  request: IncomingMessage,
  limitBytes = maxBodyBytes
): Promise<{ ok: true; body: Buffer } | { ok: false; reply: Reply }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      return { ok: false, reply: fail(413, "Request too large.") };
    }
    chunks.push(buffer);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

async function readJson<T>(
  request: IncomingMessage,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<{ ok: true; data: T } | { ok: false; reply: Reply }> {
  const read = await readBody(request);
  if (!read.ok) {
    return read;
  }
  const raw = read.body.toString("utf8");
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, reply: fail(400, "Body is not JSON.") };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        reply: fail(400, parsed.error.issues[0]?.message ?? "Invalid body."),
      };
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export type AirlinkApiDeps = {
  store: Store;
  // Hostnames this server answers to; anything else is a rebound DNS name or a stranger.
  allowedHosts: string[];
  secret: string;
  liveUrl: string;
  livePort: number;
  agents: () => AgentConfig[];
  saveAgents: (
    input: unknown
  ) => { ok: true; agents: AgentConfig[] } | { ok: false; error: string };
  settings: () => PublicSettings;
  saveSettings: (
    input: unknown
  ) => { ok: true; settings: PublicSettings } | { ok: false; error: string };
  harnesses: () => Promise<DetectedHarness[]>;
  models: () => { id: string; name: string }[];
  memoryOf: (agent: AgentConfig) => ReturnType<typeof agentMemory>;
  chatWriters: (
    chatDoc: string
  ) => Promise<
    { id: string; name: string; seenAtMs: number; messages: number }[]
  >;
  transcribeToken: () => Promise<{ token: string; baseUri: string } | null>;
  // True while nobody has written anything into the doc, counting edits not yet flushed.
  untouched: (docName: string) => Promise<boolean>;
  onConfigChanged: () => void;
  logger: { error(obj: object, msg: string): void };
  voice: {
    isAvailable: () => boolean;
    join: (
      callDoc: string,
      person: { id: string; name: string; identity: string }
    ) => Promise<void>;
    leave: (callDoc: string, identity: string) => Promise<void>;
    voices: () => Promise<{
      provider: SpeechProviderId | null;
      voices: VoiceOption[];
    }>;
    preview: (voiceId: string, speed: number) => Promise<Buffer | null>;
  };
  runner: RunnerControls;
};

export type RunnerControls = {
  reachable(): Promise<boolean>;
  rerun(
    docName: string,
    actor: LiveActor
  ): "started" | "running" | "unavailable";
  setPaused(docName: string, paused: boolean): Promise<void>;
  forget(docName: string): void;
};

export function createApi(deps: AirlinkApiDeps) {
  const { store, secret, liveUrl } = deps;

  const liveDocOf = (found: ChannelDoc) =>
    found.role === "object"
      ? {
          sId: found.object.docName,
          title: found.object.title,
          kind: found.object.kind,
          conversationId: found.channel.id,
        }
      : found.role === "space"
        ? {
            sId: found.channel.spaceDoc,
            title: `#${found.channel.name}`,
            kind: "space" satisfies LiveDocKind,
            conversationId: found.channel.id,
          }
        : null;

  const asHuman = (person: Person) => ({
    kind: "human" as const,
    id: person.id,
  });

  // Every token goes through the store: a doc outside every channel has none, and a doc in a
  // channel the person is not in has none either — this is where invite-only is enforced.
  const tokenFor = async (person: Person, docName: string) => {
    const found = await store.docOf(docName);
    return found && (await store.isMember(found.channel, asHuman(person)))
      ? {
          found,
          token: signLiveToken(
            {
              actor: { kind: "human", id: person.id, name: person.name },
              workspaceId,
              docName,
              access: "write",
            },
            secret
          ),
        }
      : null;
  };

  const forward = async (
    request: IncomingMessage,
    response: ServerResponse,
    person: Person,
    docName: string,
    route: string,
    search: string
  ): Promise<Reply | null> => {
    const granted = await tokenFor(person, docName);
    if (!granted) {
      return fail(403, "This doc is not in a channel you are in.");
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return fail(405, "Method not allowed.");
    }
    const hasBody = request.method === "POST";
    const read = hasBody ? await readBody(request) : null;
    if (read && !read.ok) {
      return read.reply;
    }
    const upstream = await fetch(
      `${liveUrl}/v1/docs/${encodeURIComponent(docName)}/${route}${search}`,
      {
        method: request.method,
        headers: {
          Authorization: `Bearer ${granted.token}`,
          ...(read ? { "Content-Type": "application/json" } : {}),
        },
        body: read ? new Uint8Array(read.body) : undefined,
      }
    );
    const disposition = upstream.headers.get("content-disposition");
    response.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      ...(disposition ? { "Content-Disposition": disposition } : {}),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.end(bytes);
    if (route === "media-token" && upstream.ok) {
      const granted = mediaTokenSchema.safeParse(
        (() => {
          try {
            return JSON.parse(bytes.toString("utf8"));
          } catch {
            return null;
          }
        })()
      );
      if (granted.success) {
        deps.voice
          .join(docName, {
            id: person.id,
            name: person.name,
            identity: granted.data.identity,
          })
          .catch((err) =>
            deps.logger.error({ err, docName }, "voice: join failed")
          );
      }
    }
    return null;
  };

  const memberChannel = async (
    person: Person,
    channelId: string
  ): Promise<{ ok: true; channel: Channel } | { ok: false; reply: Reply }> => {
    const channel = await store.channel(channelId);
    if (!channel) {
      return { ok: false, reply: fail(404, "No such channel.") };
    }
    return (await store.isMember(channel, asHuman(person)))
      ? { ok: true, channel }
      : { ok: false, reply: fail(403, `You are not in #${channel.name}.`) };
  };

  // Signed apart from live tokens, so a dashboard that leaks its own URL hands out nothing live-server accepts.
  const frameSecret = `${secret}:run-frame`;

  const memberRunner = async (
    person: Person,
    docName: string
  ): Promise<{ ok: true } | { ok: false; reply: Reply }> => {
    const found = await store.docOf(docName);
    if (found?.role !== "object" || found.object.kind !== "runner") {
      return { ok: false, reply: fail(404, "No such runner.") };
    }
    return (await store.isMember(found.channel, asHuman(person)))
      ? { ok: true }
      : {
          ok: false,
          reply: fail(403, `You are not in #${found.channel.name}.`),
        };
  };

  // A run's files come from agent-written code: served as their own origin, scripts allowed so a
  // dashboard's charts draw, never as AirLink. A PDF goes without, as an uploaded one does: the
  // sandbox would leave it blank, and nosniff keeps it a PDF.
  const serveRunFile = async (
    response: ServerResponse,
    docName: string,
    name: string,
    extraHeaders: Record<string, string>
  ): Promise<Reply | null> => {
    const file = await store.runFile(docName, name);
    if (!file) {
      return fail(404, "No such output.");
    }
    response.writeHead(200, {
      "Content-Type": file.mime,
      "Content-Length": file.bytes.length,
      "X-Content-Type-Options": "nosniff",
      ...(file.mime === "application/pdf"
        ? {}
        : { "Content-Security-Policy": "sandbox allow-scripts" }),
      "Cache-Control": "no-store",
      ...extraHeaders,
    });
    response.end(file.bytes);
    return null;
  };

  // A page on another site can reach localhost through DNS rebinding or a plain form post, and
  // the API can start coding agents on this machine: only our own hostnames, only same-origin
  // writes, only JSON bodies.
  const refuseForeign = (request: IncomingMessage): Reply | null => {
    const hostname = (request.headers.host ?? "").replace(/:\d+$/, "");
    if (!deps.allowedHosts.includes(hostname)) {
      return fail(403, "Unknown host.");
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return null;
    }
    const origin = request.headers.origin;
    if (
      origin &&
      URL.canParse(origin) &&
      new URL(origin).host !== request.headers.host
    ) {
      return fail(403, "Cross-origin request.");
    }
    const type = request.headers["content-type"] ?? "";
    return type.startsWith("application/json") ||
      !request.headers["content-length"] ||
      request.headers[fileNameHeader]
      ? null
      : fail(415, "Send JSON.");
  };

  const saved = (
    result: { ok: true } | { ok: false; error: string },
    body: unknown
  ): Reply => {
    if (!result.ok) {
      return fail(400, result.error);
    }
    deps.onConfigChanged();
    return { status: 200, body };
  };

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<Reply | null> => {
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (path === "/api/me" && method === "POST") {
      const input = await readJson(request, nameSchema);
      if (!input.ok) {
        return input.reply;
      }
      const person = newPerson(input.data.name);
      await store.seePerson(person);
      response.setHeader(
        "Set-Cookie",
        `${personCookie}=${personCookieValue(person, secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
      );
      return { status: 200, body: { person } };
    }

    // The dashboard frame is sandboxed, so its document has no origin of its own: its requests carry
    // no cookie and its fetch is cross-origin. The link is its credential, re-checked against the
    // channel's members on every request, and any origin may read what it names.
    const frameMatch = path.match(runFrameRoute);
    if (frameMatch && method === "GET") {
      const docName = decodedOrNull(frameMatch[1]);
      const name = decodedOrNull(frameMatch[3]);
      const claims = verifyLiveToken(frameMatch[2], frameSecret);
      if (
        !docName ||
        !name ||
        !claims ||
        claims.docName !== docName ||
        claims.actor.kind !== "human"
      ) {
        return fail(
          403,
          "This dashboard link has expired; open the runner again."
        );
      }
      const entered = await memberRunner(
        { id: claims.actor.id, name: claims.actor.name },
        docName
      );
      if (!entered.ok) {
        return entered.reply;
      }
      return serveRunFile(response, docName, name, {
        "Access-Control-Allow-Origin": "*",
        "Referrer-Policy": "no-referrer",
      });
    }

    const person = readPerson(request.headers.cookie, secret);
    if (!person) {
      return fail(401, "Tell AirLink your name first.");
    }

    if (path === "/api/me" && method === "GET") {
      await store.seePerson(person);
      return { status: 200, body: { person } };
    }
    if (path === "/api/people" && method === "GET") {
      return { status: 200, body: { people: await store.listPeople() } };
    }
    // What the agents remember about one person: every agent's `person` notes that name them.
    const personMemoryMatch = path.match(/^\/api\/people\/([^/]+)\/memory$/);
    if (personMemoryMatch && method === "GET") {
      const found = (await store.listPeople()).find(
        (member) => member.id === personMemoryMatch[1]
      );
      if (!found) {
        return fail(404, "No such person.");
      }
      // The whole name, so "Ada" does not also match "Canada".
      const names = new RegExp(
        `\\b${found.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i"
      );
      const entries = (
        await Promise.all(
          deps.agents().map(async (agent) =>
            (
              await deps.memoryOf(agent).store.list()
            )
              .filter(
                (entry) =>
                  entry.type === "person" &&
                  (names.test(entry.title) ||
                    entry.tags.some((tag) => names.test(tag)))
              )
              .map((entry) => ({
                ...entry,
                agent: { id: agent.id, name: agent.name },
              }))
          )
        )
      ).flat();
      return { status: 200, body: { person: found, entries } };
    }
    // A person's footprint: the channels they have written in, with how much and how lately.
    const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
    if (personMatch && method === "GET") {
      const people = await store.listPeople();
      const found = people.find((member) => member.id === personMatch[1]);
      if (!found) {
        return fail(404, "No such person.");
      }
      const channels = (
        await Promise.all(
          (
            await store.listChannels()
          ).map(async (channel) => {
            const writer = (await deps.chatWriters(channel.chatDoc)).find(
              (each) => each.id === found.id
            );
            return writer
              ? {
                  id: channel.id,
                  name: channel.name,
                  messages: writer.messages,
                  lastAtMs: writer.seenAtMs,
                }
              : null;
          })
        )
      ).filter((channel) => channel !== null);
      return { status: 200, body: { person: found, channels } };
    }
    const agentMemoryMatch = path.match(/^\/api\/agents\/([^/]+)\/memory$/);
    if (agentMemoryMatch && method === "GET") {
      const agent = deps
        .agents()
        .find((each) => each.id === agentMemoryMatch[1]);
      if (!agent) {
        return fail(404, "No such agent.");
      }
      const memory = deps.memoryOf(agent);
      return {
        status: 200,
        body: { dir: memory.dir, entries: await memory.store.list() },
      };
    }
    // Every channel is listed, so a person can ask to join one they are not in.
    if (path === "/api/channels" && method === "GET") {
      const [channels, standing] = await Promise.all([
        store.listChannels(),
        store.standingOf(person.id),
      ]);
      return {
        status: 200,
        body: {
          channels: channels.map((channel) => ({
            ...channel,
            isMember: channel.open || standing.memberOf.has(channel.id),
            requested: standing.requested.has(channel.id),
          })),
        },
      };
    }
    const membersMatch = path.match(
      /^\/api\/channels\/([^/]+)\/members(?:\/(human|agent)\/([^/]+))?$/
    );
    if (membersMatch) {
      const entered = await memberChannel(person, membersMatch[1]);
      if (!entered.ok) {
        return entered.reply;
      }
      const { channel } = entered;
      if (method === "GET") {
        const people = await store.listPeople();
        const members = channel.open
          ? {
              humans: people.map((each) => each.id),
              agents: deps.agents().map((agent) => agent.id),
            }
          : await store.membersOf(channel.id);
        return {
          status: 200,
          body: {
            open: channel.open,
            ...members,
            requests: channel.open ? [] : await store.joinRequests(channel.id),
          },
        };
      }
      if (channel.open) {
        return fail(400, `Everyone is in #${channel.name}.`);
      }
      if (method === "POST" && !membersMatch[2]) {
        const input = await readJson(request, memberSchema);
        if (!input.ok) {
          return input.reply;
        }
        const known =
          input.data.kind === "agent"
            ? deps.agents().some((agent) => agent.id === input.data.id)
            : (await store.listPeople()).some(
                (each) => each.id === input.data.id
              );
        if (!known) {
          return fail(404, `No such ${input.data.kind}.`);
        }
        await store.addMembers(channel.id, [input.data], person.id);
        return { status: 200, body: { ok: true } };
      }
      if (method === "DELETE" && membersMatch[2] && membersMatch[3]) {
        const kind: MemberKind =
          membersMatch[2] === "agent" ? "agent" : "human";
        await store.removeMember(channel.id, {
          kind,
          id: decodeURIComponent(membersMatch[3]),
        });
        return { status: 200, body: { ok: true } };
      }
      return fail(405, "Method not allowed.");
    }
    // Asking to join is for whoever is not in; declining is for those who are.
    const joinMatch = path.match(
      /^\/api\/channels\/([^/]+)\/join-requests(?:\/([^/]+))?$/
    );
    if (joinMatch) {
      const channel = await store.channel(joinMatch[1]);
      if (!channel) {
        return fail(404, "No such channel.");
      }
      const isIn = await store.isMember(channel, asHuman(person));
      if (method === "POST" && !joinMatch[2]) {
        if (!isIn) {
          await store.requestToJoin(channel.id, person.id);
        }
        return { status: 200, body: { ok: true } };
      }
      if (method === "DELETE" && joinMatch[2]) {
        const personId =
          joinMatch[2] === "me" ? person.id : decodeURIComponent(joinMatch[2]);
        if (!isIn && personId !== person.id) {
          return fail(403, `You are not in #${channel.name}.`);
        }
        await store.dropJoinRequest(channel.id, personId);
        return { status: 200, body: { ok: true } };
      }
      return fail(405, "Method not allowed.");
    }
    if (path === "/api/channels" && method === "POST") {
      const input = await readJson(request, channelSchema);
      if (!input.ok) {
        return input.reply;
      }
      const channel = await store.createChannel(input.data.name, person.id);
      return channel
        ? { status: 200, body: { channel } }
        : fail(409, `#${input.data.name} already exists.`);
    }
    // Deleting is a person's alone, and only from the bin; agents have no route to it.
    const deleteMatch = path.match(
      /^\/api\/channels\/([^/]+)\/objects\/([^/]+)$/
    );
    if (deleteMatch && method === "DELETE") {
      const entered = await memberChannel(person, deleteMatch[1]);
      if (!entered.ok) {
        return entered.reply;
      }
      const input = await readJson(request, deleteSchema);
      if (!input.ok) {
        return input.reply;
      }
      const docName = decodeURIComponent(deleteMatch[2]);
      // Closing a window someone opened and never wrote in takes the object with it; an uploaded
      // file keeps its bytes outside the doc, so it is never untouched.
      if (input.data.ifUntouched) {
        const found = await store.docOf(docName);
        if (
          found?.role !== "object" ||
          found.channel.id !== deleteMatch[1] ||
          found.object.kind === "file" ||
          !(await deps.untouched(docName))
        ) {
          return { status: 200, body: { ok: true, deleted: false } };
        }
      }
      // Idempotent: deleting what is already gone still lets the bin finish emptying.
      const deleted = await store.deleteObject(deleteMatch[1], docName);
      deps.runner.forget(docName);
      return { status: 200, body: { ok: true, deleted } };
    }
    const uploadMatch = path.match(/^\/api\/channels\/([^/]+)\/files$/);
    if (uploadMatch && method === "POST") {
      const entered = await memberChannel(person, uploadMatch[1]);
      if (!entered.ok) {
        return entered.reply;
      }
      const { channel } = entered;
      const rawName = request.headers[fileNameHeader];
      let name = "";
      try {
        name = typeof rawName === "string" ? decodeURIComponent(rawName) : "";
      } catch {
        return fail(400, "Bad file name.");
      }
      name = name.trim().slice(0, 200);
      if (!name) {
        return fail(400, "A file needs a name.");
      }
      const read = await readBody(request, maxFileBytes);
      if (!read.ok) {
        return fail(413, "Files can be up to 25 MB.");
      }
      const object = await store.addFile({
        channelId: channel.id,
        name,
        mime:
          request.headers["content-type"]?.match(mimePattern)?.[0] ??
          "application/octet-stream",
        bytes: read.body,
        createdBy: person.id,
      });
      return { status: 200, body: { object } };
    }
    const fileMatch = path.match(/^\/api\/files\/([^/]+)(\/info)?$/);
    if (fileMatch && method === "GET") {
      let docName: string;
      try {
        docName = decodeURIComponent(fileMatch[1]);
      } catch {
        return fail(400, "Bad doc name.");
      }
      const found = await store.docOf(docName);
      if (!found) {
        return fail(404, "No such file.");
      }
      if (!(await store.isMember(found.channel, asHuman(person)))) {
        return fail(403, `You are not in #${found.channel.name}.`);
      }
      if (fileMatch[2]) {
        const info = await store.fileInfo(docName);
        return info ? { status: 200, body: info } : fail(404, "No such file.");
      }
      const file = await store.fileBytes(docName);
      if (!file) {
        return fail(404, "No such file.");
      }
      // An uploaded page or SVG opened from here would run as AirLink itself, so everything but
      // a PDF (which the sandbox would refuse to render) is served sandboxed, as its own origin.
      response.writeHead(200, {
        "Content-Type": file.mime,
        "Content-Length": file.bytes.length,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        ...(file.mime === "application/pdf"
          ? {}
          : { "Content-Security-Policy": "sandbox" }),
      });
      response.end(file.bytes);
      return null;
    }
    const runMatch = path.match(runRoute);
    if (runMatch) {
      const docName = decodedOrNull(runMatch[1]);
      if (!docName) {
        return fail(400, "Bad doc name.");
      }
      const entered = await memberRunner(person, docName);
      if (!entered.ok) {
        return entered.reply;
      }
      const actor: LiveActor = {
        kind: "human",
        id: person.id,
        name: person.name,
      };
      if (runMatch[3] && method === "GET") {
        const name = decodedOrNull(runMatch[3]);
        return name
          ? serveRunFile(response, docName, name, {})
          : fail(400, "Bad file name.");
      }
      if (!runMatch[2] && method === "GET") {
        const grant = signLiveToken(
          { actor, workspaceId, docName, access: "read" },
          frameSecret,
          frameGrantSeconds
        );
        return {
          status: 200,
          body: {
            available: await deps.runner.reachable(),
            frameBase: `/api/runs/${encodeURIComponent(docName)}/frame/${grant}/`,
          },
        };
      }
      if (runMatch[2] === "run" && method === "POST") {
        const started = deps.runner.rerun(docName, actor);
        return started === "started"
          ? { status: 202, body: { ok: true } }
          : started === "running"
            ? fail(409, "This runner is already running.")
            : fail(503, notSetUpText);
      }
      if (runMatch[2] === "paused" && method === "POST") {
        const input = await readJson(request, pausedSchema);
        if (!input.ok) {
          return input.reply;
        }
        await deps.runner.setPaused(docName, input.data.paused);
        return { status: 200, body: { ok: true } };
      }
      return fail(405, "Method not allowed.");
    }
    const channelMatch = path.match(/^\/api\/channels\/([^/]+)(\/objects)?$/);
    if (channelMatch) {
      const entered = await memberChannel(person, channelMatch[1]);
      if (!entered.ok) {
        return entered.reply;
      }
      const { channel } = entered;
      if (!channelMatch[2] && method === "GET") {
        return {
          status: 200,
          body: { channel, objects: await store.objects(channel.id) },
        };
      }
      if (channelMatch[2] && method === "POST") {
        const input = await readJson(request, objectSchema);
        if (!input.ok) {
          return input.reply;
        }
        const object = await store.addObject({
          channelId: channel.id,
          ...input.data,
          createdBy: person.id,
        });
        return { status: 200, body: { object } };
      }
    }
    if (path === "/api/tokens" && method === "POST") {
      const input = await readJson(request, tokenSchema);
      if (!input.ok) {
        return input.reply;
      }
      const granted = await tokenFor(person, input.data.docName);
      if (!granted) {
        return fail(403, "This doc is not in a channel you are in.");
      }
      const host = (request.headers.host ?? "localhost").replace(/:\d+$/, "");
      return {
        status: 200,
        body: {
          url: `ws://${host}:${deps.livePort}`,
          token: granted.token,
          access: "write",
          liveDoc: liveDocOf(granted.found),
          channelId: granted.found.channel.id,
        },
      };
    }
    const left = path.match(/^\/api\/live\/([^/]+)\/left$/);
    if (left && method === "POST") {
      let docName: string;
      try {
        docName = decodeURIComponent(left[1]);
      } catch {
        return fail(400, "Bad doc name.");
      }
      if (!(await tokenFor(person, docName))) {
        return fail(403, "This doc is not in a channel you are in.");
      }
      const input = await readJson(request, leaveSchema);
      if (!input.ok) {
        return input.reply;
      }
      const base = `user:${person.id}`;
      if (
        input.data.identity !== base &&
        !input.data.identity.startsWith(`${base}:`)
      ) {
        return fail(403, "That is not your connection.");
      }
      await deps.voice.leave(docName, input.data.identity);
      return { status: 200, body: {} };
    }
    if (path === "/api/voice" && method === "GET") {
      return { status: 200, body: { available: deps.voice.isAvailable() } };
    }
    if (path === "/api/voices" && method === "GET") {
      return { status: 200, body: await deps.voice.voices() };
    }
    if (path === "/api/voices/preview" && method === "POST") {
      const input = await readJson(request, previewSchema);
      if (!input.ok) {
        return input.reply;
      }
      let audio: Buffer | null;
      try {
        audio = await deps.voice.preview(input.data.voiceId, input.data.speed);
      } catch {
        return fail(502, "The speech provider could not make a preview.");
      }
      if (!audio) {
        return fail(404, "No speech key is set.");
      }
      response.writeHead(200, { "Content-Type": "audio/wav" });
      response.end(audio);
      return null;
    }
    const forwarded = path.match(forwardedRoute);
    if (forwarded) {
      let docName: string;
      try {
        docName = decodeURIComponent(forwarded[1]);
      } catch {
        return fail(400, "Bad doc name.");
      }
      return forward(
        request,
        response,
        person,
        docName,
        forwarded[2],
        url.search
      );
    }
    if (path === "/api/transcribe-token" && method === "POST") {
      const token = await deps.transcribeToken();
      return token
        ? { status: 200, body: token }
        : fail(404, "No transcription key is set.");
    }
    if (path === "/api/settings" && method === "GET") {
      return { status: 200, body: { settings: deps.settings() } };
    }
    if (path === "/api/settings" && method === "PUT") {
      const input = await readJson(request, z.unknown());
      if (!input.ok) {
        return input.reply;
      }
      const result = deps.saveSettings(input.data);
      return saved(result, result.ok ? { settings: result.settings } : null);
    }
    if (path === "/api/agents" && method === "GET") {
      return { status: 200, body: { agents: deps.agents() } };
    }
    if (path === "/api/agents" && method === "PUT") {
      const input = await readJson(request, z.unknown());
      if (!input.ok) {
        return input.reply;
      }
      const result = deps.saveAgents(input.data);
      return saved(result, result.ok ? { agents: result.agents } : null);
    }
    if (path === "/api/models" && method === "GET") {
      return { status: 200, body: { models: deps.models() } };
    }
    if (path === "/api/harnesses" && method === "GET") {
      return { status: 200, body: { harnesses: await deps.harnesses() } };
    }
    return fail(404, "Not found.");
  };

  // Returns false for anything outside /api, which the web app serves. A null reply means the
  // route already wrote the response (a forwarded file).
  return async function handleApi(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://airlink");
    if (!url.pathname.startsWith("/api/")) {
      return false;
    }
    const refused = refuseForeign(request);
    if (refused) {
      sendJson(response, refused.status, refused.body);
      return true;
    }
    const reply = await route(request, response, url);
    if (reply) {
      sendJson(response, reply.status, reply.body);
    }
    return true;
  };
}
