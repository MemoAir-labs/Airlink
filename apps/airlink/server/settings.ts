import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { AgentConfig } from "@memo-air/agents";
import { parseAgentRegistry } from "@memo-air/agents";
import type {
  DetectedHarness,
  Harness,
  PiSessions,
  RoomMcp,
} from "@memo-air/bridge";
import { acpHarness, piDecide, piHarness } from "@memo-air/bridge";
import type { Decide } from "@memo-air/decide";
import { noOpinion, systemOneProvider } from "@memo-air/decide";
import { z } from "zod";

// The providers a person can add a key for; every agent picks a model from those with one.
const llmProviders: Provider<Api>[] = [
  anthropicProvider(),
  openaiProvider(),
  googleProvider(),
  openrouterProvider(),
  groqProvider(),
  xaiProvider(),
  mistralProvider(),
  deepseekProvider(),
];

export const settingsSchema = z.object({
  // Provider id to its key.
  keys: z.record(z.string(), z.string()).default({}),
  // "<provider>/<model id>" for an agent that does not pick its own.
  model: z.string().default("anthropic/claude-haiku-5-5"),
  // ACP harnesses the person turned on, by id from detectHarnesses.
  harnesses: z.array(z.string()).default([]),
  // Empty means <data folder>/memory.
  memoryRoot: z.string().default(""),
  // Agents' voices in a huddle, from the first provider with a key (OpenAI's key also counts).
  // ElevenLabs also transcribes calls in every browser; without it each browser's own speech
  // service is used.
  speech: z
    .object({
      elevenLabsApiKey: z.string().default(""),
      cartesiaApiKey: z.string().default(""),
      deepgramApiKey: z.string().default(""),
    })
    .default({}),
  // Who answers a message that names nobody: a small model on the person's own key, or a System
  // One decision model (Jev by key, or Laya at a local URL). "none" is what older files saved.
  decide: z
    .preprocess(
      (value) =>
        z.object({ kind: z.literal("none") }).safeParse(value).success
          ? { kind: "model" }
          : value,
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("model") }),
        z.object({
          kind: z.literal("system-one"),
          url: z.string().url(),
          apiKey: z.string().default(""),
          model: z.string().default(""),
        }),
      ])
    )
    .default({ kind: "model" }),
});

export type Settings = z.infer<typeof settingsSchema>;

// What the browser sees: never a key, only whether one is set.
export type PublicSettings = Omit<Settings, "keys" | "decide" | "speech"> & {
  // The saved key's last four characters, so a person sees which key is in use.
  providers: { id: string; name: string; saved: string | null }[];
  speech: {
    elevenLabsKeySet: boolean;
    cartesiaKeySet: boolean;
    deepgramKeySet: boolean;
  };
  decide:
    | { kind: "model"; model: string | null }
    | { kind: "system-one"; url: string; model: string; apiKeySet: boolean };
};

