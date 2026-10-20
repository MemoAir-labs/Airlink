import { richTextExtensions } from "@memo-air/richtext";
import type {
  DeckEditor,
  DeckElementView,
  ElementSnapshot,
} from "@memo-air/slides";
import {
  duplicateElementByHand,
  elementFragment,
  markEditedByHand,
  removeElementByHand,
  setElementByHand,
  slideHeight,
  slideWidth,
} from "@memo-air/slides";
import Collaboration from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Moveable from "react-moveable";
import { agentMark } from "./AgentCursors";
import {
  boxStyle,
  deckVars,
  ElementBody,
  slideRichTextClass,
  textStyle,
} from "./slideRender";
import { Button, cn } from "./ui";
import type { DeckState } from "./useDeck";
import type { LiveDocSession, LivePeer } from "./useLiveDocSession";

const pointerIntervalMs = 50;
const snapThresholdPx = 10;
// The slide leaves a margin around itself inside the editing area.
const stageFill = 0.94;

interface SlideTextEditorProps {
  session: LiveDocSession;
  element: DeckElementView;
  state: DeckState;
  actor: DeckEditor;
  onDone: () => void;
}

// A text box being edited: Tiptap bound to the element's own Yjs fragment, styled by the deck.
function SlideTextEditor({
  session,
  element,
  state,
  actor,
  onDone,
}: SlideTextEditorProps) {
  const fragment = elementFragment(session.ydoc, element.id);
  const editor = useEditor(
    {
      extensions: [
        ...richTextExtensions(),
        Collaboration.configure({ fragment: fragment ?? undefined }),
      ],
      autofocus: "end",
      onUpdate: ({ editor: current }) => {
        if (current.isFocused) {
          markEditedByHand(session.ydoc, element.id, actor);
        }
      },
      editorProps: {
        attributes: {
          class: cn(slideRichTextClass, "w-full outline-none"),
          "aria-label": `Edit ${element.slot ?? "text"}`,
        },
        handleKeyDown: (_view, event) => {
          if (event.key === "Escape") {
            onDone();
            return true;
          }
          return false;
        },
      },
    },
    [session, element.id]
  );
  return (
    <div
      className="h-full w-full"
      style={textStyle(state.theme, element.style)}
    >
      <EditorContent editor={editor} className="w-full" />
    </div>
  );
}

type Ghost = {
  key: string;
  suggestionId: string;
  kind: "added" | "changed" | "removed";
  box: Pick<ElementSnapshot, "x" | "y" | "w" | "h">;
  element: DeckElementView | null;
};

// Pending suggestions on this slide, drawn as dashed outlines (and the proposed element itself).
function ghostsFor(state: DeckState, slideId: string): Ghost[] {
  const current = new Map(
    state.deck.slides.flatMap((slide) =>
      slide.elements.map((element) => [element.id, element])
    )
  );
  return state.suggestions.flatMap((suggestion) =>
    suggestion.changes.flatMap((change): Ghost[] => {
      switch (change.type) {
        case "add_element":
          return change.element.slideId === slideId
            ? [
                {
                  key: `${suggestion.id}-${change.element.id}`,
                  suggestionId: suggestion.id,
                  kind: "added",
                  box: change.element,
                  element: { ...change.element, by: null },
                },
              ]
            : [];
        case "set_element": {
          const now = current.get(change.elementId);
          return now && now.slideId === slideId
            ? [
                {
                  key: `${suggestion.id}-${change.elementId}`,
                  suggestionId: suggestion.id,
                  kind: "changed",
                  box: { ...now, ...change.after },
                  element: null,
                },
              ]
            : [];
        }
        case "delete_element":
          return change.before.slideId === slideId
            ? [
                {
                  key: `${suggestion.id}-${change.before.id}`,
                  suggestionId: suggestion.id,
                  kind: "removed",
                  box: change.before,
                  element: null,
                },
              ]
            : [];
        default:
          return [];
      }
    })
  );
}

interface SlideStageProps {
  session: LiveDocSession;
  state: DeckState;
  slideId: string;
  canEdit: boolean;
  actor: DeckEditor;
  peers: LivePeer[];
  activeSuggestionId: string | null;
  onSelectSuggestion: (id: string) => void;
}

