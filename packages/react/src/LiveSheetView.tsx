import type { HocuspocusProvider } from "@hocuspocus/provider";
import type {
  CellFormat,
  CellValue,
  PendingSheetSuggestion,
  SheetGrid,
} from "@memo-air/sheet";
import {
  acceptSheetSuggestion,
  addRows,
  cellFormats,
  cellKey,
  columnLetter,
  deleteRows,
  evaluate,
  formatColumns,
  formatValue,
  literalValue,
  parseRange,
  pendingSheetSuggestions,
  readGrid,
  rejectSheetSuggestion,
  setRange,
  sheetCells,
  sheetCols,
  sheetColumns,
  sheetRows,
  sheetSuggestions,
} from "@memo-air/sheet";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { AgentReadingMarks, agentMark } from "./AgentCursors";
import { useLiveHost } from "./host";
import { LiveDocHistory } from "./LiveDocHistory";
import type { LiveDocViewProps } from "./liveViewShared";
import { LiveBadge, PresenceStack } from "./liveViewShared";
import {
  Button,
  cn,
  DotsHorizontal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "./ui";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";
import { colorForId, useLiveDocSession } from "./useLiveDocSession";

const agentAnnouncementIntervalMs = 10_000;
const compactWidthPx = 640;
const defaultColumnWidthPx = 120;
const rowHeaderWidthPx = 44;
const minShownRows = 20;
const minShownCols = 6;

type CellPosition = { row: number; col: number };
type RowSuggestion = {
  suggestion: PendingSheetSuggestion;
  kind: "insert" | "delete";
};
type Editing = { draft: string; where: "cell" | "bar" };

const formatLabels: Record<CellFormat, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  date: "Date",
};

const a1 = ({ row, col }: CellPosition) => `${columnLetter(col)}${row + 1}`;

function proposedLabel(input: string, format?: CellFormat): string {
  return input.startsWith("=")
    ? input
    : formatValue(literalValue(input), format);
}

function isNumber(value: CellValue | undefined): boolean {
  return typeof value === "number";
}

interface SuggestionCardProps {
  suggestion: PendingSheetSuggestion;
  isActive: boolean;
  canReview: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onReject: () => void;
}

function SuggestionCard({
  suggestion,
  isActive,
  canReview,
  onSelect,
  onAccept,
  onReject,
}: SuggestionCardProps) {
  const changes = Object.entries(suggestion.cells);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSelect();
        }
      }}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs",
        isActive
          ? "border-highlight-300 bg-highlight-50 dark:border-highlight-700 dark:bg-highlight-900"
          : "border-border bg-background dark:border-border-night dark:bg-background-night"
      )}
    >
      <div className="font-medium text-foreground dark:text-foreground-night">
        ✦ {suggestion.actorName} suggests
        {suggestion.approver && (
          <span className="font-normal text-muted-foreground dark:text-muted-foreground-night">
            {" "}
            · needs {suggestion.approver}
          </span>
        )}
      </div>
      {suggestion.cellRefs.slice(0, 4).map((ref, i) => {
        const [key, after] = changes[i] ?? ["", ""];
        const before = suggestion.before[key] ?? "";
        return (
          <div key={ref} className="flex items-baseline gap-1.5">
            <span className="font-mono text-muted-foreground dark:text-muted-foreground-night">
              {ref}
            </span>
            {before && (
              <span className="text-muted-foreground line-through dark:text-muted-foreground-night">
                {before}
              </span>
            )}
            <span className="text-green-700 dark:text-green-400">
              {after || "(cleared)"}
            </span>
          </div>
        );
      })}
      {changes.length > 4 && (
        <div className="text-muted-foreground dark:text-muted-foreground-night">
          and {changes.length - 4} more cells
        </div>
      )}
      {suggestion.deleteRowIds.length > 0 && (
        <div className="text-muted-foreground dark:text-muted-foreground-night">
          Remove {suggestion.deleteRowIds.length} row(s)
        </div>
      )}
      {suggestion.stale && (
        <div className="text-warning-600 dark:text-warning-400">
          These cells changed since the suggestion was made.
        </div>
      )}
      {canReview && (
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="primary"
            label="Accept"
            tooltip="Accept (⌥↵)"
            onClick={(event) => {
              event.stopPropagation();
              onAccept();
            }}
          />
          <Button
            size="xs"
            variant="outline"
            label="Reject"
            tooltip="Reject (⌥⌫)"
            onClick={(event) => {
              event.stopPropagation();
              onReject();
            }}
          />
        </div>
      )}
    </div>
  );
}

