import type { HistoryResponse, VersionResponse } from "@memo-air/protocol";
import { format } from "date-fns";
import { useState } from "react";
import { useLiveHost } from "./host";
import { assertNeverAndIgnore } from "./liveViewShared";
import { Button, cn, Spinner } from "./ui";

type HistoryEvent = HistoryResponse["events"][number];
type BlockDiff = VersionResponse["diff"][number];

function actorLabel(actor: { kind: "human" | "agent"; name: string }) {
  return actor.kind === "agent" ? `✦ ${actor.name}` : actor.name;
}

function eventLabel(event: HistoryEvent): string | null {
  const who = actorLabel(event.actor);
  switch (event.type) {
    case "suggestion_accepted":
      return `${who} accepted a suggestion`;
    case "suggestion_rejected":
      return `${who} rejected a suggestion`;
    case "restore":
      return `${who} restored an earlier version`;
    case "comment":
      return `${who} commented`;
    case "agent_ops":
      return event.payload.mode === "suggest"
        ? `${who} suggested a change`
        : null;
    default:
      return null;
  }
}

function DiffBlock({ entry }: { entry: BlockDiff }) {
  const before = entry.before?.text ?? "";
  const after = entry.after?.text ?? "";
  switch (entry.change) {
    case "same":
      return <p className="text-muted-foreground">{after}</p>;
    case "added":
      return (
        <p className="underline decoration-green-600 decoration-2">
          <span className="sr-only">Added: </span>
          {after}
        </p>
      );
    case "removed":
      return (
        <p className="text-muted-foreground line-through">
          <span className="sr-only">Removed: </span>
          {before}
        </p>
      );
    case "changed":
      return (
        <div className="flex flex-col gap-0.5">
          {before !== after && (
            <p className="text-muted-foreground line-through">
              <span className="sr-only">Before: </span>
              {before}
            </p>
          )}
          <p className="underline decoration-green-600 decoration-2">
            <span className="sr-only">After: </span>
            {after}
          </p>
        </div>
      );
    default:
      assertNeverAndIgnore(entry.change);
      return null;
  }
}

interface LiveDocHistoryProps {
  docId: string;
  canWrite: boolean;
  onClose: () => void;
}

