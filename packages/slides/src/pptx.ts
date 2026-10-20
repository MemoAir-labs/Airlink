import type { JSONContent } from "@memo-air/richtext";
import PptxGenJS from "pptxgenjs";
import type * as Y from "yjs";

import type { DeckElementView, DeckTheme, TextRole } from "./index.ts";
import {
  elementBlocks,
  readDeck,
  readThemeState,
  resolveTheme,
  slideWidth,
  themeColor,
} from "./index.ts";

// LAYOUT_WIDE is 13.333 in across: a 1920 px slide is 144 px per inch, and 1 px of type is ½ pt.
const pxPerInch = slideWidth / 13.333;
const inches = (px: number) => px / pxPerInch;
const points = (px: number) => px / 2;
const imageTimeoutMs = 5000;

const hex = (color: string | undefined): string | undefined =>
  color && /^#[0-9a-f]{6}$/i.test(color)
    ? color.slice(1).toUpperCase()
    : undefined;

function shapeName(element: DeckElementView): PptxGenJS.SHAPE_NAME {
  const shape =
    element.data && "shape" in element.data ? element.data.shape : "rect";
  if (shape === "ellipse" || shape === "line") {
    return shape;
  }
  return element.style.radius ? "roundRect" : "rect";
}

function roleOf(element: DeckElementView): TextRole {
  return element.style.role ?? "body";
}

function fontFor(theme: DeckTheme, role: TextRole): string {
  return role === "title" || role === "heading" || role === "quote"
    ? theme.fonts.heading
    : theme.fonts.body;
}

function marksOf(node: JSONContent): PptxGenJS.TextPropsOptions {
  const marks = node.marks ?? [];
  return {
    ...(marks.some((m) => m.type === "bold") ? { bold: true } : {}),
    ...(marks.some((m) => m.type === "italic") ? { italic: true } : {}),
    ...(marks.some((m) => m.type === "strike") ? { strike: "sngStrike" } : {}),
  };
}

function inlineRuns(
  node: JSONContent,
  base: PptxGenJS.TextPropsOptions
): PptxGenJS.TextProps[] {
  return (node.content ?? []).map((child) => ({
    text: child.type === "hardBreak" ? "\n" : (child.text ?? ""),
    options: { ...base, ...marksOf(child) },
  }));
}

// One block becomes one or more paragraphs of runs; list items become bulleted paragraphs.
function blockRuns(
  block: JSONContent,
  base: PptxGenJS.TextPropsOptions,
  headingSizePt: number
): PptxGenJS.TextProps[] {
  const paragraph = (
    runs: PptxGenJS.TextProps[],
    extra: PptxGenJS.TextPropsOptions = {}
  ): PptxGenJS.TextProps[] => {
    if (runs.length === 0) {
      return [{ text: "", options: { ...base, ...extra, breakLine: true } }];
    }
    return runs.map((run, i) => ({
      ...run,
      options: {
        ...run.options,
        ...extra,
        ...(i === runs.length - 1 ? { breakLine: true } : {}),
      },
    }));
  };
  switch (block.type) {
    case "heading":
      return paragraph(
        inlineRuns(block, { ...base, bold: true, fontSize: headingSizePt })
      );
    case "bulletList":
    case "orderedList":
      return (block.content ?? []).flatMap((item) =>
        (item.content ?? []).flatMap((child) =>
          paragraph(inlineRuns(child, base), {
            bullet: block.type === "orderedList" ? { type: "number" } : true,
            paraSpaceAfter: 6,
          })
        )
      );
    case "blockquote":
      return (block.content ?? []).flatMap((child) =>
        paragraph(inlineRuns(child, { ...base, italic: true }))
      );
    default:
      return paragraph(inlineRuns(block, base));
  }
}