type LiveSheetState = {
  grid: SheetGrid;
  suggestions: PendingSheetSuggestion[];
};

const emptySheet: LiveSheetState = {
  grid: { rowIds: [], colIds: [], inputs: [], columns: [] },
  suggestions: [],
};

// The grid and its pending suggestions, kept current as the Y.Doc changes.
function useSheet(session: LiveDocSession | null) {
  const [sheet, setSheet] = useState<LiveSheetState>(emptySheet);
  useEffect(() => {
    if (!session) {
      return;
    }
    const { ydoc } = session;
    const types = [
      sheetRows(ydoc),
      sheetCols(ydoc),
      sheetCells(ydoc),
      sheetColumns(ydoc),
      sheetSuggestions(ydoc),
    ];
    const onChange = () =>
      setSheet({
        grid: readGrid(ydoc),
        suggestions: pendingSheetSuggestions(ydoc),
      });
    onChange();
    for (const type of types) {
      type.observe(onChange);
    }
    return () => {
      for (const type of types) {
        type.unobserve(onChange);
      }
      setSheet(emptySheet);
    };
  }, [session]);
  return sheet;
}

interface LiveSheetGridProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  sheet: LiveSheetState;
  peers: LivePeer[];
  canEdit: boolean;
  selected: CellPosition;
  onSelect: (position: CellPosition) => void;
  user: { id: string; name: string; color: string };
}