export function LiveDocHistory({
  docId,
  canWrite,
  onClose,
}: LiveDocHistoryProps) {
  const host = useLiveHost();
  const { history, isHistoryLoading, isHistoryError, mutateHistory } =
    host.useHistory({ docId });
  const [selected, setSelected] = useState(0);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const restore = host.useRestore(docId);

  const sessions = history?.sessions ?? [];
  const session = sessions[selected];
  const { version, isVersionLoading } = host.useVersion({
    docId,
    uptoId: session?.uptoId ?? null,
    sinceId: sessions[selected + 1]?.uptoId ?? null,
  });

  const select = (index: number) => {
    setSelected(index);
    setConfirmRestore(false);
  };

  if (isHistoryLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (isHistoryError || !session) {
    return (
      <div className="flex flex-col gap-2 p-6 text-sm text-muted-foreground">
        {isHistoryError
          ? "History is not available right now."
          : "No edits yet."}
        <Button
          size="xs"
          variant="outline"
          label="Back to doc"
          onClick={onClose}
        />
      </div>
    );
  }

  const sessionEvents = (index: number) => {
    const { startedAt } = sessions[index];
    const newerStartedAt = sessions[index - 1]?.startedAt;
    return (history?.events ?? []).filter(
      (event) =>
        event.createdAt >= startedAt &&
        (!newerStartedAt || event.createdAt < newerStartedAt)
    );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden text-sm">
      <ol className="w-40 shrink-0 overflow-y-auto border-r border-border py-2 dark:border-border-night">
        {sessions.map((entry, index) => (
          <li key={entry.uptoId}>
            <button
              type="button"
              aria-current={index === selected}
              onClick={() => select(index)}
              className={cn(
                "flex w-full flex-col px-3 py-2 text-left hover:bg-muted-background dark:hover:bg-muted-background-night",
                index === selected &&
                  "bg-muted-background dark:bg-muted-background-night"
              )}
            >
              <span className="truncate font-medium">
                {actorLabel(entry.actor)}
              </span>
              <span className="text-xs text-muted-foreground">
                {format(new Date(entry.endedAt), "MMM d, HH:mm")}
              </span>
              {sessionEvents(index).flatMap((event) => {
                const label = eventLabel(event);
                return label ? (
                  <span
                    key={`${event.type}-${event.createdAt}`}
                    className="truncate text-xs text-muted-foreground"
                  >
                    {label}
                  </span>
                ) : (
                  []
                );
              })}
            </button>
          </li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 dark:border-border-night">
          <Button
            size="xs"
            variant="ghost"
            label="‹ Older"
            disabled={selected >= sessions.length - 1}
            onClick={() => select(selected + 1)}
          />
          <Button
            size="xs"
            variant="ghost"
            label="Newer ›"
            disabled={selected === 0}
            onClick={() => select(selected - 1)}
          />
          <div className="flex-1" />
          {canWrite && selected > 0 && (
            <Button
              size="xs"
              variant={confirmRestore ? "warning" : "outline"}
              label={
                confirmRestore ? "Confirm restore" : "Restore this version"
              }
              isLoading={isRestoring}
              onClick={async () => {
                if (!confirmRestore) {
                  setConfirmRestore(true);
                  return;
                }
                setIsRestoring(true);
                const restored = await restore(session.uptoId);
                setIsRestoring(false);
                if (restored) {
                  await mutateHistory();
                  onClose();
                }
              }}
            />
          )}
          <Button
            size="xs"
            variant="ghost"
            label="Back to doc"
            onClick={onClose}
          />
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto px-4 py-3">
          <p className="text-xs text-muted-foreground">
            What {actorLabel(session.actor)} changed in this session
          </p>
          {isVersionLoading || !version ? (
            <Spinner size="sm" />
          ) : (
            <>
              {version.diff.map((entry) => (
                <DiffBlock key={entry.blockId} entry={entry} />
              ))}
              {version.cells.map((change) => (
                <div
                  key={change.cell}
                  className="flex items-baseline gap-2 text-sm text-foreground dark:text-foreground-night"
                >
                  <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground dark:text-muted-foreground-night">
                    {change.cell}
                  </span>
                  {change.before && (
                    <span className="text-muted-foreground line-through dark:text-muted-foreground-night">
                      {change.before}
                    </span>
                  )}
                  <span className="text-green-700 dark:text-green-400">
                    {change.after || "(cleared)"}
                  </span>
                </div>
              ))}
              {version.slides.map((change, i) => (
                <div
                  key={`${change.target}-${change.label}-${i}`}
                  className="flex items-baseline gap-2 text-sm text-foreground dark:text-foreground-night"
                >
                  <span className="w-28 shrink-0 text-xs text-muted-foreground dark:text-muted-foreground-night">
                    {change.kind} · {change.target}
                  </span>
                  <span
                    className={cn(
                      change.kind === "removed" &&
                        "text-muted-foreground line-through dark:text-muted-foreground-night",
                      change.kind === "added" &&
                        "text-green-700 dark:text-green-400"
                    )}
                  >
                    {change.label}
                    {change.target === "element" && change.slide && (
                      <span className="text-muted-foreground dark:text-muted-foreground-night">
                        {" "}
                        on {change.slide}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {version.shapes.map((change) => (
                <div
                  key={change.id}
                  className="flex items-baseline gap-2 text-sm text-foreground dark:text-foreground-night"
                >
                  <span className="w-28 shrink-0 text-xs text-muted-foreground dark:text-muted-foreground-night">
                    {change.kind} ·{" "}
                    {change.type === "arrow" || change.type === "text"
                      ? change.type
                      : "shape"}
                  </span>
                  <span
                    className={cn(
                      change.kind === "removed" &&
                        "text-muted-foreground line-through dark:text-muted-foreground-night",
                      change.kind === "added" &&
                        "text-green-700 dark:text-green-400"
                    )}
                  >
                    {change.label}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