async function imageData(url: string): Promise<string | null> {
  if (!/^https:\/\//.test(url)) {
    return null;
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(imageTimeoutMs),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.startsWith("image/")) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return `${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function toPptx(doc: Y.Doc, title: string): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = title;
  const theme = resolveTheme(readThemeState(doc));
  const deck = readDeck(doc);

  for (const view of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: hex(theme.palette.background) ?? "FFFFFF" };
    slide.hidden = view.hidden;

    for (const element of view.elements) {
      const box = {
        x: inches(element.x),
        y: inches(element.y),
        w: inches(element.w),
        h: inches(element.h),
        rotate: element.rotation,
      };
      const fill = hex(themeColor(theme, element.style.fill));
      const stroke = hex(themeColor(theme, element.style.stroke));
      const data = element.data;
      const transparency =
        element.style.opacity === undefined
          ? 0
          : Math.round((1 - element.style.opacity) * 100);
      if (element.kind === "text") {
        const role = roleOf(element);
        const base: PptxGenJS.TextPropsOptions = {
          bold: role === "title" || role === "heading",
          fontFace: fontFor(theme, role),
          fontSize: points(theme.sizes[role]),
          color:
            hex(themeColor(theme, element.style.color ?? "text")) ?? "111827",
        };
        const blocks = elementBlocks(doc, element.id).filter(
          (block) => block.attrs?.suggestion?.kind !== "insert"
        );
        slide.addText(
          blocks.flatMap((block) =>
            blockRuns(block, base, points(theme.sizes.heading))
          ),
          {
            ...box,
            align: element.style.align ?? "left",
            valign: element.style.valign ?? "top",
            margin: 0,
            fit: "shrink",
          }
        );
      } else if (element.kind === "shape") {
        slide.addShape(shapeName(element), {
          ...box,
          ...(fill ? { fill: { color: fill, transparency } } : {}),
          line: stroke ? { color: stroke, width: 1.5 } : { type: "none" },
        });
      } else if (element.kind === "chart" && data && "chart" in data) {
        slide.addChart(
          data.chart === "line" ? "line" : data.chart === "pie" ? "pie" : "bar",
          data.series.map((series) => ({
            name: series.name,
            labels: data.labels,
            values: series.values,
          })),
          {
            ...box,
            chartColors: [
              theme.palette.accent,
              theme.palette.muted,
              theme.palette.text,
            ].map((color) => hex(color) ?? "2563EB"),
            catAxisLabelColor: hex(theme.palette.muted),
            valAxisLabelColor: hex(theme.palette.muted),
            catAxisLabelFontFace: theme.fonts.body,
            valAxisLabelFontFace: theme.fonts.body,
            showLegend: data.series.length > 1,
            legendFontFace: theme.fonts.body,
            legendColor: hex(theme.palette.text),
            valGridLine: {
              color: hex(theme.palette.border) ?? "E5E7EB",
              size: 1,
            },
          }
        );
      } else if (element.kind === "table" && data && "rows" in data) {
        const { rows, header } = data;
        slide.addTable(
          rows.map((row, r) =>
            row.map((cell) => ({
              text: cell,
              options: {
                bold: header && r === 0,
                fill: {
                  color:
                    hex(
                      header && r === 0
                        ? theme.palette.surface
                        : theme.palette.background
                    ) ?? "FFFFFF",
                },
                color: hex(theme.palette.text),
                fontFace: theme.fonts.body,
                fontSize: points(theme.sizes.caption),
              },
            }))
          ),
          {
            ...box,
            border: {
              type: "solid",
              pt: 0.5,
              color: hex(theme.palette.border),
            },
          }
        );
      } else if (element.kind === "image" && data && "url" in data) {
        const image = await imageData(data.url);
        if (image) {
          slide.addImage({
            ...box,
            data: image,
            sizing: { type: "cover", w: box.w, h: box.h },
          });
        } else {
          slide.addText(data.alt || "Image", {
            ...box,
            fill: { color: hex(theme.palette.surface) ?? "F4F5F7" },
            color: hex(theme.palette.muted),
            fontFace: theme.fonts.body,
            align: "center",
            valign: "middle",
          });
        }
      }
    }
    if (view.notes) {
      slide.addNotes(view.notes);
    }
  }

  const output = await pptx.write({ outputType: "nodebuffer" });
  if (output instanceof Uint8Array) {
    return output;
  }
  throw new Error("pptxgenjs returned no buffer");
}
