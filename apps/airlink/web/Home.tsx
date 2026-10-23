import type { LiveDocKind } from "@memo-air/protocol";
import { liveDocIcon } from "@memo-air/react";
import {
  ArrowRight,
  AtSign,
  Button,
  Check,
  cn,
  Icon,
  Phone01,
  Spinner,
  useSendNotification,
} from "@memo-air/react/ui";
import type { Agent, Channel } from "./api.ts";
import { peopleSchema, settingsSchema, useApi, voiceSchema } from "./api.ts";
import { queueDraft } from "./Composer.tsx";

const repoUrl = "https://github.com/MemoAir-labs/Airlink";

const starters: { kind: LiveDocKind; prompt: string }[] = [
  { kind: "doc", prompt: "draft a one-page launch plan for our product" },
  {
    kind: "slides",
    prompt: "make a five-slide deck that pitches this project",
  },
  {
    kind: "sheet",
    prompt: "build a sheet comparing three competitors on price and features",
  },
];

const howItWorks = [
  {
    icon: AtSign,
    title: "Mention an agent",
    detail:
      "Type @ and pick one. It answers in the channel and makes docs, sheets and decks there.",
  },
  {
    icon: liveDocIcon("canvas"),
    title: "Edit together",
    detail:
      "Open anything in a channel and edit it alongside agents, each with its own cursor.",
  },
  {
    icon: Check,
    title: "Approve what matters",
    detail:
      "Agents can suggest edits instead of making them. You accept or reject each one.",
  },
  {
    icon: Phone01,
    title: "Start a huddle",
    detail:
      "Talk with people and agents at once. Agents answer out loud and keep editing.",
  },
];

interface HomeProps {
  channels: Channel[];
  agents: Agent[];
  onOpenSettings: () => void;
  onNewChannel: () => void;
  onNewAgent: () => void;
}

