import type {
  SpaceEditor,
  SpaceObjectView,
  WindowState,
} from "@memo-air/space";
import {
  binObject,
  bringToFront,
  forgetObject,
  moveObject,
  placedDocNames,
  placeObject,
  readBinned,
  readHidden,
  readSpace,
  removeObject,
  resizeObject,
  setWindowState,
  slotSize,
  spaceObjects,
} from "@memo-air/space";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Moveable from "react-moveable";
import {
  agentCursorColor,
  agentMark,
  CursorMark,
  InsideSpace,
  selfCursor,
} from "./AgentCursors";
import {
  DesktopIcons,
  Dock,
  desktopWallpaper,
  flyWindow,
  popIn,
  reducedMotion,
  TrafficLights,
} from "./Desktop";
import { useLiveHost } from "./host";
import type { LiveObjectContext } from "./LiveObjectFrame";
import { LiveObjectFrame } from "./LiveObjectFrame";
import type { LiveDocViewProps } from "./liveViewShared";
import { liveDocIcon } from "./liveViewShared";
import {
  Button,
  cn,
  Icon,
  LinkExternal01,
  Maximize,
  Minus,
  Plus,
  XClose,
} from "./ui";
import { colorForId } from "./useLiveDocSession";

const pointerIntervalMs = 50;
const snapThresholdPx = 8;
const nudgePx = 16;
const creationTileMs = 450;
const creationShownMs = 1400;
const followScanMs = 300;
// A person who touched the board in this window is busy; the view waits for them.
const followIdleMs = 5000;
const followMarginPx = 24;
const followDockMarginPx = 120;
const desktopOverscrollPx = 320;
const minScale = 0.2;
const maxScale = 2;
const zoomStep = 1.25;
const fitMarginPx = 24;
const dotGapPx = 20;
// A mouse wheel tick reports ~100 where a pinch reports a few; cap it so one tick is ~10%.
const wheelStepCap = 10;
const clampScale = (scale: number) =>
  Math.min(maxScale, Math.max(minScale, scale));
const minWindow = { w: 240, h: 160 };
const arrowDeltas: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// The space: every live object of the room as a window on one board, arranged the same way for
// everyone. People drag and resize through their own connection; agents place through
// `space-ops`. Each window is the object's own view with the window's title bar as its header.
interface LiveSpaceViewProps extends LiveDocViewProps {
  // The object view a window renders; passed in because that view also dispatches to this one.
  renderObject: (props: LiveDocViewProps) => ReactNode;
}

export function LiveSpaceView({ renderObject, ...props }: LiveSpaceViewProps) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <LiveObjectFrame
      {...props}
      kindLabel="space"
      showHistory={showHistory}
      onToggleHistory={setShowHistory}
    >
      {(context) => (
        <SpaceBoard
          agents={props.agents}
          context={context}
          renderObject={renderObject}
        />
      )}
    </LiveObjectFrame>
  );
}

interface SpaceBoardProps {
  agents: LiveDocViewProps["agents"];
  context: LiveObjectContext;
  renderObject: (props: LiveDocViewProps) => ReactNode;
}

