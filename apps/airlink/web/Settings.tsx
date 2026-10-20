import {
  Button,
  Check,
  Checkbox,
  Icon,
  Input,
  RefreshCw02,
  Spinner,
  Trash03,
  useSendNotification,
  XClose,
} from "@memo-air/react/ui";
import { useEffect, useRef, useState } from "react";

import type { PublicSettings } from "./api.ts";
import {
  api,
  harnessesSchema,
  modelsSchema,
  settingsSchema,
  useApi,
} from "./api.ts";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border py-6 dark:border-border-night">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
          {hint}
        </p>
      </div>
      {children}
    </section>
  );
}

export const fieldClass = "flex flex-col gap-1 text-sm font-medium";
export const selectClass =
  "h-9 rounded-xl border border-border bg-background px-3 text-sm dark:border-border-night dark:bg-background-night";

// A saved model that no keyed provider offers any more still shows, so the choice is never lost.
// A saved key shows as dots and its last characters, never as an empty box; clearing it opens the
// field for a new one, and leaving that empty keeps the saved key.
function KeyField({
  label,
  saved,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  saved: string | null;
  value: string | undefined;
  placeholder: string;
  onChange: (value: string | undefined) => void;
}) {
  const isShowingSaved = saved !== null && value === undefined;
  return (
    <label className={fieldClass}>
      <span className="flex items-center gap-1.5">
        {label}
        {saved !== null && (
          <Icon visual={Check} size="xs" className="text-green-600" />
        )}
      </span>
      <span className="relative">
        <Input
          type={isShowingSaved ? "text" : "password"}
          autoComplete="off"
          readOnly={isShowingSaved}
          className="pr-10"
          placeholder={placeholder}
          value={isShowingSaved ? `••••••••••••${saved}` : (value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        />
        {saved !== null && (
          <button
            type="button"
            aria-label={
              isShowingSaved ? `Change ${label}` : "Keep the saved key"
            }
            title={
              isShowingSaved ? "Clear to enter a new key" : "Keep the saved key"
            }
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
            onClick={() => onChange(isShowingSaved ? "" : undefined)}
          >
            <Icon visual={isShowingSaved ? XClose : RefreshCw02} size="xs" />
          </button>
        )}
      </span>
    </label>
  );
}

export function ModelSelect({
  label,
  value,
  models,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  models: { id: string; name: string }[];
  fallback?: string;
  onChange: (model: string) => void;
}) {
  return (
    <label className={fieldClass}>
      {label}
      <select
        className={selectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {fallback !== undefined && <option value="">{fallback}</option>}
        {value && !models.some((model) => model.id === value) && (
          <option value={value}>{value}</option>
        )}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// Everything AirLink needs from the person that no one agent owns: the keys, which harnesses may
// answer, where agents remember, and how routing decides. Each agent is edited on its own page.
export function Settings({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Settings"
      className="m-auto w-[min(720px,calc(100vw-32px))] rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:border-border-night dark:bg-background-night"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
      }}
    >
      <div className="flex h-[min(760px,calc(100vh-64px))] flex-col">
        <header className="flex items-center justify-between border-b border-border px-6 py-4 dark:border-border-night">
          <h1 className="text-xl font-bold">Settings</h1>
          <button
            type="button"
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon visual={XClose} size="sm" />
          </button>
        </header>
        <SettingsForm onSaved={() => dialogRef.current?.close()} />
      </div>
    </dialog>
  );
}

function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const notify = useSendNotification();
  const loaded = useApi("/api/settings", settingsSchema);
  const detected =
    useApi("/api/harnesses", harnessesSchema).data?.harnesses ?? [];
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const models = useApi("/api/models", modelsSchema).data?.models ?? [];
  // Provider id to the key typed in this session: "" keeps a saved key, null removes it.
  const [keys, setKeys] = useState<Record<string, string | null>>({});
  const [elevenLabsKey, setElevenLabsKey] = useState<string | undefined>();
  const [decideKey, setDecideKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    if (loaded.data) {
      setSettings(loaded.data.settings);
    }
  }, [loaded.data]);

  if (!settings) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const save = async () => {
    setIsSaving(true);
    setError(null);
    const saved = await api("/api/settings", settingsSchema, {
      method: "PUT",
      body: {
        keys,
        model: settings.model,
        harnesses: settings.harnesses,
        memoryRoot: settings.memoryRoot,
        speech: { elevenLabsApiKey: elevenLabsKey ?? "" },
        decide:
          settings.decide.kind === "system-one"
            ? { ...settings.decide, apiKey: decideKey ?? "" }
            : settings.decide,
      },
    });
    setIsSaving(false);
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setKeys({});
    setElevenLabsKey(undefined);
    setDecideKey(undefined);
    loaded.reload();
    onSaved();
    notify({
      type: "success",
      title: "Saved — agents use it from the next message",
    });
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col px-6 pb-6">
          <Section
            title="Models"
            hint="Each agent picks a model from a provider with a key. Keys stay on this machine and are never shown again."
          >
            {settings.providers
              .filter(({ id, saved }) =>
                keys[id] === undefined ? saved !== null : keys[id] !== null
              )
              .map((provider) => (
                <div key={provider.id} className="flex items-end gap-2">
                  <div className="flex-1">
                    <KeyField
                      label={`${provider.name} API key`}
                      saved={provider.saved}
                      value={keys[provider.id] ?? undefined}
                      placeholder={
                        provider.saved
                          ? "Paste the new key; empty keeps the saved one"
                          : "Paste your key"
                      }
                      onChange={(value) => {
                        const { [provider.id]: _dropped, ...rest } = keys;
                        setKeys(
                          value === undefined
                            ? rest
                            : { ...keys, [provider.id]: value }
                        );
                      }}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Trash03}
                    aria-label={`Remove ${provider.name}`}
                    tooltip="Remove"
                    onClick={() => setKeys({ ...keys, [provider.id]: null })}
                  />
                </div>
              ))}
            <label className={fieldClass}>
              Add a provider
              <select
                className={selectClass}
                value=""
                onChange={(event) =>
                  setKeys({ ...keys, [event.target.value]: "" })
                }
              >
                <option value="" disabled>
                  Choose…
                </option>
                {settings.providers
                  .filter(({ id, saved }) =>
                    keys[id] === undefined ? saved === null : keys[id] === null
                  )
                  .map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
              </select>
            </label>
            <ModelSelect
              label="Default model"
              value={settings.model}
              models={models}
              onChange={(model) => setSettings({ ...settings, model })}
            />
          </Section>

          <Section
            title="Harnesses"
            hint="Coding agents found on this machine. Turned on, an agent can run on one."
          >
            {detected.length === 0 && (
              <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
                None found on PATH (Claude Code, Codex, Gemini CLI, opencode).
                Pi is always available.
              </p>
            )}
            {detected.map((found) => (
              <label key={found.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={settings.harnesses.includes(found.id)}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      harnesses: checked
                        ? [...settings.harnesses, found.id]
                        : settings.harnesses.filter((id) => id !== found.id),
                    })
                  }
                />
                {found.name}
              </label>
            ))}
          </Section>
          <Section
            title="Memory"
            hint="Agents remember in plain Markdown files (OKF). Point this at an Obsidian vault to share it with them."
          >
            <Input
              label="Memory folder"
              placeholder="<data folder>/memory"
              value={settings.memoryRoot}
              onChange={(event) =>
                setSettings({ ...settings, memoryRoot: event.target.value })
              }
            />
          </Section>

          <Section
            title="Call transcription"
            hint="With an ElevenLabs key, everyone in a call can be transcribed in any browser. Without one, each browser's own speech service is used, and Brave and Firefox have none."
          >
            <KeyField
              label="ElevenLabs API key"
              saved={settings.speech.elevenLabsKeySet ? "" : null}
              value={elevenLabsKey}
              placeholder={
                settings.speech.elevenLabsKeySet
                  ? "Paste the new key; empty keeps the saved one"
                  : "Optional"
              }
              onChange={setElevenLabsKey}
            />
          </Section>

          <Section
            title="Decision node"
            hint="Every agent is equal: when a message names nobody, the decision node reads it against each agent's role and picks who answers."
          >
            <label className={fieldClass}>
              Router
              <select
                className={selectClass}
                value={settings.decide.kind}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    decide:
                      event.target.value === "system-one"
                        ? {
                            kind: "system-one",
                            url: "https://api.typesafe.ai/v1/systemone",
                            model: "",
                            apiKeySet: false,
                          }
                        : { kind: "model", model: null },
                  })
                }
              >
                <option value="model">
                  Your model (Claude Haiku 5.5, or GPT-6 Luna)
                </option>
                <option value="system-one">Jev (TypeSafe key)</option>
              </select>
            </label>
            {settings.decide.kind === "model" && (
              <p className="text-sm text-muted-foreground dark:text-muted-foreground-night">
                {settings.decide.model
                  ? `Routing on ${settings.decide.model}.`
                  : "Add an Anthropic or OpenAI key above to route; until then the room's first agent answers."}
              </p>
            )}
            {settings.decide.kind === "system-one" && (
              <>
                <Input
                  label="URL (a local Laya server works here too)"
                  value={settings.decide.url}
                  onChange={(event) =>
                    settings.decide.kind === "system-one" &&
                    setSettings({
                      ...settings,
                      decide: {
                        ...settings.decide,
                        url: event.target.value,
                      },
                    })
                  }
                />
                <Input
                  label="Model (optional)"
                  placeholder="jev-latest"
                  value={settings.decide.model}
                  onChange={(event) =>
                    settings.decide.kind === "system-one" &&
                    setSettings({
                      ...settings,
                      decide: {
                        ...settings.decide,
                        model: event.target.value,
                      },
                    })
                  }
                />
                <KeyField
                  label="Jev API key"
                  saved={settings.decide.apiKeySet ? "" : null}
                  value={decideKey}
                  placeholder={
                    settings.decide.apiKeySet
                      ? "Paste the new key; empty keeps the saved one"
                      : "Paste your TypeSafe key"
                  }
                  onChange={setDecideKey}
                />
              </>
            )}
          </Section>
        </div>
      </div>
      <footer className="flex items-center gap-3 border-t border-border px-6 py-3 dark:border-border-night">
        <Button label="Save" isLoading={isSaving} onClick={() => void save()} />
        {error && (
          <p role="alert" className="text-sm text-warning-600">
            {error}
          </p>
        )}
      </footer>
    </>
  );
}
