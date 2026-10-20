import type { LiveDocKind } from "@memo-air/protocol";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveDockItem } from "./host";
import { liveDocIcon } from "./liveViewShared";
import { cn, Icon, Maximize, Minus, Trash03, XClose } from "./ui";

// The pieces that draw a space as a desktop: a wallpaper, traffic-light title bars, a dock of
// launchers and minimized windows, and closed windows left as icons. Every state they show is
// the channel's (the space doc), so a person or an agent changing it changes it for the room.

export function desktopWallpaper(isDark: boolean): CSSProperties {
  return isDark
    ? {
        background:
          "radial-gradient(at 18% 12%, #26304f 0, transparent 55%), radial-gradient(at 85% 18%, #36284f 0, transparent 50%), radial-gradient(at 72% 88%, #3d2b2a 0, transparent 55%), radial-gradient(at 12% 92%, #1c3934 0, transparent 50%), #14161c",
      }
    : {
        background:
          "radial-gradient(at 18% 12%, #d7e4ff 0, transparent 55%), radial-gradient(at 85% 18%, #efdcff 0, transparent 50%), radial-gradient(at 72% 88%, #ffe1d2 0, transparent 55%), radial-gradient(at 12% 92%, #d3f1e7 0, transparent 50%), #eef1f7",
      };
}

const tileColors: Partial<Record<LiveDocKind, { bg: string; fg: string }>> = {
  doc: { bg: "#dbe7ff", fg: "#2563eb" },
  sheet: { bg: "#d8f5e1", fg: "#15803d" },
  canvas: { bg: "#fbefc6", fg: "#a16207" },
  slides: { bg: "#ffe2d1", fg: "#c2410c" },
  browser: { bg: "#d6efff", fg: "#0369a1" },
  media: { bg: "#fbe0ee", fg: "#be185d" },
  desktop: { bg: "#e4e4ee", fg: "#4338ca" },
  file: { bg: "#ece6ff", fg: "#6d28d9" },
  runner: { bg: "#d5f2ee", fg: "#0f766e" },
};
const fallbackTile = { bg: "#e7e5e4", fg: "#44403c" };

export const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A glassy launcher tile: the kind's tint lit from above, a gloss on its top half, a white rim.
function KindTile({
  kind,
  size,
}: {
  kind: LiveDocKind | undefined;
  size: "dock" | "icon";
}) {
  const { bg, fg } = (kind && tileColors[kind]) ?? fallbackTile;
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-white/70 dark:ring-white/25",
        size === "dock"
          ? "h-(--dock-tile) w-(--dock-tile) rounded-xl"
          : "h-14 w-14 rounded-2xl"
      )}
      style={{
        color: fg,
        background: `linear-gradient(180deg, color-mix(in srgb, ${bg} 40%, white) 0%, ${bg} 55%, color-mix(in srgb, ${bg} 82%, ${fg}) 100%)`,
        boxShadow:
          "inset 0 1px 0 rgb(255 255 255 / 0.95), inset 0 -1px 2px rgb(0 0 0 / 0.08), 0 1px 2px rgb(0 0 0 / 0.08), 0 6px 14px -4px rgb(0 0 0 / 0.25)",
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/70 to-white/0"
      />
      <Icon
        visual={liveDocIcon(kind)}
        size="md"
        className={cn(
          "relative drop-shadow-[0_1px_0_rgb(255_255_255/0.7)]",
          size === "dock" &&
            "h-[calc(var(--dock-tile)*5/11)] w-[calc(var(--dock-tile)*5/11)]"
        )}
      />
    </span>
  );
}

