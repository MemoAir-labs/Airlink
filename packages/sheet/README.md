# @memo-air/sheet

Spreadsheets: cells, formulas and column formats in a Y.Doc.

## Main exports

- `.` — `setRange`, `addRows`, `deleteRows`, `formatColumns`; `readGrid`, `evaluate`,
  `formatValue`, `parseRange`, `columnLetter`; `acceptSheetSuggestion`,
  `rejectSheetSuggestion`, `pendingSheetSuggestions`; `restoreSheet`, `diffSheets`,
  `humanWrittenCells`.
- `./xlsx` — `toXlsx`, the `.xlsx` export.

## Used by

`@memo-air/server`, `@memo-air/tools` and `@memo-air/react`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
