import { systemActor } from "@memo-air/protocol";
import type { RunnerState } from "@memo-air/runner";
import { notSetUpText, readRunnerState, runnerState } from "@memo-air/runner";
import { formatDistanceToNow } from "date-fns";
import { useCallback, useEffect, useState } from "react";
import type * as Y from "yjs";
import type { LiveHostRunner } from "./host";
import { useLiveHost } from "./host";
import { FileBody } from "./LiveFileView";
import type { LiveObjectStatus } from "./LiveObjectFrame";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import { Button, Spinner } from "./ui";
import type { LiveDocSession } from "./useLiveDocSession";

type RunnerTab = "code" | "output" | "dashboard";

const tabs: { id: RunnerTab; label: string }[] = [
  { id: "code", label: "Code" },
  { id: "output", label: "Output" },
  { id: "dashboard", label: "Dashboard" },
];

const statusLabels: Record<RunnerState["status"], string> = {
  idle: "Not run yet",
  running: "Running…",
  ok: "Ran",
  error: "Failed",
  timeout: "Timed out",
};

function useRunnerState(ydoc: Y.Doc | null): RunnerState | null {
  const [state, setState] = useState<RunnerState | null>(null);
  useEffect(() => {
    if (!ydoc) {
      setState(null);
      return;
    }
    const map = runnerState(ydoc);
    const onChange = () => setState(readRunnerState(ydoc));
    onChange();
    map.observe(onChange);
    return () => map.unobserve(onChange);
  }, [ydoc]);
  return state;
}

// A runner: the code an agent wrote, what its last run printed and wrote, and the dashboard it
// made. People watch, re-run and pause; only agents change the code.
export function LiveRunnerView(props: LiveDocViewProps) {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const onSession = useCallback(
    (session: LiveDocSession | null) => setYdoc(session?.ydoc ?? null),
    []
  );
  const state = useRunnerState(ydoc);
  const runKey = state ? `${state.lastRunAt ?? ""}:${state.status}` : null;
  const runner = useLiveHost().useRunner?.(props.docId, runKey) ?? null;
  const [tab, setTab] = useState<RunnerTab | null>(null);
  const [refusal, setRefusal] = useState<{
    runKey: string | null;
    text: string;
  } | null>(null);
  const act = async (action: () => Promise<string | null>) => {
    const text = await action();
    setRefusal(text ? { runKey, text } : null);
  };

  const status: LiveObjectStatus | null = state
    ? { label: statusLabels[state.status], live: state.status === "ok" }
    : null;
  const headerExtras =
    state && runner?.available ? (
      <div className="flex items-center gap-1.5">
        {state.lastRunAt && (
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(state.lastRunAt), {
              addSuffix: true,
            })}
            {state.lastRunBy
              ? ` by ${state.lastRunBy.id === systemActor.id ? "schedule" : state.lastRunBy.name}`
              : ""}
          </span>
        )}
        {state.refreshMinutes > 0 && (
          <Button
            size="xs"
            variant="ghost"
            label={state.paused ? "Resume" : "Pause"}
            tooltip={`Re-runs every ${state.refreshMinutes} min`}
            onClick={() => void act(() => runner.setPaused(!state.paused))}
          />
        )}
        <Button
          size="xs"
          variant="outline"
          label="Re-run"
          onClick={() => void act(runner.rerun)}
        />
      </div>
    ) : null;

  return (
    <LiveObjectFrame
      {...props}
      kindLabel="runner"
      status={status}
      headerExtras={headerExtras}
      showHistory={false}
      onToggleHistory={() => undefined}
      onSession={onSession}
    >
      {() =>
        state ? (
          <RunnerBody
            state={state}
            runner={runner}
            tab={tab ?? (state.hasDashboard ? "dashboard" : "output")}
            onTab={setTab}
            refusal={refusal?.runKey === runKey ? refusal.text : null}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        )
      }
    </LiveObjectFrame>
  );
}

function RunnerBody({
  state,
  runner,
  tab,
  onTab,
  refusal,
}: {
  state: RunnerState;
  runner: LiveHostRunner | null;
  tab: RunnerTab;
  onTab: (tab: RunnerTab) => void;
  refusal: string | null;
}) {
  const notice = refusal ?? (runner && !runner.available ? notSetUpText : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        className="flex gap-1 border-b border-border px-2 py-1"
      >
        {tabs.map((each) => (
          <Button
            key={each.id}
            size="xs"
            variant={tab === each.id ? "outline" : "ghost-secondary"}
            label={each.label}
            role="tab"
            aria-selected={tab === each.id}
            onClick={() => onTab(each.id)}
          />
        ))}
      </div>
      {notice && (
        <p className="border-b border-border px-3 py-2 text-xs text-warning-600">
          {notice}
        </p>
      )}
      {tab === "code" && (
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre">
          {state.code || "No code yet."}
        </pre>
      )}
      {tab === "output" && <RunnerOutput state={state} runner={runner} />}
      {tab === "dashboard" &&
        (state.hasDashboard && runner?.dashboardUrl ? (
          <iframe
            key={`${state.lastRunAt ?? ""}:${state.status}`}
            src={runner.dashboardUrl}
            title={`${state.title} dashboard`}
            sandbox="allow-scripts"
            className="min-h-0 flex-1 border-0 bg-white"
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">
            The last run wrote no index.html, so this runner has no dashboard.
          </p>
        ))}
    </div>
  );
}

function RunnerOutput({
  state,
  runner,
}: {
  state: RunnerState;
  runner: LiveHostRunner | null;
}) {
  const empty =
    !state.stdout &&
    !state.stderr &&
    state.outputs.length === 0 &&
    state.notes.length === 0;
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      {empty && <p className="text-sm text-muted-foreground">No output.</p>}
      {state.notes.length > 0 && (
        <p className="rounded-md bg-muted-background px-3 py-2 text-xs whitespace-pre-wrap">
          {state.notes.join("\n")}
        </p>
      )}
      <Stream label="stdout" text={state.stdout} />
      <Stream label="stderr" text={state.stderr} />
      {runner &&
        state.outputs.map((output) => (
          <div
            key={output.name}
            className="flex h-64 flex-col overflow-hidden rounded-lg border border-border"
          >
            <p className="border-b border-border px-3 py-1 text-xs font-medium">
              {output.name}
            </p>
            <FileBody
              file={{ ...output, url: runner.outputUrl(output.name) }}
            />
          </div>
        ))}
    </div>
  );
}

function Stream({ label, text }: { label: string; text: string }) {
  return text ? (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted-background p-2 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  ) : null;
}
