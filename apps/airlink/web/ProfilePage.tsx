import {
  Button,
  Icon,
  Input,
  Markdown,
  Search,
  TextArea,
  Trash03,
} from "@memo-air/react/ui";
import { useState } from "react";
import { z } from "zod";
import { Avatar } from "./Avatar.tsx";
import type { Agent, Person } from "./api.ts";
import {
  agentsSchema,
  api,
  harnessesSchema,
  modelsSchema,
  settingsSchema,
  useApi,
  voicesSchema,
} from "./api.ts";
import { fieldClass, ModelSelect, selectClass } from "./Settings.tsx";

const entrySchema = z.object({
  slug: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  timestamp: z.string().optional(),
  body: z.string(),
});
type Entry = z.infer<typeof entrySchema>;

const agentMemorySchema = z.object({
  dir: z.string(),
  entries: z.array(entrySchema),
});
const personMemorySchema = z.object({
  entries: z.array(
    entrySchema.extend({
      agent: z.object({ id: z.string(), name: z.string() }),
    })
  ),
});

export type Profile =
  | { kind: "agent"; agent: Agent }
  | { kind: "human"; person: Person; isSelf: boolean; isOnline: boolean };

// One profile for anyone in the workspace, as a page beside the sidebar. An agent's is its
// identity and settings with the OKF folder it remembers in; a person's is who they are and what
// the agents remember about them — a person keeps no memory of their own here, the agents' notes
// about them are it.
export function ProfilePage({
  profile,
  onAgentSaved,
}: {
  profile: Profile;
  onAgentSaved: () => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col py-8">
        {profile.kind === "agent" ? (
          <AgentProfile agent={profile.agent} onSaved={onAgentSaved} />
        ) : (
          <HumanProfile profile={profile} />
        )}
      </div>
    </div>
  );
}

