import type { RefObject } from "react";
import { createContext, useEffect, useState } from "react";

// An agent works through ops, not a mouse, so it has no pointer of its own. Each view marks
// where it draws an agent's presence (a doc caret, a sheet cell, a slide element) with
// `agentMark(...)`; this layer, laid over the views, draws a mouse cursor that glides to each
// mark with the agent's name and what it is doing there, so a person can follow it the way they
// follow another person's pointer.

// A space draws one layer over all its windows, so a window inside it draws none of its own.
export const InsideSpace = createContext(false);

export type AgentAction =
  | "typing"
  | "editing"
  | "reading"
  | "creating"
  | "pointing";

export function agentMark({
  name,
  color,
  action,
}: {
  name: string;
  color: string;
  action: AgentAction;
}): Record<string, string> {
  return {
    "data-agent-mark": name,
    "data-agent-color": color,
    "data-agent-action": action,
  };
}

// The same mark for a view that builds its DOM by hand (the doc's caret), as a dataset.
export const agentMarkData = (mark: {
  name: string;
  color: string;
  action: AgentAction;
}) => ({
  agentMark: mark.name,
  agentColor: mark.color,
  agentAction: mark.action,
});

type Cursor = {
  name: string;
  color: string;
  action: AgentAction;
  where: string | null;
  x: number;
  y: number;
  seenAtMs: number;
};

// The colour live-server gives an agent that names none of its own.
export const agentCursorColor = "#6d28d9";

const scanMs = 120;
// A mark disappears a moment after the agent's last op; the cursor stays for that moment, then
// fades, so a run of quick edits reads as one cursor moving rather than blinking.
const lingerMs = 1500;

const actionLabel: Record<AgentAction, string> = {
  typing: "typing",
  editing: "editing",
  reading: "reading",
  creating: "creating",
  pointing: "here",
};

// "creating" leads only for the short beat a host shows it (dock tile, then the new window's
// bar); the agent's real work, which may already be landing, takes over right after.
const actionRank: Record<AgentAction, number> = {
  creating: 4,
  reading: 3,
  typing: 2,
  editing: 2,
  pointing: 1,
};
const barOffsetPx = 18;

const isAgentAction = (value: string | undefined): value is AgentAction =>
  value !== undefined && value in actionLabel;

export function AgentCursors({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());

  useEffect(() => {
    const scan = () => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const box = container.getBoundingClientRect();
      const nowMs = Date.now();
      setCursors((previous) => {
        const next = new Map(
          [...previous].filter(
            ([, cursor]) => nowMs - cursor.seenAtMs < lingerMs
          )
        );
        // One cursor per agent: of all its marks this scan, the most telling one — a creation the
        // host is showing, then what it just read, then where it writes.
        const rankThisScan = new Map<string, number>();
        for (const mark of container.querySelectorAll<HTMLElement>(
          "[data-agent-mark]"
        )) {
          const rect = mark.getBoundingClientRect();
          const outside =
            rect.bottom < box.top ||
            rect.top > box.bottom ||
            rect.right < box.left ||
            rect.left > box.right;
          if ((rect.width === 0 && rect.height === 0) || outside) {
            continue;
          }
          const name = mark.dataset.agentMark ?? "";
          const rawAction = mark.dataset.agentAction;
          const action = isAgentAction(rawAction) ? rawAction : "pointing";
          const rank = actionRank[action];
          if ((rankThisScan.get(name) ?? -1) > rank) {
            continue;
          }
          rankThisScan.set(name, rank);
          // A mark scrolled out of its object's view would float outside it; the cursor waits
          // on the object's bar instead.
          const object = mark.closest<HTMLElement>("[data-object-title]");
          const frame = object?.getBoundingClientRect();
          const clipped =
            frame !== undefined &&
            (rect.bottom < frame.top ||
              rect.top > frame.bottom ||
              rect.right < frame.left ||
              rect.left > frame.right);
          next.set(name, {
            name,
            color: mark.dataset.agentColor ?? agentCursorColor,
            action,
            where: object?.dataset.objectTitle ?? null,
            x:
              (clipped && frame
                ? frame.left + frame.width / 2
                : rect.left + rect.width / 2) - box.left,
            y:
              (clipped && frame
                ? frame.top + barOffsetPx
                : rect.top + rect.height / 2) - box.top,
            seenAtMs: nowMs,
          });
        }
        return next;
      });
    };
    const timer = setInterval(scan, scanMs);
    return () => clearInterval(timer);
  }, [containerRef]);

  return (
    <>
      {[...cursors.values()].map((cursor) => {
        const fading = Date.now() - cursor.seenAtMs > scanMs * 2;
        return (
          <div
            key={cursor.name}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 z-[1020] transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none"
            style={{
              transform: `translate(${cursor.x}px, ${cursor.y}px)`,
              opacity: fading ? 0 : 1,
            }}
          >
            <CursorMark
              color={cursor.color}
              label={cursor.name}
              detail={`${actionLabel[cursor.action]}${cursor.where ? ` in ${cursor.where}` : ""}`}
            />
          </div>
        );
      })}
    </>
  );
}

// A participant's pointer: a notched arrow outlined in white with a name pill tucked under it,
// the same for people and agents so the two read as one kind of presence.
export function CursorMark({
  color,
  label,
  detail,
}: {
  color: string;
  label: string;
  detail?: string;
}) {
  return (
    <>
      <svg
        width={18}
        height={22}
        viewBox="0 0 18 22"
        aria-hidden
        className="-mt-px -ml-px block drop-shadow"
      >
        <path
          d="M1.5 1.5v16l4.4-4.1 7.1-.4z"
          fill={color}
          stroke="white"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="-mt-0.5 ml-2.5 inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium text-white shadow-md"
        style={{ background: color }}
      >
        {label}
        {detail && <span className="font-normal"> · {detail}</span>}
      </span>
    </>
  );
}

// Your own pointer, drawn by the browser so it never lags: the same arrow with a "You" pill.
// Anything with a cursor of its own (text, a window's title bar, a resize handle) keeps it.
export function selfCursor(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="42" viewBox="0 0 48 42"><path d="M1.5 1.5v16l4.4-4.1 7.1-.4z" fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><rect x="10" y="20" width="34" height="20" rx="6" fill="${color}"/><text x="27" y="34" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="500" fill="white">You</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 2 2, default`;
}

// Where an agent that is only reading an object sits: on the object's bar, so a person sees which
// object it is looking at before it writes anything. Each object view puts it among its actions.
export function AgentReadingMarks({
  peers,
}: {
  peers: {
    clientId: number;
    name: string;
    color: string;
    kind: string;
    reading: boolean;
  }[];
}) {
  return (
    <>
      {peers
        .filter((peer) => peer.kind === "agent" && peer.reading)
        .map((peer) => (
          <span
            key={peer.clientId}
            aria-hidden
            className="inline-block h-px w-px"
            {...agentMark({
              name: peer.name,
              color: peer.color,
              action: "reading",
            })}
          />
        ))}
    </>
  );
}
