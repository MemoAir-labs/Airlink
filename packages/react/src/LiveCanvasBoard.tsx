import "@excalidraw/excalidraw/index.css";

import {
  CaptureUpdateAction,
  Excalidraw,
  restoreElements,
} from "@excalidraw/excalidraw";
import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { CanvasElement } from "@memo-air/canvas";
import {
  canvasElements,
  canvasSuggestions,
  ghostPrefix,
  isCanvasElement,
  pendingCanvasSuggestions,
  suggestionGhosts,
  writeLocalElements,
} from "@memo-air/canvas";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { LivePeer } from "./useLiveDocSession";

// Excalidraw's stylesheet is unlayered, so it outranks Tailwind's layered utilities; these
// overrides stay unlayered and scoped to the live board. The room has no Excalidraw library and
// does not need the "move canvas" hint. Inline, so the published bundle has no CSS file of its own.
const boardCss =
  ".live-canvas-board .excalidraw .HintViewer, .live-canvas-board .excalidraw .default-sidebar-trigger { display: none; }";

const pointerIntervalMs = 50;

// restoreElements is Excalidraw's own validator: it fills any field the stored JSON lacks and
// re-measures text the server sized by estimate.
function toScene(elements: CanvasElement[]) {
  return restoreElements(JSON.parse(JSON.stringify(elements)), null, {
    refreshDimensions: true,
    repairBindings: true,
  });
}

// The doc's elements plus pending suggestions drawn as ghosts.
function sceneOf(ydoc: Y.Doc) {
  const elements = canvasElements(ydoc);
  return toScene([
    ...elements.values(),
    ...suggestionGhosts(
      pendingCanvasSuggestions(ydoc),
      new Map(elements.entries())
    ),
  ]);
}

function versionsOf(scene: readonly { id: string; version: number }[]) {
  return new Map(scene.map((element) => [element.id, element.version]));
}

const isSocketId = (id: string): id is SocketId => id.length > 0;

function collaboratorsOf(peers: LivePeer[]): Map<SocketId, Collaborator> {
  const collaborators = new Map<SocketId, Collaborator>();
  for (const peer of peers) {
    const id = String(peer.clientId);
    if (!peer.pointer || !isSocketId(id)) {
      continue;
    }
    collaborators.set(id, {
      id,
      username: peer.kind === "agent" ? `✦ ${peer.name}` : peer.name,
      color: { background: peer.color, stroke: peer.color },
      pointer: { ...peer.pointer, tool: "pointer" },
    });
  }
  return collaborators;
}

export interface LiveCanvasBoardProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  peers: LivePeer[];
  canEdit: boolean;
  isDark: boolean;
  user: { id: string; name: string; color: string };
  onApi: (api: ExcalidrawImperativeAPI) => void;
}

export default function LiveCanvasBoard({
  ydoc,
  provider,
  peers,
  canEdit,
  isDark,
  user,
  onApi,
}: LiveCanvasBoardProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const lastPointerAtRef = useRef(0);
  // The version of each element as last drawn from the doc; onChange skips those, so a scene
  // Excalidraw re-measured on load is never written back as this person's edit.
  const renderedRef = useRef(new Map<string, number>());

  useEffect(() => {
    provider.setAwarenessField("user", {
      id: user.id,
      name: user.name,
      color: user.color,
      kind: "human",
    });
  }, [provider, user]);

  // Excalidraw replaces the scene once it finishes loading, so the first scene goes in as
  // initialData; updateScene only carries later changes.
  const [initialData] = useState(() => {
    const elements = sceneOf(ydoc);
    renderedRef.current = versionsOf(elements);
    return { elements, scrollToContent: true };
  });

  useEffect(() => {
    if (!api) {
      return;
    }
    const elements = canvasElements(ydoc);
    const suggestions = canvasSuggestions(ydoc);
    const render = () => {
      const scene = sceneOf(ydoc);
      renderedRef.current = versionsOf(scene);
      api.updateScene({
        elements: scene,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    // This person's own edits are already on screen; redrawing them mid-drag would only jitter.
    const onElements = (event: Y.YMapEvent<CanvasElement>) => {
      if (!event.transaction.local) {
        render();
      }
    };
    // Open on the whole drawing rather than the scene origin.
    const fit = requestAnimationFrame(() =>
      api.scrollToContent(undefined, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
      })
    );
    elements.observe(onElements);
    suggestions.observe(render);
    return () => {
      cancelAnimationFrame(fit);
      elements.unobserve(onElements);
      suggestions.unobserve(render);
    };
  }, [api, ydoc]);

  useEffect(() => {
    api?.updateScene({
      collaborators: collaboratorsOf(peers),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [api, peers]);

  return (
    <div className="live-canvas-board h-full w-full">
      <style>{boardCss}</style>
      <Excalidraw
        excalidrawAPI={(instance) => {
          setApi(instance);
          onApi(instance);
        }}
        initialData={initialData}
        theme={isDark ? "dark" : "light"}
        viewModeEnabled={!canEdit}
        isCollaborating
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            clearCanvas: false,
            // The app owns the theme and background.
            toggleTheme: false,
            changeViewBackgroundColor: false,
          },
          // Images live in Excalidraw's own file store, which is not synced to the doc.
          tools: { image: false },
        }}
        onChange={(elements) => {
          if (!canEdit) {
            return;
          }
          writeLocalElements(
            ydoc,
            elements
              .filter(isCanvasElement)
              .filter(
                (element) =>
                  !element.id.startsWith(ghostPrefix) &&
                  renderedRef.current.get(element.id) !== element.version
              ),
            { kind: "human", id: user.id, name: user.name }
          );
        }}
        onPointerUpdate={({ pointer }) => {
          const now = Date.now();
          if (now - lastPointerAtRef.current < pointerIntervalMs) {
            return;
          }
          lastPointerAtRef.current = now;
          provider.setAwarenessField("pointer", { x: pointer.x, y: pointer.y });
        }}
      />
    </div>
  );
}