// A first-run page: what is left to set up, prompts that show what agents do, and how AirLink works.
export function Home({
  channels,
  agents,
  onOpenSettings,
  onNewChannel,
  onNewAgent,
}: HomeProps) {
  const notify = useSendNotification();
  const settings = useApi("/api/settings", settingsSchema).data?.settings;
  const voice = useApi("/api/voice", voiceSchema).data;
  const people = useApi("/api/people", peopleSchema).data?.people;

  if (!settings || !voice || !people) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const copyInvite = async () => {
    await navigator.clipboard.writeText(window.location.origin);
    notify({
      type: "success",
      title: "Link copied. Anyone who opens it can join.",
    });
  };

  const steps = [
    {
      title: "Connect a model",
      detail: "Add an API key so agents can think. A key in .env counts.",
      done: settings.providers.some((provider) => provider.saved),
      action: { label: "Open Settings", onClick: onOpenSettings },
    },
    {
      title: "Create a channel",
      detail:
        "A channel holds the chat and every doc, sheet and deck made in it.",
      done: channels.length > 0,
      action: { label: "New channel", onClick: onNewChannel },
    },
    {
      title: "Add an agent",
      detail:
        "Pick a harness and a model. Agents join channels like people do.",
      done: agents.length > 0,
      action: { label: "New agent", onClick: onNewAgent },
    },
    {
      title: "Invite a teammate",
      detail: "Share this workspace's link so people and agents work together.",
      done: people.length > 1,
      action: { label: "Copy link", onClick: copyInvite },
    },
    {
      title: "Add a voice key",
      detail:
        "Optional. ElevenLabs, Cartesia, Deepgram or OpenAI lets agents talk in huddles.",
      done: voice.available,
      action: { label: "Open Settings", onClick: onOpenSettings },
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);

  const channel =
    channels.find((candidate) => candidate.name === "general") ?? channels[0];
  const agentName = agents[0]?.name;
  const tryStarter = (prompt: string) => {
    if (!channel || !agentName) {
      return;
    }
    queueDraft(`@${agentName} ${prompt}`);
    window.location.hash = `#/c/${channel.id}`;
  };

  const muted = "text-muted-foreground";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-8 sm:px-8 sm:py-10">
        <header className="home-hero relative overflow-hidden rounded-2xl bg-sidebar px-6 py-8 text-sidebar-foreground shadow-[0_18px_40px_-20px_oklch(25%_0.08_238/0.7)] sm:px-10 sm:py-10">
          <div className="relative grid items-center gap-8 md:grid-cols-[1.1fr_1fr]">
            <div className="flex flex-col gap-4">
              <h1 className="text-balance text-[clamp(1.75rem,3.4vw,2.6rem)] font-semibold leading-[1.08] tracking-[-0.025em]">
                Many humans. Many agents.{" "}
                <span className="text-[oklch(84%_0.11_195)]">
                  One full-duplex live workspace.
                </span>
              </h1>
              <p className="max-w-[46ch] text-[15px] leading-relaxed text-sidebar-muted">
                Chat, talk and edit the same docs, sheets and decks at once.
                Nobody waits for a turn, people or agents.
              </p>
              {next ? (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <Button
                    label={next.title}
                    icon={ArrowRight}
                    onClick={next.action.onClick}
                    className="bg-linear-to-r from-sidebar-active to-sidebar-active-to shadow-md ring-1 ring-white/15 hover:brightness-110"
                  />
                  <span className="text-[13px] text-sidebar-muted">
                    {doneCount} of {steps.length} set up
                  </span>
                </div>
              ) : (
                <p className="mt-1 flex items-center gap-2 text-sm font-medium text-[oklch(84%_0.11_195)]">
                  <Icon visual={Check} size="sm" />
                  You're set up. Try a prompt below.
                </p>
              )}
            </div>
            <DuplexScene />
          </div>
        </header>

        <section className="flex flex-col gap-4" aria-labelledby="setup">
          <div className="flex items-end justify-between gap-4">
            <h2 id="setup" className="text-lg font-semibold tracking-[-0.01em]">
              Get set up
            </h2>
            <div className="flex items-center gap-3">
              <span className={cn("text-[13px] tabular-nums", muted)}>
                {doneCount}/{steps.length}
              </span>
              <span
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={doneCount}
                className="h-1.5 w-28 overflow-hidden rounded-full bg-muted-background ring-1 ring-border"
              >
                <span
                  className="block h-full rounded-full bg-linear-to-r from-highlight-500 to-teal-500 transition-[width] duration-700 ease-out"
                  style={{ width: `${(doneCount / steps.length) * 100}%` }}
                />
              </span>
            </div>
          </div>
          <ol className="flex flex-col overflow-hidden rounded-xl border border-border">
            {steps.map((step) => (
              <li
                key={step.title}
                className={cn(
                  "flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0 sm:px-5",
                  step === next && "bg-highlight-50/60 dark:bg-highlight-900/20"
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    step.done
                      ? "bg-linear-to-br from-highlight-500 to-teal-500 text-white shadow-sm"
                      : step === next
                        ? "ring-2 ring-highlight-500 ring-offset-2 ring-offset-background"
                        : "ring-1 ring-border"
                  )}
                >
                  {step.done && <Icon visual={Check} size="xs" />}
                  <span className="sr-only">
                    {step.done ? "Done" : "To do"}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-sm font-medium",
                      step.done && muted
                    )}
                  >
                    {step.title}
                  </span>
                  <span className={cn("block text-[13px] leading-snug", muted)}>
                    {step.detail}
                  </span>
                </span>
                {!step.done && (
                  <Button
                    variant={step === next ? "primary" : "outline"}
                    label={step.action.label}
                    onClick={step.action.onClick}
                  />
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="try">
          <div className="flex flex-col gap-1">
            <h2 id="try" className="text-lg font-semibold tracking-[-0.01em]">
              Try it
            </h2>
            <p className={cn("text-sm", muted)}>
              {channel && agentName
                ? `Each prompt opens #${channel.name} with the message ready to send.`
                : "Create a channel and an agent to try a starter prompt."}
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            {starters.map(({ kind, prompt }) => (
              <li key={prompt}>
                <button
                  type="button"
                  disabled={!channel || !agentName}
                  onClick={() => tryStarter(prompt)}
                  className="group flex w-full items-center gap-4 rounded-xl border border-border px-4 py-3 text-left transition-[background-color,border-color,transform] duration-200 ease-out hover:-translate-y-px hover:border-highlight-300 hover:bg-highlight-50/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-highlight-500 disabled:pointer-events-none disabled:opacity-50 dark:hover:border-highlight-700 dark:hover:bg-highlight-900/20"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-highlight-500 to-teal-500 text-white shadow-sm">
                    <Icon visual={liveDocIcon(kind)} size="sm" />
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium text-highlight-600 dark:text-highlight-400">
                      @{agentName ?? "agent"}
                    </span>{" "}
                    {prompt}
                  </span>
                  <Icon
                    visual={ArrowRight}
                    size="sm"
                    className={cn(
                      "transition-transform duration-200 ease-out group-hover:translate-x-0.5",
                      muted
                    )}
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-5" aria-labelledby="how">
          <h2 id="how" className="text-lg font-semibold tracking-[-0.01em]">
            How it works
          </h2>
          <ul className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
            {howItWorks.map(({ icon, title, detail }) => (
              <li key={title} className="flex gap-3">
                <Icon
                  visual={icon}
                  size="md"
                  className="mt-0.5 text-highlight-500"
                />
                <span className="text-sm">
                  <span className="block font-medium">{title}</span>
                  <span className={cn("leading-relaxed", muted)}>{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <footer
          className={cn(
            "flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-5 text-[13px]",
            muted
          )}
        >
          <span className="font-medium text-foreground">
            AirLink is open source
          </span>
          {[
            ["GitHub", repoUrl],
            ["Getting started", `${repoUrl}/blob/main/docs/getting-started.md`],
            ["Self-hosting", `${repoUrl}/blob/main/docs/self-hosting.md`],
            ["Agents", `${repoUrl}/blob/main/docs/agents.md`],
            ["Report an issue", `${repoUrl}/issues`],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              {label}
            </a>
          ))}
        </footer>
      </div>
    </div>
  );
}

// Full duplex, shown rather than told: a person and an agent write into the same doc while both
// talk, nobody waiting for a turn.
function DuplexScene() {
  return (
    <div
      aria-hidden="true"
      className="relative rounded-xl bg-white/[0.06] p-4 ring-1 ring-white/10"
    >
      <div className="mb-3 flex items-center justify-between text-[11px] text-sidebar-muted">
        <span className="flex items-center gap-1.5">
          <Icon visual={liveDocIcon("doc")} size="xs" />
          Launch plan
        </span>
        <span className="flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="home-ping absolute inline-flex h-full w-full rounded-full bg-[oklch(84%_0.11_195)]" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[oklch(84%_0.11_195)]" />
          </span>
          Live
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        <DuplexLine width="78%" tone="human" delayMs={0} />
        <DuplexLine width="92%" tone="agent" delayMs={900} />
        <DuplexLine width="64%" tone="human" delayMs={1800} />
        <DuplexLine width="84%" tone="agent" delayMs={2700} />
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-3">
        <Speaker name="You" tone="human" />
        <Speaker name="Assistant" tone="agent" />
      </div>
    </div>
  );
}

const toneColor = {
  human: "oklch(78% 0.12 235)",
  agent: "oklch(84% 0.11 195)",
};

function DuplexLine({
  width,
  tone,
  delayMs,
}: {
  width: string;
  tone: keyof typeof toneColor;
  delayMs: number;
}) {
  return (
    <div className="relative h-2" style={{ width }}>
      <span
        className="home-write absolute inset-y-0 left-0 rounded-full"
        style={{
          background: `color-mix(in oklch, ${toneColor[tone]} 45%, transparent)`,
          animationDelay: `${delayMs}ms`,
        }}
      />
      <span
        className="home-caret absolute inset-0"
        style={{ animationDelay: `${delayMs}ms` }}
      >
        <span
          className="absolute -top-1 left-0 h-4 w-0.5 rounded-full"
          style={{ background: toneColor[tone] }}
        >
          <span
            className="absolute -top-4 left-0 rounded px-1 text-[9px] font-semibold leading-3.5 text-sidebar"
            style={{ background: toneColor[tone] }}
          >
            {tone === "human" ? "You" : "Assistant"}
          </span>
        </span>
      </span>
    </div>
  );
}

function Speaker({
  name,
  tone,
}: {
  name: string;
  tone: keyof typeof toneColor;
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pr-2.5 pl-2 text-[11px] text-sidebar-foreground">
      <span className="flex h-3 items-center gap-[2px]">
        {[0, 150, 300, 450].map((delayMs) => (
          <span
            key={delayMs}
            className="h-full w-[2px] origin-center animate-voice rounded-full"
            style={{
              background: toneColor[tone],
              animationDelay: `${delayMs + (tone === "agent" ? 220 : 0)}ms`,
            }}
          />
        ))}
      </span>
      {name}
    </span>
  );
}
