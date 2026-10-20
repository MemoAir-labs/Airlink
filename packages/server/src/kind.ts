import { isBrowserDoc } from "@memo-air/browser";
import { canvasElements, canvasSuggestions } from "@memo-air/canvas";
import { isChatDoc } from "@memo-air/chat";
import { isDesktopDoc } from "@memo-air/desktop";
import { isMediaDoc } from "@memo-air/media";
import { docFragment } from "@memo-air/richtext";
import { sheetCols, sheetRows, sheetSuggestions } from "@memo-air/sheet";
import { deckSuggestions, isDeckDoc } from "@memo-air/slides";
import { isSpaceDoc } from "@memo-air/space";
import type * as Y from "yjs";

export type DocKind =
  | "doc"
  | "sheet"
  | "canvas"
  | "slides"
  | "browser"
  | "desktop"
  | "media"
  | "chat"
  | "space";

// Probes read content, never root presence: a live doc grows an empty root whenever a reader
// asks for one, so `share.has` would call every restored text doc a sheet and a deck. A pending
// suggestion is content too: a suggest-only agent's first proposal is all a new deck holds.
export function kindOf(doc: Y.Doc): DocKind {
  if (isDeckDoc(doc) || deckSuggestions(doc).size > 0) {
    return "slides";
  }
  if (canvasElements(doc).size > 0 || canvasSuggestions(doc).size > 0) {
    return "canvas";
  }
  if (
    sheetRows(doc).length > 0 ||
    sheetCols(doc).length > 0 ||
    sheetSuggestions(doc).size > 0
  ) {
    return "sheet";
  }
  if (isBrowserDoc(doc)) {
    return "browser";
  }
  if (isDesktopDoc(doc)) {
    return "desktop";
  }
  if (isMediaDoc(doc)) {
    return "media";
  }
  if (isSpaceDoc(doc)) {
    return "space";
  }
  if (isChatDoc(doc)) {
    return "chat";
  }
  return "doc";
}

// Every kind is born by its first op on an empty doc, so a blank doc fits any route.
export function isBlank(doc: Y.Doc): boolean {
  return kindOf(doc) === "doc" && docFragment(doc).length === 0;
}