function SpaceBoard({ agents, context, renderObject }: SpaceBoardProps) {
  const { session, peers, canEdit, user, liveDoc } = context;
  const host = useLiveHost();
  const openDoc = host.useOpenDoc();
  const { liveDocs } = host.useLiveDocs();
  const dock = host.useDock?.() ?? null;
  const uploadFiles = host.useUploadFiles?.() ?? null;
  const [isDropping, setIsDropping] = useState(false);
  const isDark = host.useIsDark();
  const [allObjects, setObjects] = useState<SpaceObjectView[]>(() =>
    readSpace(session.ydoc)
  );
  const [hidden, setHidden] = useState<SpaceObjectView[]>(() =>
    readHidden(session.ydoc)
  );
  const [binned, setBinned] = useState<SpaceObjectView[]>(() =>
    readBinned(session.ydoc)
  );
  const deleteObject = host.useDeleteObject?.() ?? null;
  // Closing hides the window at once; one nobody wrote in is then gone for good rather than
  // left behind as an empty icon.
  const closeObject = (object: SpaceObjectView) => {
    removeObject(session.ydoc, object.id, actor);
    void deleteObject?.(object.docName, { ifUntouched: true }).then(
      (deleted) => deleted && forgetObject(session.ydoc, object.id)
    );
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const moveableRef = useRef<Moveable>(null);
  const windowRefs = useRef(new Map<string, HTMLDivElement>());
  const handleRefs = useRef(new Map<string, HTMLDivElement>());
  const lastPointerAtRef = useRef(0);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  // The board point that stays under the given spot while the scale changes, applied once the
  // new scale has laid out.
  const anchorRef = useRef<{
    x: number;
    y: number;
    px: number;
    py: number;
  } | null>(null);
  const placedRef = useRef("");
  const actor = useMemo<SpaceEditor>(
    () => ({ kind: "human", id: user.id, name: user.name }),
    [user]
  );
  const kindsByDocName = useMemo(
    () => new Map(liveDocs.map((doc) => [doc.sId, doc.kind])),
    [liveDocs]
  );

  useEffect(() => {
    const map = spaceObjects(session.ydoc);
    const onChange = () => {
      setObjects(readSpace(session.ydoc));
      setHidden(readHidden(session.ydoc));
      setBinned(readBinned(session.ydoc));
    };
    map.observeDeep(onChange);
    return () => map.unobserveDeep(onChange);
  }, [session]);

  // Objects of this conversation that nobody placed yet (made before the space existed, or by a
  // person over the API) take the next free slots when a writer opens the space.
  useEffect(() => {
    if (!canEdit || !liveDoc.conversationId) {
      return;
    }
    const placed = placedDocNames(session.ydoc);
    const stragglers = liveDocs.filter(
      (doc) =>
        doc.conversationId === liveDoc.conversationId &&
        doc.kind !== "space" &&
        !placed.has(doc.sId)
    );
    const key = stragglers.map((doc) => doc.sId).join(",");
    if (!key || placedRef.current === key) {
      return;
    }
    placedRef.current = key;
    for (const doc of stragglers) {
      placeObject(
        session.ydoc,
        { docName: doc.sId, kind: doc.kind, title: doc.title },
        actor
      );
    }
  }, [canEdit, liveDoc.conversationId, liveDocs, session, actor]);

  // As a desktop, a minimized window sits in the dock and the front maximized one fills the
  // space; a plain board draws every window where it is.
  const objects = dock
    ? allObjects.filter((object) => object.state === "open")
    : allObjects;
  const maximized = dock
    ? (allObjects.filter((object) => object.state === "maximized").at(-1) ??
      null)
    : null;
  const docked = dock
    ? allObjects.filter(
        (object) => object.state !== "open" && object.id !== maximized?.id
      )
    : [];
  // A window that just left the board (minimized, closed) stays drawn while it flies to the dock
  // or its desktop icon; one that just came back flies out of them. Each viewer runs it on the
  // shared change, so the room sees the same motion whoever made it.
  const committedRef = useRef(new Map<string, SpaceObjectView>());
  const flyingRef = useRef(new Set<string>());
  const firstPaintRef = useRef(true);
  const lastMaximizedRef = useRef<string | null>(null);
  const [, setFlights] = useState(0);
  // An agent's new object: its cursor starts on the dock tile a person would have pressed, then
  // moves into the window as it opens, so everyone sees who made it and where it went.
  const [creations, setCreations] = useState<
    {
      id: string;
      title: string;
      name: string;
      at: { x: number; y: number } | null;
    }[]
  >([]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const startCreation = (object: SpaceObjectView, tile: Element | null) => {
    const wrapper = wrapperRef.current?.getBoundingClientRect();
    const from = tile?.getBoundingClientRect();
    setCreations((current) => [
      ...current.filter((each) => each.id !== object.id),
      {
        id: object.id,
        title: object.title,
        name: object.by.name,
        at:
          wrapper && from
            ? {
                x: from.left + from.width / 2 - wrapper.left,
                y: from.top + from.height / 2 - wrapper.top,
              }
            : null,
      },
    ]);
    setTimeout(
      () =>
        setCreations((current) =>
          current.map((each) =>
            each.id === object.id ? { ...each, at: null } : each
          )
        ),
      creationTileMs
    );
    setTimeout(
      () =>
        setCreations((current) =>
          current.filter((each) => each.id !== object.id)
        ),
      creationShownMs
    );
  };
  // Windows this person just opened — restored from the dock, reopened from the desktop, or new
  // from the dock — get scrolled into their view, raised and selected. Only theirs: the room's
  // views stay where each person left them.
  const revealRef = useRef(new Set<string>());
  const knownRef = useRef(new Set<string>());
  // Brings a window into this viewer's view, centred, when it is not fully in view already.
  const centerOn = (object: SpaceObjectView) => {
    const board = boardRef.current;
    if (!board) {
      return;
    }
    const current = scaleRef.current;
    const box = {
      left: object.x * current,
      top: object.y * current,
      width: object.w * current,
      height: object.h * current,
    };
    // The view a window can use: the board less a margin, and less the dock along the bottom.
    const view = {
      left: board.scrollLeft + followMarginPx,
      top: board.scrollTop + followMarginPx,
      width: board.clientWidth - 2 * followMarginPx,
      height: board.clientHeight - followMarginPx - followDockMarginPx,
    };
    const inView =
      box.left >= view.left &&
      box.top >= view.top &&
      box.left + box.width <= view.left + view.width &&
      box.top + box.height <= view.top + view.height;
    if (!inView) {
      board.scrollTo({
        left: Math.max(
          0,
          box.width <= view.width
            ? box.left + box.width / 2 - board.clientWidth / 2
            : box.left - followMarginPx
        ),
        top: Math.max(
          0,
          box.height <= view.height
            ? box.top + box.height / 2 - (followMarginPx + view.height / 2)
            : box.top - followMarginPx
        ),
      });
    }
  };
  const reveal = (object: SpaceObjectView) => {
    centerOn(object);
    setSelectedId(object.id);
    bringToFront(session.ydoc, object.id, actor);
  };
  const openIds = new Set(objects.map((object) => object.id));
  const leaving = dock
    ? [...committedRef.current.values()].filter(
        (object) => !openIds.has(object.id)
      )
    : [];
  const drawn = [...objects, ...leaving];
  const flyTarget = (id: string, state: WindowState | "closed") =>
    state === "minimized"
      ? (document.querySelector(`[data-dock-key="window:${id}"]`) ??
        document.querySelector('[data-desktop-target="dock"]'))
      : (document.querySelector(`[data-desktop-icon="${id}"]`) ??
        document.querySelector('[data-desktop-target="desktop"]') ??
        document.querySelector('[data-desktop-target="dock"]'));

  useLayoutEffect(() => {
    if (!dock) {
      return;
    }
    const committed = committedRef.current;
    for (const object of objects) {
      const element = windowRefs.current.get(object.id);
      const placedByMe =
        !firstPaintRef.current &&
        !knownRef.current.has(object.id) &&
        object.by.kind === "human" &&
        object.by.id === user.id;
      if (revealRef.current.delete(object.id) || placedByMe) {
        reveal(object);
      }
      const placedByAgent =
        !firstPaintRef.current &&
        !knownRef.current.has(object.id) &&
        object.by.kind === "agent";
      const tile = placedByAgent
        ? document.querySelector(`[data-dock-key="new:${object.kind}"]`)
        : null;
      if (placedByAgent) {
        startCreation(object, tile);
        if (
          followRef.current === "on" &&
          Date.now() - lastTouchAtRef.current >= followIdleMs
        ) {
          centerOn(object);
        }
      }
      if (flyingRef.current.has(object.id)) {
        flyingRef.current.delete(object.id);
        for (const animation of element?.getAnimations() ?? []) {
          animation.cancel();
        }
      } else if (
        !committed.has(object.id) &&
        !firstPaintRef.current &&
        lastMaximizedRef.current !== object.id &&
        element
      ) {
        flyWindow(
          element,
          tile ?? flyTarget(object.id, "closed"),
          "in",
          scaleRef.current
        );
      }
      committed.set(object.id, object);
    }
    for (const object of allObjects) {
      knownRef.current.add(object.id);
    }
    firstPaintRef.current = false;
    lastMaximizedRef.current = maximized?.id ?? null;
    for (const object of leaving) {
      if (flyingRef.current.has(object.id)) {
        continue;
      }
      flyingRef.current.add(object.id);
      const now = allObjects.find((each) => each.id === object.id);
      const element = windowRefs.current.get(object.id);
      const flight =
        element && now?.state !== "maximized"
          ? flyWindow(
              element,
              flyTarget(object.id, now?.state ?? "closed"),
              "out",
              scaleRef.current
            )
          : null;
      const land = () => {
        if (!flyingRef.current.delete(object.id)) {
          return;
        }
        committed.delete(object.id);
        setFlights((count) => count + 1);
      };
      if (flight) {
        flight.finished.then(land, land);
      } else {
        land();
      }
    }
  });

  const setState = (id: string, state: WindowState) =>
    setWindowState(session.ydoc, id, state, actor);
  const selected = objects.find((object) => object.id === selectedId) ?? null;
  const activeId = selected?.id ?? objects.at(-1)?.id ?? null;
  const target = selected
    ? (windowRefs.current.get(selected.id) ?? null)
    : null;
  const dragTarget = selected
    ? (handleRefs.current.get(selected.id) ?? null)
    : null;
  const extent = objects.reduce(
    (acc, object) => ({
      w: Math.max(acc.w, object.x + object.w),
      h: Math.max(acc.h, object.y + object.h),
    }),
    { w: 0, h: 0 }
  );
  const topId = allObjects.at(-1)?.id;

  const zoomAt = useCallback((next: number, px: number, py: number) => {
    const board = boardRef.current;
    if (!board) {
      return;
    }
    const current = scaleRef.current;
    anchorRef.current = {
      x: (board.scrollLeft + px) / current,
      y: (board.scrollTop + py) / current,
      px,
      py,
    };
    scaleRef.current = clampScale(next);
    setScale(scaleRef.current);
  }, []);

  const zoomFromCenter = (factor: number) => {
    const board = boardRef.current;
    if (board) {
      zoomAt(
        scaleRef.current * factor,
        board.clientWidth / 2,
        board.clientHeight / 2
      );
    }
  };

  const fit = () => {
    const board = boardRef.current;
    if (!board || extent.w === 0) {
      return;
    }
    anchorRef.current = { x: 0, y: 0, px: 0, py: 0 };
    scaleRef.current = clampScale(
      Math.min(
        (board.clientWidth - fitMarginPx) / extent.w,
        (board.clientHeight - fitMarginPx) / extent.h,
        1
      )
    );
    setScale(scaleRef.current);
  };

  useLayoutEffect(() => {
    const board = boardRef.current;
    const anchor = anchorRef.current;
    if (!board || !anchor) {
      return;
    }
    board.scrollLeft = anchor.x * scale - anchor.px;
    board.scrollTop = anchor.y * scale - anchor.py;
    anchorRef.current = null;
    moveableRef.current?.updateRect();
  }, [scale]);

  // Pinch on a trackpad arrives as a wheel with ctrlKey; Cmd or Ctrl and the wheel do the same.
  // React's wheel listener is passive, so the browser's own page zoom can only be stopped here.
  useEffect(() => {
    const board = boardRef.current;
    if (!board) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const rect = board.getBoundingClientRect();
      zoomAt(
        scaleRef.current *
          Math.exp(
            -Math.max(-wheelStepCap, Math.min(wheelStepCap, event.deltaY)) *
              0.01
          ),
        event.clientX - rect.left,
        event.clientY - rect.top
      );
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const commitBox = (element: HTMLElement, id: string) => {
    moveObject(
      session.ydoc,
      id,
      Math.round(Number.parseFloat(element.style.left)),
      Math.round(Number.parseFloat(element.style.top)),
      actor
    );
    resizeObject(
      session.ydoc,
      id,
      Math.round(Number.parseFloat(element.style.width)),
      Math.round(Number.parseFloat(element.style.height)),
      actor
    );
  };

  // The keyboard alternative to dragging: arrows move the focused window, Shift and arrows
  // resize it.
  const nudge = (
    object: SpaceObjectView,
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    const delta = arrowDeltas[event.key];
    if (!canEdit || !delta) {
      return;
    }
    event.preventDefault();
    const [dx, dy] = delta;
    if (event.shiftKey) {
      resizeObject(
        session.ydoc,
        object.id,
        Math.max(minWindow.w, object.w + dx * nudgePx),
        Math.max(minWindow.h, object.h + dy * nudgePx),
        actor
      );
    } else {
      moveObject(
        session.ydoc,
        object.id,
        Math.max(0, object.x + dx * nudgePx),
        Math.max(0, object.y + dy * nudgePx),
        actor
      );
    }
  };

  const windowHeader = (
    object: SpaceObjectView,
    title: string,
    actions: ReactNode
  ) => {
    const isMaximized = object.id === maximized?.id;
    const toggleMaximized = () =>
      setState(object.id, isMaximized ? "open" : "maximized");
    return (
      <div
        ref={(element) => {
          if (isMaximized) {
            return;
          }
          if (element) {
            handleRefs.current.set(object.id, element);
          } else {
            handleRefs.current.delete(object.id);
          }
        }}
        className={cn(
          "flex shrink-0 select-none items-center gap-2 border-b border-border px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight dark:border-border-night",
          dock
            ? "h-9 bg-muted-background/70 dark:bg-muted-background-night/70"
            : "h-10",
          canEdit && !isMaximized && "cursor-move"
        )}
        tabIndex={0}
        aria-label={
          canEdit && !isMaximized
            ? `${title} window. Arrow keys move it, Shift and arrow keys resize it.`
            : `${title} window`
        }
        onFocus={() => setSelectedId(object.id)}
        onKeyDown={(event) => !isMaximized && nudge(object, event)}
        onDoubleClick={dock && canEdit ? toggleMaximized : undefined}
      >
        {dock && (
          <TrafficLights
            title={title}
            isMaximized={isMaximized}
            isActive={isMaximized || object.id === activeId}
            disabled={!canEdit}
            onClose={() => closeObject(object)}
            onMinimize={() => setState(object.id, "minimized")}
            onMaximize={toggleMaximized}
          />
        )}
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            dock && "justify-center"
          )}
        >
          <Icon
            visual={liveDocIcon(kindsByDocName.get(object.docName))}
            size="xs"
          />
          <span className="truncate text-sm font-medium text-foreground dark:text-foreground-night">
            {title}
          </span>
        </span>
        {actions}
        {openDoc && (
          <Button
            size="xs"
            variant="ghost"
            icon={LinkExternal01}
            tooltip="Open on its own"
            aria-label={`Open ${title} on its own`}
            onClick={() => openDoc(object.docName)}
          />
        )}
        {canEdit && !dock && (
          <Button
            size="xs"
            variant="ghost"
            icon={XClose}
            tooltip="Hide from the space"
            aria-label={`Hide ${title} from the space`}
            onClick={() => closeObject(object)}
          />
        )}
      </div>
    );
  };

  // Follow: while an agent works, every viewer who is not busy on the board keeps its cursor in
  // view. Touching the board pauses that for a moment; Stop turns it off until Follow.
  const [follow, setFollow] = useState<"on" | "off">("on");
  const followRef = useRef(follow);
  followRef.current = follow;
  const lastTouchAtRef = useRef(0);
  const [working, setWorking] = useState<{
    name: string;
    paused: boolean;
  } | null>(null);
  const touch = () => {
    lastTouchAtRef.current = Date.now();
  };
  useEffect(() => {
    if (!dock) {
      return;
    }
    const timer = setInterval(() => {
      const board = boardRef.current;
      if (!board) {
        return;
      }
      const mark = [
        ...board.querySelectorAll<HTMLElement>("[data-agent-mark]"),
      ].at(-1);
      const paused = Date.now() - lastTouchAtRef.current < followIdleMs;
      setWorking((current) => {
        const next = mark
          ? { name: mark.dataset.agentMark ?? "", paused }
          : null;
        return current?.name === next?.name && current?.paused === next?.paused
          ? current
          : next;
      });
      if (!mark || followRef.current === "off" || paused) {
        return;
      }
      // The whole window the agent works in, not just its cursor point: centred when it fits,
      // its title bar at the top when it is taller or wider than the view.
      const box = board.getBoundingClientRect();
      const at = (
        mark.closest<HTMLElement>(".origin-top-left > [data-object-title]") ??
        mark
      ).getBoundingClientRect();
      const view = {
        left: box.left + followMarginPx,
        top: box.top + followMarginPx,
        right: box.right - followMarginPx,
        bottom: box.bottom - followDockMarginPx,
      };
      const inView =
        at.left >= view.left &&
        at.right <= view.right &&
        at.top >= view.top &&
        at.bottom <= view.bottom;
      if (!inView) {
        const fitsWide = at.width <= view.right - view.left;
        const fitsTall = at.height <= view.bottom - view.top;
        board.scrollTo({
          left:
            board.scrollLeft +
            (fitsWide
              ? at.left + at.width / 2 - (view.left + view.right) / 2
              : at.left - view.left),
          top:
            board.scrollTop +
            (fitsTall
              ? at.top + at.height / 2 - (view.top + view.bottom) / 2
              : at.top - view.top),
          behavior: reducedMotion() ? "auto" : "smooth",
        });
      }
    }, followScanMs);
    return () => clearInterval(timer);
  }, [dock]);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const board = boardRef.current;
    const now = Date.now();
    if (!board || now - lastPointerAtRef.current < pointerIntervalMs) {
      return;
    }
    lastPointerAtRef.current = now;
    const rect = board.getBoundingClientRect();
    session.provider.setAwarenessField("pointer", {
      x: (event.clientX - rect.left + board.scrollLeft) / scaleRef.current,
      y: (event.clientY - rect.top + board.scrollTop) / scaleRef.current,
    });
  };

  return (
    <InsideSpace.Provider value>
      <div
        ref={wrapperRef}
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          if (
            canEdit &&
            uploadFiles &&
            event.dataTransfer.types.includes("Files")
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setIsDropping(true);
          }
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setIsDropping(false);
          }
        }}
        onDrop={(event) => {
          setIsDropping(false);
          if (canEdit && uploadFiles && event.dataTransfer.files.length > 0) {
            event.preventDefault();
            uploadFiles([...event.dataTransfer.files]);
          }
        }}
      >
        {isDropping && (
          <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-highlight-500 bg-highlight-500/10 text-sm font-medium text-highlight-700 backdrop-blur-[1px]">
            Drop to add to the space
          </div>
        )}
        <div
          ref={boardRef}
          className={cn(
            "relative min-h-0 flex-1 overflow-auto [container-type:size]",
            !dock &&
              "bg-[#f4f5f7] bg-[radial-gradient(#cdd1d8_1px,transparent_1.5px)] dark:bg-[#16171b] dark:bg-[radial-gradient(#3a3d45_1px,transparent_1.5px)]"
          )}
          style={{
            cursor: selfCursor(colorForId(user.id)),
            ...(dock
              ? desktopWallpaper(isDark)
              : {
                  backgroundSize: `${dotGapPx * scale}px ${dotGapPx * scale}px`,
                  backgroundAttachment: "local",
                }),
          }}
          onPointerMove={onPointerMove}
          onPointerLeave={() =>
            session.provider.setAwarenessField("pointer", null)
          }
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedId(null);
            }
          }}
          onPointerDownCapture={touch}
          onWheelCapture={touch}
          onKeyDownCapture={touch}
          onScroll={() => moveableRef.current?.updateRect()}
        >
          {/* The desktop's icons sit under every window, pinned to the visible top right. */}
          {dock && (
            <div className="sticky top-0 left-0 h-0 w-full">
              {canEdit && hidden.length > 0 && (
                <DesktopIcons
                  closed={hidden.map((object) => ({
                    id: object.id,
                    title: object.title,
                    kind: kindsByDocName.get(object.docName),
                  }))}
                  disabled={!canEdit}
                  onBin={(id) => binObject(session.ydoc, id)}
                  onOpen={(id) => {
                    revealRef.current.add(id);
                    const object = hidden.find((each) => each.id === id);
                    if (object) {
                      placeObject(
                        session.ydoc,
                        {
                          docName: object.docName,
                          kind: object.kind,
                          title: object.title,
                          x: object.x,
                          y: object.y,
                          w: object.w,
                          h: object.h,
                        },
                        actor
                      );
                    }
                  }}
                />
              )}
            </div>
          )}
          <div
            className="pointer-events-none relative"
            style={{
              // As a desktop the board runs past its last window, so any window can be scrolled
              // clear of the dock and into the middle of the view.
              width:
                Math.max(extent.w + slotSize.gap, 1) * scale +
                (dock ? desktopOverscrollPx : 0),
              height:
                Math.max(extent.h + slotSize.gap, 1) * scale +
                (dock ? desktopOverscrollPx : 0),
              minWidth: "100%",
              minHeight: "100%",
            }}
          >
            <div
              className="absolute top-0 left-0 origin-top-left"
              style={{
                width: Math.max(extent.w + slotSize.gap, 1),
                height: Math.max(extent.h + slotSize.gap, 1),
                minWidth: `${100 / scale}%`,
                minHeight: `${100 / scale}%`,
                transform: `scale(${scale})`,
              }}
            >
              {allObjects.length === 0 && hidden.length === 0 && (
                <p className="absolute inset-0 flex items-center justify-center p-8 text-center text-sm text-muted-foreground dark:text-muted-foreground-night">
                  Nothing here yet. A doc, sheet, canvas or browser an agent
                  opens in this chat appears here as a window.
                </p>
              )}
              {/* ponytail: one socket per window; multiplex through one provider when spaces hold dozens of objects. */}
              {drawn.map((object) => (
                <div
                  key={object.id}
                  data-object-title={object.title}
                  ref={(element) => {
                    if (element) {
                      windowRefs.current.set(object.id, element);
                    } else {
                      windowRefs.current.delete(object.id);
                    }
                  }}
                  className={cn(
                    "absolute flex flex-col overflow-hidden rounded-xl border bg-background shadow-md dark:bg-background-night",
                    openIds.has(object.id)
                      ? "pointer-events-auto"
                      : "pointer-events-none",
                    dock
                      ? cn(
                          "border-black/10 transition-shadow duration-200 dark:border-white/10",
                          object.id === activeId
                            ? "shadow-[0_24px_64px_-12px_rgb(0_0_0/0.45)]"
                            : "shadow-[0_6px_24px_-8px_rgb(0_0_0/0.22)]"
                        )
                      : selected?.id === object.id
                        ? "border-highlight"
                        : "border-border dark:border-border-night"
                  )}
                  style={{
                    left: object.x,
                    top: object.y,
                    width: object.w,
                    height: object.h,
                    zIndex: object.z,
                  }}
                  onPointerDownCapture={() => {
                    setSelectedId(object.id);
                    if (canEdit && topId !== object.id) {
                      bringToFront(session.ydoc, object.id, actor);
                    }
                  }}
                >
                  {creations.some(
                    (each) => each.id === object.id && each.at === null
                  ) && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute top-5 left-1/2 h-px w-px"
                      {...agentMark({
                        name:
                          creations.find((each) => each.id === object.id)
                            ?.name ?? "",
                        color: agentCursorColor,
                        action: "creating",
                      })}
                    />
                  )}
                  {renderObject({
                    docId: object.docName,
                    agents,
                    className: "min-h-0 flex-1",
                    renderHeader: ({ title, actions }) =>
                      windowHeader(object, title, actions),
                  })}
                </div>
              ))}
              {peers.map((peer) => (
                <PeerMarks
                  key={peer.clientId}
                  peer={peer}
                  objects={objects}
                  scale={scale}
                />
              ))}
            </div>
          </div>
          {canEdit && target && selected && (
            <Moveable
              ref={moveableRef}
              target={target}
              dragTarget={dragTarget ?? undefined}
              draggable
              resizable={dock ? { edge: true } : true}
              hideDefaultLines={dock !== null}
              className={cn(
                dock &&
                  // Moveable injects its own unlayered styles, so only !important hides its corner dots.
                  "[&_.moveable-control]:opacity-0!"
              )}
              snappable
              throttleDrag={1}
              throttleResize={1}
              snapThreshold={snapThresholdPx}
              elementGuidelines={objects.flatMap((object) => {
                const element = windowRefs.current.get(object.id);
                return element && object.id !== selected.id ? [element] : [];
              })}
              isDisplaySnapDigit={false}
              onDrag={({ target: moved, left, top }) => {
                moved.style.left = `${left}px`;
                moved.style.top = `${top}px`;
              }}
              onDragEnd={({ target: moved, isDrag }) => {
                if (isDrag && moved instanceof HTMLElement) {
                  commitBox(moved, selected.id);
                }
              }}
              onResize={({ target: moved, width, height, drag }) => {
                moved.style.width = `${width}px`;
                moved.style.height = `${height}px`;
                moved.style.left = `${drag.left}px`;
                moved.style.top = `${drag.top}px`;
              }}
              onResizeEnd={({ target: moved, isDrag }) => {
                if (isDrag && moved instanceof HTMLElement) {
                  commitBox(moved, selected.id);
                }
              }}
            />
          )}
        </div>
        {creations.map(
          (each) =>
            each.at && (
              <span
                key={each.id}
                aria-hidden
                data-object-title={each.title}
                className="pointer-events-none absolute h-px w-px"
                style={{ left: each.at.x, top: each.at.y }}
                {...agentMark({
                  name: each.name,
                  color: agentCursorColor,
                  action: "creating",
                })}
              />
            )
        )}
        {dock && working && (
          <div
            role="status"
            className="absolute top-3 left-1/2 z-[1031] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/60 bg-white/70 py-1 pr-1 pl-3 text-xs font-medium text-stone-800 shadow-lg backdrop-blur-xl dark:border-white/15 dark:bg-stone-900/70 dark:text-stone-100"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: agentCursorColor }}
            />
            {follow === "on" && !working.paused
              ? `Following ${working.name}`
              : `${working.name} is working`}
            <button
              type="button"
              className="rounded-full px-2 py-0.5 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight dark:hover:bg-white/10"
              onClick={() => {
                if (follow === "on" && !working.paused) {
                  setFollow("off");
                } else {
                  lastTouchAtRef.current = 0;
                  setFollow("on");
                }
              }}
            >
              {follow === "on" && !working.paused ? "Stop" : "Follow"}
            </button>
          </div>
        )}
        {maximized && (
          <div
            ref={popIn}
            data-object-title={maximized.title}
            className="absolute inset-2 bottom-[84px] z-[1025] flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl dark:border-border-night dark:bg-background-night"
          >
            {renderObject({
              docId: maximized.docName,
              agents,
              className: "min-h-0 flex-1",
              renderHeader: ({ title, actions }) =>
                windowHeader(maximized, title, actions),
            })}
          </div>
        )}
        {dock ? (
          <>
            <Dock
              items={canEdit ? dock : []}
              minimized={docked.map((object) => ({
                id: object.id,
                title: object.title,
                kind: kindsByDocName.get(object.docName),
              }))}
              onRestore={(id) => {
                revealRef.current.add(id);
                setState(id, "open");
              }}
              bin={
                canEdit
                  ? {
                      items: binned.map((object) => ({
                        id: object.id,
                        title: object.title,
                        kind: kindsByDocName.get(object.docName),
                      })),
                      canDelete: deleteObject !== null,
                      onBin: (id) => binObject(session.ydoc, id),
                      onPutBack: (id) => {
                        const object = binned.find((each) => each.id === id);
                        if (object) {
                          placeObject(
                            session.ydoc,
                            {
                              docName: object.docName,
                              kind: object.kind,
                              title: object.title,
                              x: object.x,
                              y: object.y,
                              w: object.w,
                              h: object.h,
                            },
                            actor
                          );
                          removeObject(session.ydoc, object.id, actor);
                        }
                      },
                      onDelete: async (ids) => {
                        for (const object of binned.filter((each) =>
                          ids.includes(each.id)
                        )) {
                          // The channel forgets the object first, so no viewer places it back.
                          if (await deleteObject?.(object.docName)) {
                            forgetObject(session.ydoc, object.id);
                          }
                        }
                      },
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-0.5">
                <Button
                  size="xs"
                  variant="ghost"
                  icon={Minus}
                  tooltip="Zoom out"
                  disabled={scale <= minScale}
                  onClick={() => zoomFromCenter(1 / zoomStep)}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  label={`${Math.round(scale * 100)}%`}
                  tooltip="Back to 100%"
                  className="min-w-12 tabular-nums"
                  onClick={() => zoomFromCenter(1 / scaleRef.current)}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  icon={Plus}
                  tooltip="Zoom in"
                  disabled={scale >= maxScale}
                  onClick={() => zoomFromCenter(zoomStep)}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  icon={Maximize}
                  tooltip="Fit everything"
                  onClick={fit}
                />
              </div>
            </Dock>
          </>
        ) : (
          <div className="absolute right-3 bottom-3 z-[1030] flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-md dark:border-border-night dark:bg-background-night">
            <Button
              size="xs"
              variant="ghost"
              icon={Minus}
              tooltip="Zoom out"
              disabled={scale <= minScale}
              onClick={() => zoomFromCenter(1 / zoomStep)}
            />
            <Button
              size="xs"
              variant="ghost"
              label={`${Math.round(scale * 100)}%`}
              tooltip="Back to 100%"
              className="min-w-12 tabular-nums"
              onClick={() => zoomFromCenter(1 / scaleRef.current)}
            />
            <Button
              size="xs"
              variant="ghost"
              icon={Plus}
              tooltip="Zoom in"
              disabled={scale >= maxScale}
              onClick={() => zoomFromCenter(zoomStep)}
            />
            <Button
              size="xs"
              variant="ghost"
              icon={Maximize}
              tooltip="Fit everything"
              onClick={fit}
            />
          </div>
        )}
        {!dock && canEdit && hidden.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground dark:border-border-night dark:text-muted-foreground-night">
            <span>Hidden</span>
            {hidden.map((object) => (
              <Button
                key={object.id}
                size="xs"
                variant="outline"
                label={object.title}
                tooltip="Show in the space again"
                onClick={() =>
                  placeObject(
                    session.ydoc,
                    {
                      docName: object.docName,
                      kind: object.kind,
                      title: object.title,
                    },
                    actor
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </InsideSpace.Provider>
  );
}

interface PeerMarksProps {
  peer: LiveObjectContext["peers"][number];
  objects: SpaceObjectView[];
  scale: number;
}

// A person's pointer as an arrow with their name; an agent's ✦ label pinned to the window it
// just placed.
function PeerMarks({ peer, objects, scale }: PeerMarksProps) {
  // Marks keep their size on screen whatever the board's zoom.
  const unscale = {
    transform: `scale(${1 / scale})`,
    transformOrigin: "top left",
  };
  const label = peer.kind === "agent" ? `✦ ${peer.name}` : peer.name;
  const pinned = peer.objectId
    ? objects.find((object) => object.id === peer.objectId)
    : null;
  return (
    <>
      {pinned && (
        <span
          className="pointer-events-none absolute whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium text-white"
          style={{
            left: pinned.x + 8,
            top: pinned.y - 26,
            background: peer.color,
            zIndex: 1_000,
            ...unscale,
          }}
        >
          {label}
        </span>
      )}
      {peer.pointer && (
        <div
          className="pointer-events-none absolute"
          style={{
            left: peer.pointer.x,
            top: peer.pointer.y,
            zIndex: 1_010,
            ...unscale,
          }}
        >
          <CursorMark color={peer.color} label={peer.name} />
        </div>
      )}
    </>
  );
}
