import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";

const maxChars = 100_000;

const textTypes = [
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/javascript",
  "application/x-sh",
];
const textExtensions =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|sql|sh|toml|ini|log)$/i;
const xlsxType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const cap = (text: string) =>
  text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[Cut at ${maxChars} characters of ${text.length}.]`
    : text;

const cellText = (value: ExcelJS.CellValue): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if ("result" in value) {
    return cellText(value.result ?? null);
  }
  if ("richText" in value) {
    return value.richText.map((run) => run.text).join("");
  }
  if ("text" in value) {
    return String(value.text);
  }
  return "";
};

// An uploaded file as an agent reads it: text as it is, a PDF's text page by page, a workbook as
// one CSV block per sheet. Anything else is named but not read.
export async function fileText(file: {
  name: string;
  mime: string;
  bytes: Buffer;
}): Promise<{ ok: boolean; text: string }> {
  const { name, mime, bytes } = file;
  if (
    mime.startsWith("text/") ||
    textTypes.includes(mime) ||
    textExtensions.test(name)
  ) {
    return { ok: true, text: cap(bytes.toString("utf8")) };
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text
      .map((page, index) => `--- Page ${index + 1} ---\n${page}`)
      .join("\n\n");
    return pages.trim()
      ? { ok: true, text: cap(pages) }
      : {
          ok: false,
          text: `${name} has no text layer (likely a scan); it cannot be read as text.`,
        };
  }
  if (mime === xlsxType || /\.xlsx$/i.test(name)) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
    const sheets = workbook.worksheets.map((sheet) => {
      const rows: string[] = [];
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        rows.push(
          values
            .map((value) => JSON.stringify(cellText(value ?? null)))
            .join(",")
        );
      });
      return `--- Sheet "${sheet.name}" ---\n${rows.join("\n")}`;
    });
    return { ok: true, text: cap(sheets.join("\n\n")) };
  }
  return {
    ok: false,
    text: `${name} (${mime}) is not a format that can be read as text yet: text, PDF and .xlsx can.`,
  };
}