export function SlideStage({
  session,
  state,
  slideId,
  canEdit,
  actor,
  peers,
  activeSuggestionId,
  onSelectSuggestion,
}: SlideStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRefs = useRef(new Map<string, HTMLDivElement>());
  const lastPointerAtRef = useRef(0);
  const [scale, setScale] = useState(0.4);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const slide = state.deck.slides.find((s) => s.id === slideId);
  const elements = slide?.elements ?? [];
  const selected = elements.find((e) => e.id === selectedId) ?? null;
  const ghosts = useMemo(() => ghostsFor(state, slideId), [state, slideId]);
  // The selected element's node, for Moveable; none while its text is being edited.
  const target =
    selectedId && !editingId
      ? (elementRefs.current.get(selectedId) ?? null)
      : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setScale(
        Math.max(
          0.05,
          Math.min(width / slideWidth, height / slideHeight) * stageFill
        )
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    session.provider.setAwarenessField(
      "slideSelection",
      selectedId
        ? { slideId, elementId: selectedId }
        : { slideId, elementId: null }
    );
  }, [session, slideId, selectedId]);

  const commitBox = (element: HTMLElement, id: string) => {
    setElementByHand(
      session.ydoc,
      id,
      {
        x: Math.round(Number.parseFloat(element.style.left)),
        y: Math.round(Number.parseFloat(element.style.top)),
        w: Math.round(Number.parseFloat(element.style.width)),
        h: Math.round(Number.parseFloat(element.style.height)),
      },
      actor
    );
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!selected || editingId || !canEdit) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeElementByHand(session.ydoc, selected.id);
      setSelectedId(null);
    } else if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      setSelectedId(duplicateElementByHand(session.ydoc, selected.id, actor));
    } else if (event.key === "]" || event.key === "[") {
      event.preventDefault();
      setElementByHand(
        session.ydoc,
        selected.id,
        { z: Math.max(0, selected.z + (event.key === "]" ? 1 : -1)) },
        actor
      );
    } else if (event.key === "Enter" && selected.kind === "text") {
      event.preventDefault();
      setEditingId(selected.id);
    } else if (event.key === "Escape") {
      setSelectedId(null);
    }
  };

  const otherRefs = elements
    .filter((e) => e.id !== selectedId)
    .flatMap((e) => {
      const ref = elementRefs.current.get(e.id);
      return ref ? [ref] : [];
    });

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Slide editor"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex h-full w-full items-center justify-center overflow-hidden outline-none"
    >
      <div
        className="relative shadow-lg ring-1 ring-black/10"
        style={{ width: slideWidth * scale, height: slideHeight * scale }}
        onPointerMove={(event) => {
          const now = Date.now();
          if (now - lastPointerAtRef.current < pointerIntervalMs) {
            return;
          }
          lastPointerAtRef.current = now;
          const rect = event.currentTarget.getBoundingClientRect();
          session.provider.setAwarenessField("slidePointer", {
            slideId,
            x: Math.round((event.clientX - rect.left) / scale),
            y: Math.round((event.clientY - rect.top) / scale),
          });
        }}
      >
        <div
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedId(null);
              setEditingId(null);
            }
          }}
          style={{
            width: slideWidth,
            height: slideHeight,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            position: "absolute",
            background: state.theme.palette.background,
            ...deckVars(state.theme),
          }}
        >
          {elements.map((element) => (
            <div
              key={element.id}
              ref={(node) => {
                if (node) {
                  elementRefs.current.set(element.id, node);
                } else {
                  elementRefs.current.delete(element.id);
                }
              }}
              style={boxStyle(element)}
              className={cn(
                canEdit && "cursor-move",
                selectedId === element.id &&
                  editingId !== element.id &&
                  "outline outline-[3px] outline-highlight-500"
              )}
              onPointerDown={(event) => {
                if (!canEdit || editingId === element.id) {
                  return;
                }
                event.stopPropagation();
                setSelectedId(element.id);
                if (editingId) {
                  setEditingId(null);
                }
              }}
              onDoubleClick={() => {
                if (canEdit && element.kind === "text") {
                  setEditingId(element.id);
                }
              }}
            >
              {editingId === element.id ? (
                <SlideTextEditor
                  session={session}
                  element={element}
                  state={state}
                  actor={actor}
                  onDone={() => setEditingId(null)}
                />
              ) : (
                <ElementBody
                  element={element}
                  theme={state.theme}
                  blocks={state.blocks.get(element.id) ?? []}
                />
              )}
            </div>
          ))}
          {ghosts.map((ghost) => (
            <button
              key={ghost.key}
              type="button"
              aria-label={`Suggested ${ghost.kind} element`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onSelectSuggestion(ghost.suggestionId)}
              className={cn(
                "absolute rounded-md border-[4px] border-dashed",
                ghost.kind === "removed"
                  ? "border-red-500 bg-red-500/10"
                  : "border-green-500",
                ghost.suggestionId === activeSuggestionId &&
                  "ring-[6px] ring-green-500/30"
              )}
              style={{
                left: ghost.box.x,
                top: ghost.box.y,
                width: ghost.box.w,
                height: ghost.box.h,
                zIndex: 900,
              }}
            >
              {ghost.element && (
                <div className="pointer-events-none h-full w-full opacity-60">
                  <ElementBody
                    element={ghost.element}
                    theme={state.theme}
                    blocks={[]}
                  />
                </div>
              )}
            </button>
          ))}
          {peers.map((peer) => {
            const presence = peer.slide;
            if (presence?.slideId !== slideId) {
              return null;
            }
            const focused = elements.find((e) => e.id === presence.elementId);
            const label = peer.kind === "agent" ? `✦ ${peer.name}` : peer.name;
            return (
              <div key={peer.clientId} className="pointer-events-none">
                {/* An agent on this slide with no element in hand yet (a slide it just added,
                    its notes) is shown on the slide itself. */}
                {!focused && peer.kind === "agent" && (
                  <span
                    aria-hidden
                    className="absolute top-8 left-1/2 h-px w-px"
                    {...agentMark({
                      name: peer.name,
                      color: peer.color,
                      action: "editing",
                    })}
                  />
                )}
                {focused && (
                  <div
                    className="absolute"
                    style={{
                      left: focused.x - 6,
                      top: focused.y - 6,
                      width: focused.w + 12,
                      height: focused.h + 12,
                      border: `4px solid ${peer.color}`,
                      borderRadius: 8,
                      zIndex: 950,
                    }}
                  >
                    <span
                      className="absolute -top-12 left-0 whitespace-nowrap rounded-md px-3 py-1 text-[26px] font-medium text-white"
                      style={{ background: peer.color }}
                      {...(peer.kind === "agent"
                        ? agentMark({
                            name: peer.name,
                            color: peer.color,
                            action: "editing",
                          })
                        : {})}
                    >
                      {label}
                    </span>
                  </div>
                )}
                {presence.pointer && (
                  <div
                    className="absolute"
                    style={{
                      left: presence.pointer.x,
                      top: presence.pointer.y,
                      zIndex: 960,
                    }}
                  >
                    <svg width={36} height={36} viewBox="0 0 24 24" aria-hidden>
                      <path
                        d="M3 2l18 9-8 2-3 8z"
                        fill={peer.color}
                        stroke="white"
                        strokeWidth={1.5}
                      />
                    </svg>
                    <span
                      className="ml-6 whitespace-nowrap rounded px-2 py-0.5 text-[22px] text-white"
                      style={{ background: peer.color }}
                    >
                      {label}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {canEdit && target && selected && (
          <Moveable
            target={target}
            draggable
            resizable
            snappable
            keepRatio={selected.kind === "image"}
            zoom={1}
            snapThreshold={snapThresholdPx}
            verticalGuidelines={[0, slideWidth / 2, slideWidth]}
            horizontalGuidelines={[0, slideHeight / 2, slideHeight]}
            elementGuidelines={otherRefs}
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
      {canEdit && selected && !editingId && (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-xl border border-border bg-background p-1 shadow-md dark:border-border-night dark:bg-background-night">
          {selected.kind === "text" && (
            <Button
              size="xs"
              variant="ghost"
              label="Edit text"
              onClick={() => setEditingId(selected.id)}
            />
          )}
          <Button
            size="xs"
            variant="ghost"
            label="Duplicate"
            tooltip="Duplicate (⌘D)"
            onClick={() =>
              setSelectedId(
                duplicateElementByHand(session.ydoc, selected.id, actor)
              )
            }
          />
          <Button
            size="xs"
            variant="ghost"
            label="Forward"
            tooltip="Bring forward (])"
            onClick={() =>
              setElementByHand(
                session.ydoc,
                selected.id,
                { z: selected.z + 1 },
                actor
              )
            }
          />
          <Button
            size="xs"
            variant="ghost"
            label="Backward"
            tooltip="Send backward ([)"
            onClick={() =>
              setElementByHand(
                session.ydoc,
                selected.id,
                { z: Math.max(0, selected.z - 1) },
                actor
              )
            }
          />
          <Button
            size="xs"
            variant="ghost"
            label="Delete"
            tooltip="Delete (⌫)"
            onClick={() => {
              removeElementByHand(session.ydoc, selected.id);
              setSelectedId(null);
            }}
          />
        </div>
      )}
    </div>
  );
}