// A minimized window in the dock: a small window of its own, title bar and all.
function WindowThumb({
  kind,
  title,
}: {
  kind: LiveDocKind | undefined;
  title: string;
}) {
  const { fg } = (kind && tileColors[kind]) ?? fallbackTile;
  return (
    <span className="flex h-(--dock-tile) w-[calc(var(--dock-tile)*14/11)] flex-col overflow-hidden rounded-md bg-white shadow-[0_6px_14px_-4px_rgb(0_0_0/0.3)] ring-1 ring-black/10 dark:bg-stone-800 dark:ring-white/15">
      <span className="flex h-2.5 shrink-0 items-center gap-[2px] bg-stone-100 px-1 dark:bg-stone-700">
        <span className="h-[3px] w-[3px] rounded-full bg-[#ff5f57]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[#febc2e]" />
        <span className="h-[3px] w-[3px] rounded-full bg-[#28c840]" />
      </span>
      <span
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-0.5 px-1"
        style={{ color: fg }}
      >
        <Icon visual={liveDocIcon(kind)} size="xs" />
        <span className="w-full truncate text-center text-[7px] leading-tight text-stone-600 dark:text-stone-300">
          {title}
        </span>
      </span>
    </span>
  );
}

// The window flies to (or from) where it goes: its dock thumbnail or desktop icon when that is
// drawn, else the dock or the desktop. The board is scaled, so screen distances are divided out.
// ponytail: a scale-and-slide, not the genie warp; a warp needs a WebGL mesh.
export function flyWindow(
  element: HTMLElement,
  target: Element | null,
  direction: "in" | "out",
  boardScale: number
): Animation | null {
  if (!target || reducedMotion()) {
    return null;
  }
  const from = element.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const dx =
    (to.left + to.width / 2 - (from.left + from.width / 2)) / boardScale;
  const dy =
    (to.top + to.height / 2 - (from.top + from.height / 2)) / boardScale;
  const away = {
    transform: `translate(${dx}px, ${dy}px) scale(0.06)`,
    opacity: 0,
  };
  const home = { transform: "translate(0, 0) scale(1)", opacity: 1 };
  return direction === "out"
    ? element.animate([home, away], {
        duration: 320,
        easing: "cubic-bezier(0.55, 0, 0.75, 0.2)",
        fill: "forwards",
      })
    : element.animate([away, home], {
        duration: 300,
        easing: "cubic-bezier(0.2, 0.9, 0.3, 1.08)",
        fill: "backwards",
      });
}