const seedAgents: AgentConfig[] = [
  {
    id: "assistant",
    name: "Assistant",
    role: "Answers in the channel and works in its docs, sheets, canvases and slides.",
    instructions: [
      "You are the channel's generalist: answer whoever asks, and do the work rather than describe it.",
      "Before you answer, check what is already in the room: the objects listed with each request, and what you remember about the people and the project.",
      "Ask one short question when a request is ambiguous about something that matters (whose numbers, which date, what format); otherwise make a sensible choice and say what you chose.",
      "Write plainly and briefly. Lead with the answer; put tables, drafts and anything longer than a few lines in a doc or sheet.",
      "Never invent figures, names or sources. When you fill in an example, mark it as an example.",
    ].join("\n"),
    tags: [],
    access: "write",
    harness: "pi",
    voice: { speed: 1 },
  },
];

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// A crash between write and rename leaves the old file whole.
function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function createSettingsFiles(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const settingsPath = join(dataDir, "settings.json");
  const agentsPath = join(dataDir, "agents.json");

  const settings = (): Settings => {
    const parsed = settingsSchema.safeParse(
      fromSingleKey(readJson(settingsPath) ?? {})
    );
    return parsed.success ? parsed.data : settingsSchema.parse({});
  };

  const agents = (): AgentConfig[] => {
    const parsed = parseAgentRegistry(readJson(agentsPath) ?? seedAgents);
    return parsed.ok ? parsed.agents : seedAgents;
  };

  // A key left empty in an update keeps the stored one: the browser never has it to send back.
  // A provider sent as null loses its key.
  const saveSettings = (
    input: unknown
  ): { ok: true; settings: Settings } | { ok: false; error: string } => {
    const parsed = settingsSchema
      .extend({
        keys: z.record(z.string(), z.string().nullable()).default({}),
      })
      .safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid" };
    }
    if (parsed.data.memoryRoot) {
      try {
        mkdirSync(parsed.data.memoryRoot, { recursive: true });
      } catch {
        return {
          ok: false,
          error: `AirLink cannot use ${parsed.data.memoryRoot} as a memory folder.`,
        };
      }
    }
    const current = settings();
    const keys = { ...current.keys };
    for (const [id, key] of Object.entries(parsed.data.keys)) {
      if (key === null) {
        delete keys[id];
      } else if (key) {
        keys[id] = key;
      }
    }
    const next: Settings = {
      ...parsed.data,
      keys,
      speech: {
        elevenLabsApiKey:
          parsed.data.speech.elevenLabsApiKey ||
          current.speech.elevenLabsApiKey,
        cartesiaApiKey:
          parsed.data.speech.cartesiaApiKey || current.speech.cartesiaApiKey,
        deepgramApiKey:
          parsed.data.speech.deepgramApiKey || current.speech.deepgramApiKey,
      },
      decide:
        parsed.data.decide.kind === "system-one"
          ? {
              ...parsed.data.decide,
              apiKey:
                parsed.data.decide.apiKey ||
                (current.decide.kind === "system-one"
                  ? current.decide.apiKey
                  : ""),
            }
          : parsed.data.decide,
    };
    writeJson(settingsPath, next);
    return { ok: true, settings: next };
  };

  const saveAgents = (
    input: unknown
  ): { ok: true; agents: AgentConfig[] } | { ok: false; error: string } => {
    const parsed = parseAgentRegistry(input);
    if (!parsed.ok) {
      return parsed;
    }
    writeJson(agentsPath, parsed.agents);
    return parsed;
  };

  return { settings, agents, saveSettings, saveAgents };
}

// Settings saved before AirLink took several providers held one provider, key and model.
function fromSingleKey(raw: unknown): unknown {
  const old = z
    .object({
      llm: z.object({
        provider: z.string().default("anthropic"),
        apiKey: z.string().default(""),
        model: z.string().default("claude-haiku-5-5"),
      }),
    })
    .passthrough()
    .safeParse(raw);
  if (!old.success) {
    return raw;
  }
  const { llm, ...rest } = old.data;
  return {
    keys: llm.apiKey ? { [llm.provider]: llm.apiKey } : {},
    model: `${llm.provider}/${llm.model}`,
    ...rest,
  };
}

type EnvApiKeys = Partial<Record<string, string | null>>;

const keyOf = (settings: Settings, envApiKeys: EnvApiKeys, provider: string) =>
  settings.keys[provider] || envApiKeys[provider] || "";

export function publicSettings(
  settings: Settings,
  envApiKeys: EnvApiKeys
): PublicSettings {
  const { keys: _keys, ...rest } = settings;
  return {
    ...rest,
    providers: llmProviders.map(({ id, name }) => ({
      id,
      name,
      saved: settings.keys[id]
        ? settings.keys[id].slice(-4)
        : envApiKeys[id]
          ? `${envApiKeys[id].slice(-4)} (from .env)`
          : null,
    })),
    speech: {
      elevenLabsKeySet: settings.speech.elevenLabsApiKey !== "",
      cartesiaKeySet: settings.speech.cartesiaApiKey !== "",
      deepgramKeySet: settings.speech.deepgramApiKey !== "",
    },
    decide:
      settings.decide.kind === "system-one"
        ? {
            kind: "system-one",
            url: settings.decide.url,
            model: settings.decide.model,
            apiKeySet: settings.decide.apiKey !== "",
          }
        : { kind: "model", model: routerModel(settings, envApiKeys) },
  };
}

// The router answers before any agent starts, so it is the fastest small model the person has a
// key for.
const routerModels = ["anthropic/claude-haiku-5-5", "openai/gpt-6-luna"];

const routerModel = (settings: Settings, envApiKeys: EnvApiKeys) =>
  routerModels.find((ref) =>
    keyOf(settings, envApiKeys, ref.slice(0, ref.indexOf("/")))
  ) ?? null;

// The router's small model, for the background jobs that need words rather than a choice.
async function routerPi(settings: Settings, envApiKeys: EnvApiKeys) {
  const ref = routerModel(settings, envApiKeys);
  if (!ref) {
    return null;
  }
  const providerId = ref.slice(0, ref.indexOf("/"));
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const provider = llmProviders.find(({ id }) => id === providerId);
  if (provider) {
    models.setProvider(provider);
  }
  await credentials.modify(providerId, async () => ({
    type: "api_key",
    key: keyOf(settings, envApiKeys, providerId),
  }));
  const model = models.getModel(providerId, ref.slice(ref.indexOf("/") + 1));
  return model ? { models, model } : null;
}

