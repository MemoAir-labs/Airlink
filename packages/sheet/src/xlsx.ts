import ExcelJS from "exceljs";
import type * as Y from "yjs";

import type { CellFormat, CellValue } from "./index.ts";
import { evaluate, literalValue, readGrid } from "./index.ts";

const numberFormats: Record<CellFormat, string | undefined> = {
  text: "@",
  number: "#,##0.##",
  currency: '"$"#,##0.00',
  percent: "0.##%",
  date: "yyyy-mm-dd",
};

function cachedResult(value: CellValue): ExcelJS.CellFormulaValue["result"] {
  if (value === null) {
    return undefined;
  }
  return typeof value === "object" ? { error: "#VALUE!" } : value;
}

// Formulas go in as formulas with their computed values cached, so Excel shows numbers before it
// recalculates and keeps the live sheet's logic.
export async function toXlsx(doc: Y.Doc, title: string): Promise<Buffer> {
  const grid = readGrid(doc);
  const values = evaluate(grid.inputs);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(
    title.slice(0, 31).replace(/[\\/?*[\]:]/g, "-") || "Sheet1"
  );
  grid.columns.forEach((meta, c) => {
    const column = sheet.getColumn(c + 1);
    column.width = meta.width ? Math.round(meta.width / 7) : 14;
    const numFmt = meta.format ? numberFormats[meta.format] : undefined;
    if (numFmt) {
      column.numFmt = numFmt;
    }
  });
  grid.inputs.forEach((row, r) =>
    row.forEach((input, c) => {
      if (input === "") {
        return;
      }
      const cell = sheet.getCell(r + 1, c + 1);
      if (input.startsWith("=") && input.length > 1) {
        cell.value = {
          formula: input.slice(1),
          result: cachedResult(values[r][c]),
        };
      } else {
        const value = literalValue(input);
        cell.value = typeof value === "object" ? input : value;
      }
    })
  );
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