function LiveSheetGrid({
  ydoc,
  provider,
  sheet,
  peers,
  canEdit,
  selected,
  onSelect,
  user,
}: LiveSheetGridProps) {
  const { grid, suggestions } = sheet;
  const values = useMemo(() => evaluate(grid.inputs), [grid]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cellEditorRef = useRef<HTMLInputElement>(null);
  const writeAs = useMemo(
    () => ({
      actor: { kind: "human" as const, id: user.id, name: user.name },
    }),
    [user.id, user.name]
  );
  const isEditingCell = editing?.where === "cell";

  // The cell editor opens on a keystroke and takes focus with the caret after what was typed.
  useEffect(() => {
    const input = cellEditorRef.current;
    if (isEditingCell && input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [isEditingCell]);

  const rowsShown = Math.max(grid.rowIds.length + 3, minShownRows);
  const colsShown = Math.max(grid.colIds.length + 1, minShownCols);
  const inputAt = ({ row, col }: CellPosition) => grid.inputs[row]?.[col] ?? "";
  const selectedKey =
    grid.rowIds[selected.row] && grid.colIds[selected.col]
      ? cellKey(grid.rowIds[selected.row], grid.colIds[selected.col])
      : null;

  const suggestedCells = useMemo(
    () =>
      new Map(
        suggestions.flatMap((suggestion) =>
          Object.entries(suggestion.cells).map(([key, after]) => [
            key,
            { suggestion, after },
          ])
        )
      ),
    [suggestions]
  );
  const suggestedRows = useMemo(
    () =>
      new Map<string, RowSuggestion>(
        suggestions.flatMap((suggestion) => [
          ...suggestion.insertRowIds.map((id): [string, RowSuggestion] => [
            id,
            { suggestion, kind: "insert" },
          ]),
          ...suggestion.deleteRowIds.map((id): [string, RowSuggestion] => [
            id,
            { suggestion, kind: "delete" },
          ]),
        ])
      ),
    [suggestions]
  );
  const peerCells = useMemo(
    () =>
      new Map(
        peers.flatMap((peer) =>
          peer.cell ? [[cellKey(peer.cell.rowId, peer.cell.colId), peer]] : []
        )
      ),
    [peers]
  );

  useEffect(() => {
    provider.setAwarenessField("user", {
      id: user.id,
      name: user.name,
      color: user.color,
      kind: "human",
    });
  }, [provider, user]);

  useEffect(() => {
    const rowId = grid.rowIds[selected.row];
    const colId = grid.colIds[selected.col];
    provider.setAwarenessField(
      "cell",
      rowId && colId ? { rowId, colId } : null
    );
  }, [provider, grid, selected]);

  const move = (rowDelta: number, colDelta: number) =>
    onSelect({
      row: Math.min(Math.max(selected.row + rowDelta, 0), rowsShown - 1),
      col: Math.min(Math.max(selected.col + colDelta, 0), colsShown - 1),
    });

  const commit = (draft: string) => {
    setEditing(null);
    if (canEdit && draft !== inputAt(selected)) {
      setRange(ydoc, a1(selected), [[draft]], writeAs);
    }
    gridRef.current?.focus();
  };

  const settleSelected = (accept: boolean) => {
    const pending = selectedKey ? suggestedCells.get(selectedKey) : undefined;
    const rowPending = suggestedRows.get(grid.rowIds[selected.row] ?? "");
    const suggestion = pending?.suggestion ?? rowPending?.suggestion;
    if (!suggestion) {
      return;
    }
    if (accept) {
      acceptSheetSuggestion(ydoc, suggestion.id, writeAs.actor);
    } else {
      rejectSheetSuggestion(ydoc, suggestion.id);
    }
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!editing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(editing.draft);
      move(1, 0);
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit(editing.draft);
      move(0, event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      setEditing(null);
      gridRef.current?.focus();
    }
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) {
      return;
    }
    // Shortcuts from the spec: ⌥↵ accepts, ⌥⌫ rejects the suggestion under the selection.
    if (event.altKey && (event.key === "Enter" || event.key === "Backspace")) {
      event.preventDefault();
      if (canEdit) {
        settleSelected(event.key === "Enter");
      }
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const arrow = arrows[event.key];
    if (arrow) {
      event.preventDefault();
      move(arrow[0], arrow[1]);
    } else if (event.key === "Tab") {
      event.preventDefault();
      move(0, event.shiftKey ? -1 : 1);
    } else if (!canEdit) {
      return;
    } else if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      setEditing({ draft: inputAt(selected), where: "cell" });
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (inputAt(selected) !== "") {
        setRange(ydoc, a1(selected), [[""]], writeAs);
      }
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setEditing({ draft: event.key, where: "cell" });
    }
  };

  const editorClass =
    "w-full bg-transparent px-1.5 text-sm text-foreground outline-none dark:text-foreground-night";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 dark:border-border-night">
        <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground dark:text-muted-foreground-night">
          {a1(selected)}
        </span>
        <input
          aria-label="Cell contents"
          className={cn(
            editorClass,
            "rounded border border-border py-0.5 font-mono dark:border-border-night"
          )}
          readOnly={!canEdit}
          value={editing ? editing.draft : inputAt(selected)}
          onFocus={() => {
            if (canEdit && !editing) {
              setEditing({ draft: inputAt(selected), where: "bar" });
            }
          }}
          onChange={(event) =>
            setEditing({ draft: event.target.value, where: "bar" })
          }
          onBlur={() => {
            if (editing?.where === "bar") {
              commit(editing.draft);
            }
          }}
          onKeyDown={onEditorKeyDown}
        />
      </div>
      <div
        ref={gridRef}
        role="grid"
        aria-label="Live sheet"
        aria-rowcount={rowsShown}
        aria-colcount={colsShown}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus:outline-none"
        onKeyDown={onGridKeyDown}
        onCopy={(event) => {
          if (!editing) {
            event.preventDefault();
            event.clipboardData.setData("text/plain", inputAt(selected));
          }
        }}
        onPaste={(event) => {
          if (editing || !canEdit) {
            return;
          }
          event.preventDefault();
          const rows = event.clipboardData
            .getData("text/plain")
            .replace(/\r?\n$/, "")
            .split(/\r?\n/)
            .map((line) => line.split("\t"));
          setRange(ydoc, a1(selected), rows, writeAs);
        }}
      >
        <table
          className="table-fixed border-separate border-spacing-0 text-sm"
          style={{
            width:
              rowHeaderWidthPx +
              Array.from(
                { length: colsShown },
                (_, c) => grid.columns[c]?.width ?? defaultColumnWidthPx
              ).reduce((sum, width) => sum + width, 0),
          }}
        >
          <colgroup>
            <col style={{ width: rowHeaderWidthPx }} />
            {Array.from({ length: colsShown }, (_, c) => (
              <col
                key={c}
                style={{
                  width: grid.columns[c]?.width ?? defaultColumnWidthPx,
                }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-r border-border bg-muted-background dark:border-border-night dark:bg-muted-background-night" />
              {Array.from({ length: colsShown }, (_, c) => (
                <th
                  key={c}
                  className="border-b border-r border-border bg-muted-background p-0 text-xs font-medium text-muted-foreground dark:border-border-night dark:bg-muted-background-night dark:text-muted-foreground-night"
                >
                  {canEdit ? (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button type="button" className="w-full py-1">
                          {columnLetter(c)}
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {cellFormats.map((format) => (
                          <DropdownMenuItem
                            key={format}
                            label={`Format as ${formatLabels[format].toLowerCase()}`}
                            onClick={() =>
                              formatColumns(ydoc, columnLetter(c), { format })
                            }
                          />
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <div className="py-1">{columnLetter(c)}</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowsShown }, (_, r) => {
              const rowId = grid.rowIds[r];
              const rowSuggestion = rowId
                ? suggestedRows.get(rowId)
                : undefined;
              return (
                <tr
                  key={rowId ?? `pad-${r}`}
                  className={cn(
                    rowSuggestion?.kind === "insert" &&
                      "bg-green-50 dark:bg-green-950",
                    rowSuggestion?.kind === "delete" &&
                      "text-muted-foreground line-through dark:text-muted-foreground-night"
                  )}
                >
                  <th className="border-b border-r border-border bg-muted-background p-0 text-xs font-normal text-muted-foreground dark:border-border-night dark:bg-muted-background-night dark:text-muted-foreground-night">
                    {canEdit && rowId ? (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className="w-full py-1">
                            {r + 1}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            label="Insert row above"
                            onClick={() => addRows(ydoc, r, [[""]], writeAs)}
                          />
                          <DropdownMenuItem
                            label="Insert row below"
                            onClick={() =>
                              addRows(ydoc, r + 1, [[""]], writeAs)
                            }
                          />
                          <DropdownMenuItem
                            label="Delete row"
                            onClick={() => deleteRows(ydoc, r + 1, r + 1)}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <div className="py-1">{r + 1}</div>
                    )}
                  </th>
                  {Array.from({ length: colsShown }, (_, c) => {
                    const colId = grid.colIds[c];
                    const key = rowId && colId ? cellKey(rowId, colId) : null;
                    const isSelected = selected.row === r && selected.col === c;
                    const peer = key ? peerCells.get(key) : undefined;
                    const pending = key ? suggestedCells.get(key) : undefined;
                    const format = grid.columns[c]?.format;
                    const value = values[r]?.[c];
                    return (
                      <td
                        key={c}
                        role="gridcell"
                        aria-selected={isSelected}
                        data-cell={key ?? undefined}
                        onClick={() => {
                          onSelect({ row: r, col: c });
                          gridRef.current?.focus();
                        }}
                        onDoubleClick={() => {
                          if (canEdit) {
                            onSelect({ row: r, col: c });
                            setEditing({
                              draft: inputAt({ row: r, col: c }),
                              where: "cell",
                            });
                          }
                        }}
                        className={cn(
                          "relative h-7 max-w-0 border-b border-r border-border px-0 dark:border-border-night",
                          isSelected &&
                            "outline outline-2 -outline-offset-2 outline-blue-600"
                        )}
                        style={
                          peer && !isSelected
                            ? { boxShadow: `inset 0 0 0 2px ${peer.color}` }
                            : undefined
                        }
                      >
                        {isSelected && editing?.where === "cell" ? (
                          <input
                            ref={cellEditorRef}
                            aria-label={`Edit ${a1(selected)}`}
                            className={cn(editorClass, "h-full")}
                            value={editing.draft}
                            onChange={(event) =>
                              setEditing({
                                draft: event.target.value,
                                where: "cell",
                              })
                            }
                            onBlur={() => commit(editing.draft)}
                            onKeyDown={onEditorKeyDown}
                          />
                        ) : (
                          <div
                            className={cn(
                              "truncate px-1.5 text-foreground dark:text-foreground-night",
                              isNumber(value) && !pending && "text-right",
                              typeof value === "object" &&
                                value !== null &&
                                "text-warning-600 dark:text-warning-400"
                            )}
                          >
                            {pending ? (
                              <>
                                <span className="text-muted-foreground line-through dark:text-muted-foreground-night">
                                  {formatValue(value ?? null, format)}
                                </span>{" "}
                                <span className="underline decoration-green-600 decoration-2">
                                  {proposedLabel(pending.after, format)}
                                </span>
                              </>
                            ) : (
                              formatValue(value ?? null, format)
                            )}
                          </div>
                        )}
                        {peer && (
                          <span
                            className={cn(
                              "pointer-events-none absolute right-0 z-10 whitespace-nowrap rounded px-1 text-[10px] font-medium text-white",
                              r === 0 ? "-bottom-4" : "-top-4"
                            )}
                            style={{ backgroundColor: peer.color }}
                            {...(peer.kind === "agent"
                              ? agentMark({
                                  name: peer.name,
                                  color: peer.color,
                                  action: "editing",
                                })
                              : {})}
                          >
                            {peer.kind === "agent"
                              ? `✦ ${peer.name}`
                              : peer.userId === user.id
                                ? "You (other tab)"
                                : peer.name}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The live sheet: grid, suggestion cards, history and sharing, in the same panel as a live doc.
export function LiveSheetView({
  docId,
  renderHeader,
  className,
}: LiveDocViewProps) {
  const host = useLiveHost();
  const user = host.useUser();
  const { connection, isLiveDocLoading, isLiveDocError } = host.useConnection({
    docId,
  });
  const fetchToken = host.useFetchToken(docId);
  const { session, isConnected, hasSynced, peers } = useLiveDocSession({
    url: connection?.url,
    docId,
    fetchToken,
  });
  const sheet = useSheet(session);
  const downloadXlsx = host.useDownloadFile({
    docId,
    format: "xlsx",
  });
  const [showHistory, setShowHistory] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [selected, setSelected] = useState<CellPosition>({ row: 0, col: 0 });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isCompact, setIsCompact] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncedAtRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const canEdit = connection?.access === "write";
  const title = connection?.liveDoc.title ?? "Live sheet";
  const { suggestions } = sheet;
  const localUser = useMemo(
    () =>
      user
        ? { id: user.id, name: user.name, color: colorForId(user.id) }
        : null,
    [user]
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setIsCompact(entry.contentRect.width < compactWidthPx)
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const editingAgent = peers.find((peer) => peer.kind === "agent" && peer.cell);
  const editingAgentName = editingAgent?.name ?? "";

  useEffect(() => {
    const now = Date.now();
    if (
      !editingAgentName ||
      now - lastAnnouncedAtRef.current < agentAnnouncementIntervalMs
    ) {
      return;
    }
    lastAnnouncedAtRef.current = now;
    setAnnouncement(`${editingAgentName} editing the sheet`);
  }, [editingAgentName]);

  const selectSuggestion = (suggestion: PendingSheetSuggestion) => {
    setActiveId(suggestion.id);
    const range = suggestion.cellRefs[0]
      ? parseRange(suggestion.cellRefs[0])
      : null;
    if (range) {
      setSelected({ row: range.top, col: range.left });
    }
  };

  const reviewNext = () => {
    if (suggestions.length === 0) {
      return;
    }
    const at = suggestions.findIndex((s) => s.id === activeId);
    selectSuggestion(suggestions[(at + 1) % suggestions.length]);
  };

  const actions = (
    <div className="flex items-center gap-2 pr-1">
      <LiveBadge
        label={
          !hasSynced ? "Connecting…" : isConnected ? "● Live" : "Reconnecting…"
        }
        live={isConnected && hasSynced}
      />
      <AgentReadingMarks peers={peers} />
      <PresenceStack peers={peers} />
      {suggestions.length > 0 && (
        <Button
          size="xs"
          variant="outline"
          label={`Review ${suggestions.length}`}
          tooltip="Go to the next suggestion"
          onClick={() => {
            setShowHistory(false);
            reviewNext();
          }}
        />
      )}
      {session && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              icon={DotsHorizontal}
              aria-label="More"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              label={showHistory ? "Back to the sheet" : "History"}
              onClick={() => setShowHistory((shown) => !shown)}
            />
            {connection?.canShare && host.renderShare && (
              <DropdownMenuItem
                label="Share"
                onClick={() => setShowShare(true)}
              />
            )}
            <DropdownMenuItem
              label="Export as Excel"
              onClick={() => void downloadXlsx(title)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  const cards = suggestions.map((suggestion) => (
    <SuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      isActive={suggestion.id === activeId}
      canReview={canEdit}
      onSelect={() => selectSuggestion(suggestion)}
      onAccept={() =>
        session &&
        acceptSheetSuggestion(session.ydoc, suggestion.id, {
          kind: "human",
          id: localUser?.id ?? "",
          name: localUser?.name ?? "",
        })
      }
      onReject={() =>
        session && rejectSheetSuggestion(session.ydoc, suggestion.id)
      }
    />
  ));

  return (
    <div ref={rootRef} className={cn("flex min-h-0 flex-col", className)}>
      {renderHeader({ title, liveDoc: connection?.liveDoc ?? null, actions })}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {(isLiveDocLoading || (session && !hasSynced)) && (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      )}
      {isLiveDocError && (
        <div className="p-6 text-sm text-muted-foreground">
          This live sheet is not available to you.
        </div>
      )}
      {session && connection && hasSynced && localUser && (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {showHistory && (
            <LiveDocHistory
              docId={docId}
              canWrite={canEdit}
              onClose={() => setShowHistory(false)}
            />
          )}
          <div
            className={cn(
              "flex min-h-0 flex-1",
              isCompact ? "flex-col" : "flex-row",
              showHistory && "hidden"
            )}
          >
            {isCompact && cards.length > 0 && (
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto border-b border-border p-2 dark:border-border-night">
                {cards}
              </div>
            )}
            <LiveSheetGrid
              ydoc={session.ydoc}
              provider={session.provider}
              sheet={sheet}
              peers={peers}
              canEdit={canEdit}
              selected={selected}
              onSelect={setSelected}
              user={localUser}
            />
            {!isCompact && cards.length > 0 && (
              <div className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-l border-border p-2 dark:border-border-night">
                {cards}
              </div>
            )}
          </div>
          {editingAgent?.cell && !showHistory && (
            <Button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
              size="sm"
              variant="outline"
              label={`✦ ${editingAgent.name} editing ↓`}
              onClick={() =>
                document
                  .querySelector(
                    `[data-cell="${CSS.escape(
                      cellKey(
                        editingAgent.cell?.rowId ?? "",
                        editingAgent.cell?.colId ?? ""
                      )
                    )}"]`
                  )
                  ?.scrollIntoView({ block: "center", behavior: "smooth" })
              }
            />
          )}
        </div>
      )}
      {host.renderShare?.({
        docId,
        title,
        isOpen: showShare,
        onClose: () => setShowShare(false),
      })}
    </div>
  );
}