export type Complete = (input: {
  system: string;
  prompt: string;
  maxTokens: number;
}) => Promise<string | null>;

// Null when the person has no key the router can use; a call that fails answers null.
export async function completeFor(
  settings: Settings,
  envApiKeys: EnvApiKeys
): Promise<Complete | null> {
  const pi = await routerPi(settings, envApiKeys);
  if (!pi) {
    return null;
  }
  return async ({ system, prompt, maxTokens }) => {
    const reply = await pi.models.completeSimple(
      pi.model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      { maxTokens }
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return null;
    }
    return (
      reply.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .trim() || null
    );
  };
}

export async function decideFor(
  settings: Settings,
  envApiKeys: EnvApiKeys
): Promise<Decide> {
  if (settings.decide.kind === "model") {
    const pi = await routerPi(settings, envApiKeys);
    return pi ? piDecide(pi) : noOpinion;
  }
  const { url, apiKey, model } = settings.decide;
  return systemOneProvider({
    name: new URL(url).hostname,
    url,
    apiKey: apiKey || undefined,
    model: model || undefined,
  });
}

// What outlives a settings change: Pi's conversations, and each ACP harness's child processes
// while its command stays the same.
export type KeptHarnesses = {
  piSessions: PiSessions;
  acp: Map<string, { command: string; harness: Harness }>;
};

export const keptHarnesses = (): KeptHarnesses => ({
  piSessions: new Map(),
  acp: new Map(),
});

export const closeKept = (kept: KeptHarnesses) => {
  for (const { harness } of kept.acp.values()) {
    harness.close?.();
  }
  kept.acp.clear();
};

// Pi on the person's key, plus every ACP harness they turned on that is on PATH. An agent whose
// harness is missing is answered by Pi rather than not at all.
// Every model an agent can be given: those of each provider that has a key.
export function availableModels(settings: Settings, envApiKeys: EnvApiKeys) {
  return llmProviders
    .filter(({ id }) => keyOf(settings, envApiKeys, id))
    .flatMap((provider) =>
      provider.getModels().map((model) => ({
        id: `${provider.id}/${model.id}`,
        name: `${provider.name} · ${model.name}`,
      }))
    );
}

export async function harnessesFor({
  settings,
  envApiKeys,
  detected,
  mcp,
  cwd,
  kept,
}: {
  settings: Settings;
  envApiKeys: EnvApiKeys;
  detected: DetectedHarness[];
  mcp: RoomMcp;
  cwd: string;
  kept: KeptHarnesses;
}): Promise<{ harnesses: Record<string, Harness>; error: string | null }> {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  for (const provider of llmProviders) {
    models.setProvider(provider);
    const key = keyOf(settings, envApiKeys, provider.id);
    if (key) {
      await credentials.modify(provider.id, async () => ({
        type: "api_key",
        key,
      }));
    }
  }
  const wanted = new Map(
    detected
      .filter((found) => settings.harnesses.includes(found.id))
      .map((found) => [found.id, found.command])
  );
  for (const [id, { command, harness }] of kept.acp) {
    if (wanted.get(id)?.join(" ") !== command) {
      harness.close?.();
      kept.acp.delete(id);
    }
  }
  const acp = Object.fromEntries(
    [...wanted].map(([id, command]) => {
      const harness =
        kept.acp.get(id)?.harness ?? acpHarness({ command, cwd, mcp });
      kept.acp.set(id, { command: command.join(" "), harness });
      return [id, harness];
    })
  );
  // Each agent runs on its own model; one Pi per model, all sharing the kept conversations.
  const pis = new Map<Model<Api>, Harness>();
  const pi: Harness = {
    run: async (input) => {
      const ref = input.agent.model || settings.model;
      const slash = ref.indexOf("/");
      const provider = ref.slice(0, slash);
      const modelId = ref.slice(slash + 1);
      const model = models.getModel(provider, modelId);
      // Without a key or a model Pi cannot run, so the agent says why in the channel instead.
      if (!keyOf(settings, envApiKeys, provider)) {
        return `I have no ${provider} key yet: add one in Settings and ask again.`;
      }
      if (!model) {
        return `${provider} has no model "${modelId}": pick another in Settings.`;
      }
      const harness =
        pis.get(model) ??
        piHarness({
          model,
          streamFn: models.streamSimple.bind(models),
          sessions: kept.piSessions,
        });
      pis.set(model, harness);
      return harness.run(input);
    },
  };
  const error = llmProviders.some(({ id }) => keyOf(settings, envApiKeys, id))
    ? null
    : "no LLM key yet";
  return { harnesses: { pi, ...acp }, error };
}

