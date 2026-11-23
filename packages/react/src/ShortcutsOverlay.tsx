import { useEffect, useRef, useState } from "react";
import { Icon, XClose } from "./ui";

// Dispatched on `window` to open the overlay from a control, e.g. an object's ⋯ menu.
export const openShortcutsEvent = "memo-air:open-shortcuts";

type ShortcutRow = { keys: string; action: string };

// The keys the live views answer to, grouped by where they work. They are checked inside each
// view's own key handler; a handler that changes its keys changes this list too.
const groups: { title: string; rows: ShortcutRow[] }[] = [
  {
    title: "Everywhere",
    rows: [
      { keys: "?", action: "Show or hide this list" },
      { keys: "Esc", action: "Close a dialog or menu, or clear a selection" },
    ],
  },
  {
    title: "Space",
    rows: [
      {
        keys: "← ↑ → ↓",
        action: "Move the focused window — focus its title bar first",
      },
      { keys: "Shift + ← ↑ → ↓", action: "Resize the focused window" },
      { keys: "Enter / Space", action: "Open a desktop icon" },
      { keys: "⌫", action: "Move a desktop icon to the bin" },
      { keys: "Ctrl / ⌘ + scroll", action: "Zoom the board" },
    ],
  },
  {
    title: "Slides",
    rows: [
      { keys: "Enter", action: "Edit the selected text element" },
      { keys: "⌘D", action: "Duplicate the selected element" },
      { keys: "] / [", action: "Bring forward / send backward" },
      { keys: "⌫", action: "Delete the selected element" },
      { keys: "Esc", action: "Deselect, or stop editing text" },
    ],
  },
  {
    title: "Presenting",
    rows: [
      { keys: "→ ↓ Space PgDn", action: "Next slide" },
      { keys: "← ↑ PgUp", action: "Previous slide" },
      { keys: "Esc", action: "Leave the presentation" },
    ],
  },
  {
    title: "Sheets",
    rows: [
      { keys: "← ↑ → ↓ / Tab", action: "Move the selection" },
      { keys: "Enter / F2", action: "Edit the selected cell" },
      { keys: "Any key", action: "Start editing the selected cell" },
      { keys: "⌫", action: "Clear the selected cell" },
      { keys: "Esc", action: "Cancel the edit" },
      { keys: "⌥↵ / ⌥⌫", action: "Accept / reject the selected suggestion" },
    ],
  },
  {
    title: "Docs and canvas",
    rows: [
      { keys: "⌘↵", action: "Post a comment" },
      { keys: "⌥↵ / ⌥⌫", action: "Accept / reject a suggestion" },
    ],
  },
];

// `?` (Shift+/) toggles a dialog listing the keys the live views answer to. The host's provider
// mounts it once; a view's own key handler wins when it consumed the key (the sheet's type-to-edit
// or the keys a browser or desktop forwards), and typing somewhere never opens it.
export function ShortcutsOverlay() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "?" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.defaultPrevented
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(openShortcutsEvent, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(openShortcutsEvent, show);
    };
  }, []);

  useEffect(() => {
    if (open) {
      dialogRef.current?.showModal();
    }
  }, [open]);

  if (!open) {
    return null;
  }
  return (
    <dialog
      ref={dialogRef}
      aria-label="Keyboard shortcuts"
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-2xl border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm dark:border-border-night dark:bg-background-night"
      onClose={() => setOpen(false)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dialogRef.current?.close();
        }
      }}
    >
      <div className="flex max-h-[min(560px,calc(100vh-64px))] flex-col">
        <header className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-xl font-bold">Keyboard shortcuts</h2>
          <button
            type="button"
            aria-label="Close"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon visual={XClose} size="sm" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto px-6 pb-5">
          {groups.map((group) => (
            <section key={group.title} className="mt-4 first:mt-0">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground dark:text-muted-foreground-night">
                {group.title}
              </h3>
              <ul className="mt-1.5">
                {group.rows.map((row) => (
                  <li
                    key={row.action}
                    className="flex items-center justify-between gap-4 border-b border-border py-1.5 last:border-0 dark:border-border-night"
                  >
                    <span className="text-sm text-foreground dark:text-foreground-night">
                      {row.action}
                    </span>
                    <kbd className="shrink-0 whitespace-nowrap rounded-md border border-border bg-muted-background px-1.5 py-0.5 font-mono text-xs text-foreground dark:border-border-night dark:bg-muted-background-night dark:text-foreground-night">
                      {row.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </dialog>
  );
}