// The agent's whole configuration, edited where it is read. Saving writes the full list, the
// same call Settings makes, so the two never disagree about an agent.
function AgentProfile({
  agent,
  onSaved,
}: {
  agent: Agent;
  onSaved: () => void;
}) {
  const memory = useApi(`/api/agents/${agent.id}/memory`, agentMemorySchema);
  const allAgents = useApi("/api/agents", agentsSchema);
  const detected =
    useApi("/api/harnesses", harnessesSchema).data?.harnesses ?? [];
  const settings = useApi("/api/settings", settingsSchema).data?.settings;
  const models = useApi("/api/models", modelsSchema).data?.models ?? [];
  const voices = useApi("/api/voices", voicesSchema).data?.voices ?? [];
  const [previewing, setPreviewing] = useState(false);
  const [draft, setDraft] = useState(agent);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(agent);
  const harnessChoices = [{ id: "pi", name: "Pi (built in)" }, ...detected];
  const update = (patch: Partial<Agent>) => setDraft({ ...draft, ...patch });

  const preview = async () => {
    if (!draft.voice.id) {
      return;
    }
    setPreviewing(true);
    try {
      const response = await fetch("/api/voices/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          voiceId: draft.voice.id,
          speed: draft.voice.speed,
        }),
      });
      if (response.ok) {
        const url = URL.createObjectURL(await response.blob());
        const audio = new Audio(url);
        const release = () => URL.revokeObjectURL(url);
        audio.addEventListener("ended", release, { once: true });
        audio.addEventListener("error", release, { once: true });
        await audio.play().catch((error: unknown) => {
          release();
          throw error;
        });
      }
    } catch {
      // A blocked autoplay or a dropped request only means no preview.
    } finally {
      setPreviewing(false);
    }
  };

  const write = async (next: (agents: Agent[]) => Agent[]) => {
    const agents = allAgents.data?.agents;
    if (!agents) {
      return false;
    }
    setIsSaving(true);
    const result = await api("/api/agents", agentsSchema, {
      method: "PUT",
      body: next(agents),
    });
    setIsSaving(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError(null);
    allAgents.reload();
    onSaved();
    return true;
  };

  const save = () =>
    write((agents) =>
      agents.map((each) => (each.id === agent.id ? draft : each))
    );

  const remove = async () => {
    if (
      await write((agents) => agents.filter((each) => each.id !== agent.id))
    ) {
      window.location.hash = "#/";
    }
  };

  return (
    <>
      <header className="flex items-center gap-5 px-6 pb-6">
        <Avatar id={agent.id} name={draft.name} kind="agent" size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-2xl font-bold">{draft.name}</h1>
          <span className="text-sm text-muted-foreground">
            Agent · {agent.id}
          </span>
        </div>
        {!isDirty &&
          (isConfirmingDelete ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                label="Keep"
                onClick={() => setIsConfirmingDelete(false)}
              />
              <Button
                size="sm"
                variant="warning"
                label={`Delete ${agent.name}`}
                isLoading={isSaving}
                onClick={() => void remove()}
              />
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={Trash03}
              aria-label={`Delete ${agent.name}`}
              tooltip="Delete agent"
              disabled={(allAgents.data?.agents.length ?? 0) <= 1}
              onClick={() => setIsConfirmingDelete(true)}
            />
          ))}
        {isDirty && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              label="Discard"
              onClick={() => {
                setDraft(agent);
                setError(null);
              }}
            />
            <Button
              size="sm"
              variant="primary"
              label="Save"
              isLoading={isSaving}
              onClick={() => void save()}
            />
          </div>
        )}
      </header>
      <div className="flex flex-col gap-6 px-6 pb-6">
        {error && (
          <p role="alert" className="text-sm text-warning-600">
            {error}
          </p>
        )}
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Identity</h3>
          <Input
            label="Name"
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
          />
          <label className={fieldClass}>
            Role
            <span className="text-xs font-normal text-muted-foreground">
              One line on what this agent is for. The room reads it to decide
              who answers a message nobody named.
            </span>
            <TextArea
              value={draft.role}
              minRows={2}
              onChange={(event) => update({ role: event.target.value })}
            />
          </label>
          <label className={fieldClass}>
            Instructions
            <span className="text-xs font-normal text-muted-foreground">
              Its own system prompt: how it works, its priorities and tone, what
              it must not do. This is what makes two agents behave differently.
            </span>
            <TextArea
              value={draft.instructions}
              minRows={6}
              placeholder="You review vendor contracts. Flag auto-renewals and price increases above 5%, quote the clause, and never accept terms yourself."
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </label>
          <Input
            label="Tags (comma separated)"
            value={draft.tags.join(", ")}
            onChange={(event) =>
              update({
                tags: event.target.value
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Settings</h3>
          <div className="flex flex-wrap items-end gap-4">
            <label className={fieldClass}>
              Runs on
              <select
                className={selectClass}
                value={draft.harness}
                onChange={(event) => update({ harness: event.target.value })}
              >
                {harnessChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.harness === "pi" && settings && (
              <ModelSelect
                label="Model"
                value={draft.model ?? ""}
                models={models}
                fallback={`Default (${settings.model})`}
                onChange={(model) => update({ model: model || undefined })}
              />
            )}
            <label className={fieldClass}>
              Can
              <select
                className={selectClass}
                value={draft.access}
                onChange={(event) =>
                  update({
                    access:
                      event.target.value === "suggest" ? "suggest" : "write",
                  })
                }
              >
                <option value="write">Edit</option>
                <option value="suggest">Only suggest</option>
              </select>
            </label>
            <label className={fieldClass}>
              Voice
              <div className="flex gap-2">
                <select
                  className={selectClass}
                  value={draft.voice.id ?? ""}
                  onChange={(event) =>
                    update({
                      voice: {
                        ...draft.voice,
                        id: event.target.value || undefined,
                      },
                    })
                  }
                >
                  <option value="">Automatic (distinct)</option>
                  {voices.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  label="Preview"
                  aria-label="Preview voice"
                  disabled={!draft.voice.id || previewing}
                  onClick={() => void preview()}
                />
              </div>
            </label>
            <label className={fieldClass}>
              Speed {draft.voice.speed.toFixed(2)}×
              <input
                type="range"
                min={0.8}
                max={1.2}
                step={0.05}
                value={draft.voice.speed}
                onChange={(event) =>
                  update({
                    voice: {
                      ...draft.voice,
                      speed: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Memory</h3>
          <Input
            label="Memory folder (optional)"
            placeholder={`Default: ${settings?.memoryRoot || "<data folder>/memory"}/${agent.id}`}
            value={draft.memoryDir ?? ""}
            onChange={(event) =>
              update({ memoryDir: event.target.value || undefined })
            }
          />
          {memory.data && (
            <p className="text-xs text-muted-foreground">
              Plain Markdown (OKF) in{" "}
              <code className="rounded bg-muted-background px-1 py-0.5 font-mono text-[11px] text-foreground">
                {memory.data.dir}
              </code>
            </p>
          )}
          <MemoryList
            entries={memory.data?.entries ?? null}
            error={memory.error}
            emptyText={`${draft.name} has not remembered anything yet.`}
          />
        </section>
      </div>
    </>
  );
}

const footprintSchema = z.object({
  person: z.object({ seenAtMs: z.number() }),
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      messages: z.number(),
      lastAtMs: z.number(),
    })
  ),
});

const when = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function HumanProfile({
  profile,
}: {
  profile: Extract<Profile, { kind: "human" }>;
}) {
  const { person, isSelf, isOnline } = profile;
  const memory = useApi(`/api/people/${person.id}/memory`, personMemorySchema);
  const footprint = useApi(`/api/people/${person.id}`, footprintSchema);
  return (
    <>
      <header className="flex items-center gap-5 px-6 pb-6">
        <span className="relative">
          <Avatar id={person.id} name={person.name} kind="human" size="lg" />
          {isOnline && (
            <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-background" />
          )}
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-2xl font-bold">
            {person.name}
            {isSelf && (
              <span className="font-normal text-muted-foreground"> (you)</span>
            )}
          </h1>
          <span className="text-sm text-muted-foreground">
            Person · {isOnline ? "online" : "away"}
            {footprint.data && !isOnline
              ? ` · last here ${when.format(footprint.data.person.seenAtMs)}`
              : ""}
          </span>
        </div>
      </header>
      <section className="flex flex-col gap-2 px-6 pb-6">
        <h3 className="text-sm font-semibold">Channels</h3>
        {footprint.error && !footprint.data ? (
          <p className="text-sm text-warning-600">
            Could not read the channels: {footprint.error}
          </p>
        ) : !footprint.data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : footprint.data.channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isSelf ? "You have" : `${person.name} has`} not written in any
            channel yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {footprint.data.channels.map((channel) => (
              <li key={channel.id}>
                <a
                  href={`#/c/${channel.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 hover:bg-muted-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
                >
                  <span className="text-muted-foreground">#</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {channel.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {channel.messages}{" "}
                    {channel.messages === 1 ? "message" : "messages"} · last{" "}
                    {when.format(channel.lastAtMs)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex flex-col gap-2 px-6 pb-6">
        <h3 className="text-sm font-semibold">
          What the agents remember about {isSelf ? "you" : person.name}
        </h3>
        <MemoryList
          entries={memory.data?.entries ?? null}
          error={memory.error}
          emptyText={`No agent has a note about ${isSelf ? "you" : person.name} yet. Agents write one when someone tells them something worth keeping.`}
        />
      </div>
    </>
  );
}

function MemoryList({
  entries,
  error,
  emptyText,
}: {
  entries: (Entry & { agent?: { name: string } })[] | null;
  error: string | null;
  emptyText: string;
}) {
  const [query, setQuery] = useState("");
  if (entries === null && error) {
    return (
      <p className="text-sm text-warning-600">
        Could not read the memory: {error}
      </p>
    );
  }
  if (entries === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  const needle = query.trim().toLowerCase();
  const shown = entries.filter((entry) =>
    [entry.title, entry.type, entry.body, ...entry.tags]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
  return (
    <div className="flex flex-col gap-2">
      {entries.length > 5 && (
        <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 focus-within:border-highlight">
          <Icon visual={Search} size="xs" className="text-muted-foreground" />
          <input
            type="search"
            value={query}
            placeholder="Find in memory"
            aria-label="Find in memory"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <ul className="flex flex-col gap-1.5">
        {shown.map((entry) => (
          <li key={`${entry.agent?.name ?? ""}/${entry.slug}`}>
            <details className="group rounded-lg border border-border open:bg-muted-background/50">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight">
                <span className="rounded bg-muted-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
                  {entry.type}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {entry.title}
                </span>
                {entry.agent && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    by {entry.agent.name}
                  </span>
                )}
              </summary>
              <div className="flex flex-col gap-2 border-t border-border px-3 py-2 text-sm">
                <Markdown content={entry.body} textSize="sm" />
                {(entry.tags.length > 0 || entry.timestamp) && (
                  <span className="text-xs text-muted-foreground">
                    {[
                      entry.timestamp &&
                        new Date(entry.timestamp).toLocaleString(),
                      entry.tags.map((tag) => `#${tag}`).join(" "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