// A single-use ElevenLabs Scribe token for one person's transcription; the key never reaches the
// browser.
export async function scribeTokenFor(
  settings: Settings,
  envKey: string | null
): Promise<{ token: string; baseUri: string } | null> {
  const apiKey = settings.speech.elevenLabsApiKey || envKey;
  if (!apiKey) {
    return null;
  }
  const response = await fetch(
    "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
    { method: "POST", headers: { "xi-api-key": apiKey } }
  );
  const parsed = z
    .object({ token: z.string() })
    .safeParse(await response.json().catch(() => null));
  return response.ok && parsed.success
    ? { token: parsed.data.token, baseUri: "wss://api.elevenlabs.io" }
    : null;
}

// TIDD-EC shaped: the drafted text is mostly rules, so its Always/Never lists stay explicit. The
// room's shared rules (live objects, suggest mode, never claim an unconfirmed change) are added
// at run time by agentSystemPrompt, so the draft leaves them out.
const draftInstructionsPrompt = `You write the instructions (the system prompt) for one AI agent in AirLink, a shared room where people and several agents talk in a channel and work together in live docs, sheets, canvases and slides. Each agent has a one-line role that decides when it is picked; its instructions decide how it behaves once picked. You are given the agent's name, its role, and possibly its current instructions.

Write the instructions in second person ("You ..."), in this shape, plain text with these four labels and short bullets:

What you do: one or two sentences that sharpen the role into a concrete job and the outcome people get.
How you work:
- 3 to 5 steps or habits specific to this job: what to check first, what to produce, where to put it (a reply in the channel for short answers, a live doc, sheet, canvas or slide for anything longer; a dashboard or chart that must stay current is a runner: a script that writes an index.html and refreshes on a schedule, never a sheet), when to ask a clarifying question instead of guessing.
Always:
- 2 to 4 rules on quality, tone and priorities for this job.
Never:
- 2 to 4 prohibitions, each a concrete action the agent must not take, stated as "Never ...".

Rules for writing them:
- If current instructions are given, keep every rule, fact and prohibition they state, and improve their wording and structure around them; do not drop or soften any of them.
- Never invent facts about the person's company, customers, tools, numbers or thresholds. Where a specific value would help but is unknown, write a placeholder like [fill in: approval limit].
- Do not restate generic rules every agent already gets: working through live tools, suggesting binding content for a person to accept, not claiming changes a tool did not confirm, not typing passwords or card numbers.
- Stay inside the role; do not widen the agent's job.
- Keep it under 200 words.

Reply with the instructions only: no preamble, no title, no code fence, no markdown headings or bold.`;

// A first draft of an agent's instructions from its name and role, on the model the agent runs on.
export async function draftInstructions(
  settings: Settings,
  envApiKeys: EnvApiKeys,
  agent: { name: string; role: string; instructions: string; model?: string }
): Promise<{ ok: true; instructions: string } | { ok: false; error: string }> {
  const ref = agent.model || settings.model;
  const providerId = ref.slice(0, ref.indexOf("/"));
  const key = keyOf(settings, envApiKeys, providerId);
  const provider = llmProviders.find(({ id }) => id === providerId);
  if (!key || !provider) {
    return {
      ok: false,
      error: `No ${providerId} key yet: add one in Settings.`,
    };
  }
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(provider);
  await credentials.modify(providerId, async () => ({ type: "api_key", key }));
  const model = models.getModel(providerId, ref.slice(ref.indexOf("/") + 1));
  if (!model) {
    return { ok: false, error: `${providerId} has no model for ${ref}.` };
  }
  const reply = await models.completeSimple(
    model,
    {
      systemPrompt: draftInstructionsPrompt,
      messages: [
        {
          role: "user",
          content: [
            `Agent name: ${agent.name}`,
            `Role: ${agent.role}`,
            agent.instructions.trim()
              ? `Current instructions:\n${agent.instructions.trim()}`
              : null,
          ]
            .filter((part) => part !== null)
            .join("\n\n"),
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 600 }
  );
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return { ok: false, error: reply.errorMessage ?? reply.stopReason };
  }
  return {
    ok: true,
    instructions: reply.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim(),
  };
}
