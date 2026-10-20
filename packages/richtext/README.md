# @memo-air/richtext

Rich-text docs: Tiptap/ProseMirror blocks in a Y.Doc, with comments, suggestions and streamed agent
edits.

## Main exports

- Ops: `insertBlocks`, `replaceBlock`, `deleteBlock`, `editBlocks`, `fillBlocks`,
  `streamFrames`.
- Suggestions: `acceptSuggestion`, `rejectSuggestion`, `pendingSuggestions`.
- Comments: `addThread`, `replyToThread`, `setThreadResolved`, `readThreads`.
- Reading and history: `readBlocks`, `readOutline`, `diffOutlines`, `restoreBlocks`,
  `exportMarkdown`, `markdownToNodes`, `nodesToMarkdown`.
- `richTextExtensions()`, `richTextSchema()` — the editor schema shared with the view, built on first call.

## Used by

`@memo-air/server`, `@memo-air/slides` (text elements) and `@memo-air/react`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
