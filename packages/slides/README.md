# @memo-air/slides

Slide decks: slides, elements (text, charts, images, tables, shapes) and themes in a Y.Doc.

## Main exports

- `.` — `addSlide`, `updateSlide`, `moveSlide`, `deleteSlide`, `setTheme`, `addElement`,
  `editElement`; `deckThemes`, `deckLayouts`; `readDeck`, `restoreSlides`, `diffSlides`;
  `acceptSlideSuggestion`, `rejectSlideSuggestion`, `pendingSlideSuggestions`.
- `./pptx` — `toPptx`, the `.pptx` export.
- `./migrate` — `needsDeckMigration`, `migrateCanvasDeck` for older decks.

## Used by

`@memo-air/server`, `@memo-air/tools` and `@memo-air/react`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