export function popIn(element: HTMLElement | null) {
  if (element && !reducedMotion()) {
    element.animate(
      [
        { transform: "scale(0.94)", opacity: 0 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" }
    );
  }
}

const lightClass =
  "flex h-3 w-3 items-center justify-center rounded-full text-black/60 ring-1 ring-black/10 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight";

export function TrafficLights({
  title,
  isMaximized,
  isActive,
  disabled,
  onClose,
  onMinimize,
  onMaximize,
}: {
  title: string;
  isMaximized: boolean;
  // Only the window being worked in shows its colours; the rest stay grey until hovered.
  isActive: boolean;
  disabled: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
}) {
  return (
    <div
      className="group/lights flex shrink-0 items-center gap-2"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={cn(
          lightClass,
          isActive
            ? "bg-[#ff5f57]"
            : "bg-stone-300 group-hover/lights:bg-[#ff5f57] dark:bg-stone-600"
        )}
        aria-label={`Close ${title} to the desktop`}
        title="Close to the desktop"
        disabled={disabled}
        onClick={onClose}
      >
        <XClose className="h-2 w-2 opacity-0 group-hover/lights:opacity-100" />
      </button>
      <button
        type="button"
        className={cn(
          lightClass,
          isActive
            ? "bg-[#febc2e]"
            : "bg-stone-300 group-hover/lights:bg-[#febc2e] dark:bg-stone-600"
        )}
        aria-label={`Minimize ${title} to the dock`}
        title="Minimize to the dock"
        disabled={disabled}
        onClick={onMinimize}
      >
        <Minus className="h-2 w-2 opacity-0 group-hover/lights:opacity-100" />
      </button>
      <button
        type="button"
        className={cn(
          lightClass,
          isActive
            ? "bg-[#28c840]"
            : "bg-stone-300 group-hover/lights:bg-[#28c840] dark:bg-stone-600"
        )}
        aria-label={isMaximized ? `Restore ${title}` : `Maximize ${title}`}
        title={isMaximized ? "Restore" : "Maximize"}
        disabled={disabled}
        onClick={onMaximize}
      >
        <Maximize className="h-2 w-2 opacity-0 group-hover/lights:opacity-100" />
      </button>
    </div>
  );
}

const dockTilePx = 44;
const dockThumbPx = 56;
const dockGapPx = 8;
const dockSeparatorPx = 5;
const dockChromePx = 22;
const dockMarginPx = 24;
const dockMinRatio = 0.4;

function DockButton({
  dockKey,
  label,
  onClick,
  children,
}: {
  dockKey: string;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-dock-key={dockKey}
      className="group/dock relative flex shrink-0 rounded-xl focus-visible:outline-none"
      onClick={onClick}
    >
      <span className="flex origin-bottom rounded-xl transition-transform duration-300 group-focus-visible/dock:ring-2 group-focus-visible/dock:ring-highlight ease-[cubic-bezier(0.34,1.56,0.64,1)] will-change-transform group-hover/dock:-translate-y-1.5 group-hover/dock:scale-[1.22] group-focus-visible/dock:-translate-y-1.5 group-focus-visible/dock:scale-[1.22] group-active/dock:scale-110 motion-reduce:transition-none">
        {children}
      </span>
      <span className="pointer-events-none absolute bottom-full left-1/2 mb-4 -translate-x-1/2 translate-y-1 scale-95 whitespace-nowrap rounded-md bg-stone-900/90 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-[opacity,translate,scale] duration-200 ease-out group-hover/dock:translate-y-0 group-hover/dock:scale-100 group-hover/dock:opacity-100 group-focus-visible/dock:translate-y-0 group-focus-visible/dock:scale-100 group-focus-visible/dock:opacity-100 motion-reduce:transition-none">
        {label}
      </span>
    </button>
  );
}

type DockWindow = { id: string; title: string; kind: LiveDocKind | undefined };

export type BinProps = {
  items: DockWindow[];
  canDelete: boolean;
  onBin: (id: string) => void;
  onPutBack: (id: string) => void;
  onDelete: (ids: string[]) => Promise<void>;
};

// A desktop icon dragged onto the bin carries its window id under this type.
const binDragType = "application/x-airlink-window";

// The bin, as on a Mac: drop a closed window's icon on it (or press Delete on the icon) and it
// leaves the desktop but can still be put back; only Delete or Empty bin ends it, after asking.
function BinTile({ items, canDelete, onBin, onPutBack, onDelete }: BinProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isOver, setIsOver] = useState(false);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setIsOpen(false);
        setConfirming(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen]);

  const confirmed = confirming
    ? items.filter((item) => confirming.includes(item.id))
    : [];

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(binDragType)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setIsOver(true);
        }
      }}
      onDragLeave={() => setIsOver(false)}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(binDragType);
        setIsOver(false);
        if (id) {
          event.preventDefault();
          onBin(id);
        }
      }}
    >
      <DockButton
        dockKey="bin"
        label={items.length > 0 ? `Bin · ${items.length}` : "Bin"}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span
          className={cn(
            "relative flex h-(--dock-tile) w-(--dock-tile) items-center justify-center rounded-xl bg-linear-to-b from-white/90 to-stone-200/80 text-stone-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.95),0_6px_14px_-4px_rgb(0_0_0/0.25)] ring-1 ring-white/70 transition-transform duration-150 dark:from-stone-600/80 dark:to-stone-800/80 dark:text-stone-200 dark:ring-white/20",
            isOver && "scale-110 ring-2 ring-warning-500"
          )}
        >
          <Trash03 className="h-[calc(var(--dock-tile)*5/11)] w-[calc(var(--dock-tile)*5/11)]" />
          {items.length > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-stone-800 px-1 text-[10px] font-semibold text-white dark:bg-stone-100 dark:text-stone-900">
              {items.length}
            </span>
          )}
        </span>
      </DockButton>
      {isOpen && (
        <div
          role="dialog"
          aria-label="Bin"
          className="absolute right-0 bottom-full mb-4 flex w-80 flex-col overflow-hidden rounded-2xl border border-white/60 bg-white/85 text-stone-900 shadow-2xl backdrop-blur-2xl dark:border-white/15 dark:bg-stone-900/85 dark:text-stone-100"
        >
          <div className="flex items-center justify-between border-b border-black/5 px-4 py-2.5 dark:border-white/10">
            <span className="text-sm font-semibold">Bin</span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              {items.length === 0
                ? "Empty"
                : `${items.length} ${items.length === 1 ? "item" : "items"}`}
            </span>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-5 text-sm text-stone-500 dark:text-stone-400">
              Drag a desktop icon here to move it to the bin. Closing a window
              never deletes it.
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col overflow-y-auto py-1">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-2 px-3 py-1.5"
                >
                  <Icon
                    visual={liveDocIcon(item.kind)}
                    size="sm"
                    className="text-stone-500"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.title}
                  </span>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-medium hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight dark:hover:bg-white/10"
                    onClick={() => onPutBack(item.id)}
                  >
                    Put back
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs font-medium text-warning-600 hover:bg-warning-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
                      onClick={() => setConfirming([item.id])}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canDelete && items.length > 0 && (
            <div className="border-t border-black/5 px-3 py-2.5 dark:border-white/10">
              {confirming ? (
                <div className="flex flex-col gap-2">
                  <p className="text-xs">
                    Delete{" "}
                    {confirmed.length === 1
                      ? `“${confirmed[0]?.title}”`
                      : `${confirmed.length} items`}{" "}
                    for good? Everyone in the channel loses{" "}
                    {confirmed.length === 1 ? "it" : "them"}; this cannot be
                    undone.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md px-2.5 py-1 text-xs font-medium hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight dark:hover:bg-white/10"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isDeleting}
                      className="rounded-md bg-warning-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-warning-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight disabled:opacity-60"
                      onClick={() => {
                        setIsDeleting(true);
                        void onDelete(confirming).finally(() => {
                          setIsDeleting(false);
                          setConfirming(null);
                        });
                      }}
                    >
                      {isDeleting ? "Deleting…" : "Delete for good"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full rounded-md px-2.5 py-1.5 text-xs font-medium text-warning-600 hover:bg-warning-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
                  onClick={() => setConfirming(items.map((item) => item.id))}
                >
                  Empty bin
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Dock({
  items,
  minimized,
  onRestore,
  bin,
  children,
}: {
  items: LiveDockItem[];
  minimized: DockWindow[];
  onRestore: (id: string) => void;
  bin?: BinProps;
  children: ReactNode;
}) {
  const navRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const hasBin = bin !== undefined;

  // Past the space's width the tiles shrink, down to a floor, rather than push the dock (and the
  // zoom controls at its end) off screen. Gaps and the controls keep their size.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pane = nav?.parentElement;
    if (!nav || !pane) {
      return;
    }
    const fit = () => {
      const launchers = items.length + (hasBin ? 1 : 0);
      const separatorCount =
        (minimized.length > 0 ? 1 : 0) + (hasBin ? 1 : 0) + 1;
      const gaps = launchers + minimized.length + separatorCount;
      const separators = dockSeparatorPx * separatorCount;
      const room =
        pane.clientWidth -
        dockMarginPx -
        dockChromePx -
        separators -
        (controlsRef.current?.offsetWidth ?? 0);
      const natural =
        dockTilePx * launchers +
        dockThumbPx * minimized.length +
        dockGapPx * gaps;
      const ratio = Math.min(1, Math.max(dockMinRatio, room / natural));
      nav.style.setProperty("--dock-tile", `${dockTilePx * ratio}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [items.length, minimized.length, hasBin]);

  return (
    <nav
      ref={navRef}
      aria-label="Dock"
      data-desktop-target="dock"
      className="absolute bottom-3 left-1/2 z-[1030] flex max-w-[calc(100%-24px)] -translate-x-1/2 items-end gap-[calc(var(--dock-tile)*2/11)] [--dock-tile:44px] rounded-[22px] border border-white/60 bg-linear-to-b from-white/45 to-white/20 px-2.5 py-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.85),inset_0_-1px_0_rgb(255_255_255/0.25),0_2px_6px_rgb(0_0_0/0.06),0_18px_50px_-10px_rgb(0_0_0/0.35)] backdrop-blur-2xl backdrop-saturate-[1.8] dark:border-white/15 dark:from-white/12 dark:to-white/5 dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_18px_50px_-10px_rgb(0_0_0/0.7)]"
    >
      {items.map((item) => (
        <DockButton
          key={item.kind}
          dockKey={`new:${item.kind}`}
          label={`New ${item.label.toLowerCase()}`}
          onClick={item.onOpen}
        >
          <KindTile kind={item.kind} size="dock" />
        </DockButton>
      ))}
      {minimized.length > 0 && (
        <span className="mx-0.5 h-9 w-px shrink-0 self-center bg-black/15 dark:bg-white/15" />
      )}
      {minimized.map((window) => (
        <DockButton
          key={window.id}
          dockKey={`window:${window.id}`}
          label={window.title}
          onClick={() => onRestore(window.id)}
        >
          <WindowThumb kind={window.kind} title={window.title} />
        </DockButton>
      ))}
      {bin && (
        <>
          <span className="mx-0.5 h-9 w-px shrink-0 self-center bg-black/15 dark:bg-white/15" />
          <BinTile {...bin} />
        </>
      )}
      <span className="mx-0.5 h-9 w-px shrink-0 self-center bg-black/15 dark:bg-white/15" />
      <div ref={controlsRef} className="shrink-0 self-center">
        {children}
      </div>
    </nav>
  );
}

// ponytail: icons stack down the right edge in close order; let people drag them when a desktop
// holds more than a column.
export function DesktopIcons({
  closed,
  disabled,
  onOpen,
  onBin,
}: {
  closed: DockWindow[];
  disabled: boolean;
  onOpen: (id: string) => void;
  onBin: (id: string) => void;
}) {
  return (
    <ul
      aria-label="Closed windows"
      data-desktop-target="desktop"
      className="pointer-events-auto absolute top-3 right-3 flex max-h-[calc(100cqh-110px)] flex-col flex-wrap-reverse content-start gap-1"
    >
      {closed.map((window) => (
        <li key={window.id}>
          <button
            type="button"
            disabled={disabled}
            title={`Open ${window.title}`}
            aria-label={`Open ${window.title}`}
            data-desktop-icon={window.id}
            className="flex w-24 flex-col items-center gap-1 rounded-lg p-1.5 text-center hover:bg-black/5 focus-visible:bg-highlight/15 focus-visible:outline-none dark:hover:bg-white/10"
            draggable={!disabled}
            onDragStart={(event) => {
              event.dataTransfer.setData(binDragType, window.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDoubleClick={() => onOpen(window.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(window.id);
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                onBin(window.id);
              }
            }}
          >
            <KindTile kind={window.kind} size="icon" />
            <span className="line-clamp-2 rounded px-1 text-xs font-medium text-stone-900 [text-shadow:0_1px_2px_rgb(255_255_255/0.7)] dark:text-stone-100 dark:[text-shadow:0_1px_2px_rgb(0_0_0/0.7)]">
              {window.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
