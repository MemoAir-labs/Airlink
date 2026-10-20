import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { fileText } from "./extract.ts";

// One page saying "Acme renews in March"; pdf.js rebuilds the cross-reference table it lacks.
const pdf = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    "4 0 obj << /Length 52 >> stream",
    "BT /F1 12 Tf 20 50 Td (Acme renews in March) Tj ET",
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n")
);

describe("fileText", () => {
  it("reads text, a PDF's pages and a workbook's sheets, and names what it cannot read", async () => {
    expect(
      await fileText({
        name: "notes.md",
        mime: "text/markdown",
        bytes: Buffer.from("# Vendors\nAcme"),
      })
    ).toEqual({ ok: true, text: "# Vendors\nAcme" });

    const fromPdf = await fileText({
      name: "contract.pdf",
      mime: "application/pdf",
      bytes: pdf,
    });
    expect(fromPdf.ok).toBe(true);
    expect(fromPdf.text).toContain("--- Page 1 ---");
    expect(fromPdf.text).toContain("Acme renews in March");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Costs");
    sheet.addRow(["Vendor", "Cost"]);
    sheet.addRow(["Acme", 1200]);
    expect(
      await fileText({
        name: "costs.xlsx",
        mime: "application/octet-stream",
        bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
      })
    ).toEqual({
      ok: true,
      text: '--- Sheet "Costs" ---\n"Vendor","Cost"\n"Acme","1200"',
    });

    expect(
      await fileText({
        name: "photo.png",
        mime: "image/png",
        bytes: Buffer.from([1, 2, 3]),
      })
    ).toMatchObject({ ok: false });
  });
});
