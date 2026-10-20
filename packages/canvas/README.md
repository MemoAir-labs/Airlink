# @memo-air/canvas

The sketch canvas: Excalidraw elements in a Y.Doc, with the ops agents use.

## Main exports

- Ops: `addShapes`, `connect`, `updateShapes`, `deleteShapes`.
- Suggestions: `acceptCanvasSuggestion`, `rejectCanvasSuggestion`, `pendingCanvasSuggestions`,
  `suggestionGhosts`.
- Reading and history: `readCanvas`, `restoreCanvas`, `diffCanvases`, `humanWrittenElements`.

## Used by

`@memo-air/server` applies agents' canvas ops, `@memo-air/tools` reads it for agents, and
`@memo-air/react` draws it with Excalidraw.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
