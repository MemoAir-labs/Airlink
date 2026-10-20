import type { JSONContent } from "@memo-air/richtext";
import type {
  ChartData,
  DeckElementView,
  DeckTheme,
  ElementStyle,
  TableData,
  TextRole,
} from "@memo-air/slides";
import { slideHeight, slideWidth, themeColor } from "@memo-air/slides";
import type { CSSProperties, ReactNode } from "react";

const lineHeights: Record<TextRole, number> = {
  title: 1.05,
  heading: 1.12,
  subtitle: 1.3,
  body: 1.45,
  quote: 1.2,
  caption: 1.35,
};

const weights: Record<TextRole, number> = {
  title: 650,
  heading: 600,
  subtitle: 400,
  body: 400,
  quote: 500,
  caption: 450,
};

function fontStack(font: string) {
  return font === "Georgia"
    ? 'Georgia, "Times New Roman", serif'
    : `${font}, ui-sans-serif, system-ui, sans-serif`;
}

// Type styles come from the deck theme, never from the app theme.
export function textStyle(
  theme: DeckTheme,
  style: ElementStyle
): CSSProperties {
  const role = style.role ?? "body";
  const heading = role === "title" || role === "heading" || role === "quote";
  return {
    fontFamily: fontStack(heading ? theme.fonts.heading : theme.fonts.body),
    fontSize: theme.sizes[role],
    lineHeight: lineHeights[role],
    fontWeight: weights[role],
    letterSpacing: heading ? "-0.02em" : undefined,
    color: themeColor(theme, style.color ?? "text"),
    textAlign: style.align ?? "left",
    display: "flex",
    flexDirection: "column",
    justifyContent:
      style.valign === "bottom"
        ? "flex-end"
        : style.valign === "middle"
          ? "center"
          : "flex-start",
  };
}

export function boxStyle(element: DeckElementView): CSSProperties {
  return {
    position: "absolute",
    left: element.x,
    top: element.y,
    width: element.w,
    height: element.h,
    zIndex: element.z,
    transform: element.rotation ? `rotate(${element.rotation}deg)` : undefined,
  };
}

// The richtext styles shared by static text and the live text editor.
export const slideRichTextClass = [
  "[&_p]:m-0 [&_h1]:m-0 [&_h2]:m-0 [&_h3]:m-0 [&_h1]:text-[1.2em] [&_h1]:font-semibold [&_h2]:text-[1.1em] [&_h2]:font-semibold",
  "[&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-[1.1em] [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-[1.3em] [&_li]:mb-[0.35em] [&_li::marker]:text-[var(--deck-accent)]",
  "[&_blockquote]:m-0 [&_blockquote]:italic [&_code]:font-mono",
  "[&_[data-suggestion-kind=insert]]:rounded-sm [&_[data-suggestion-kind=insert]]:bg-green-500/15 [&_[data-suggestion-kind=insert]]:underline [&_[data-suggestion-kind=insert]]:decoration-green-600 [&_[data-suggestion-kind=insert]]:decoration-[3px]",
  "[&_[data-suggestion-kind=delete]]:line-through [&_[data-suggestion-kind=delete]]:opacity-50",
].join(" ");

export const slideTextClass = `h-full w-full overflow-hidden ${slideRichTextClass}`;

function renderInline(nodes: JSONContent[] | undefined): ReactNode[] {
  return (nodes ?? []).map((node, i) => {
    if (node.type === "hardBreak") {
      return <br key={i} />;
    }
    let content: ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case "bold":
          content = <strong>{content}</strong>;
          break;
        case "italic":
          content = <em>{content}</em>;
          break;
        case "strike":
          content = <s>{content}</s>;
          break;
        case "code":
          content = <code>{content}</code>;
          break;
        default:
          break;
      }
    }
    return <span key={i}>{content}</span>;
  });
}

function suggestionAttrs(node: JSONContent) {
  const kind: unknown = node.attrs?.suggestion?.kind;
  return kind === "insert" || kind === "delete"
    ? { "data-suggestion-kind": kind }
    : {};
}

function renderBlock(node: JSONContent, key: number): ReactNode {
  const attrs = suggestionAttrs(node);
  switch (node.type) {
    case "heading":
      return (
        <h2 key={key} {...attrs}>
          {renderInline(node.content)}
        </h2>
      );
    case "bulletList":
      return (
        <ul key={key} {...attrs}>
          {(node.content ?? []).map((item, i) => (
            <li key={i}>{(item.content ?? []).map(renderBlock)}</li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={key} {...attrs}>
          {(node.content ?? []).map((item, i) => (
            <li key={i}>{(item.content ?? []).map(renderBlock)}</li>
          ))}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote key={key} {...attrs}>
          {(node.content ?? []).map(renderBlock)}
        </blockquote>
      );
    case "codeBlock":
      return (
        <pre key={key} {...attrs}>
          <code>{renderInline(node.content)}</code>
        </pre>
      );
    case "horizontalRule":
      return <hr key={key} />;
    default:
      return (
        <p key={key} {...attrs}>
          {renderInline(node.content)}
        </p>
      );
  }
}

export function RichBlocks({ blocks }: { blocks: JSONContent[] }) {
  return <>{blocks.map(renderBlock)}</>;
}

// Rounds an axis maximum up to 1, 2 or 5 × 10ⁿ so the gridlines land on round numbers.
function niceCeiling(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * power >= value) ?? 10;
  return step * power;
}

interface ChartViewProps {
  data: ChartData;
  theme: DeckTheme;
  width: number;
  height: number;
}

export function ChartView({ data, theme, width, height }: ChartViewProps) {
  const colors = [
    theme.palette.accent,
    theme.palette.muted,
    theme.palette.text,
  ];
  const pad = { left: 80, right: 24, top: 24, bottom: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = data.series.flatMap((series) => series.values);
  const max = niceCeiling(Math.max(1, ...values));
  const labelStyle = {
    fill: theme.palette.muted,
    fontSize: theme.sizes.caption * 0.8,
    fontFamily: fontStack(theme.fonts.body),
  };
  if (data.chart === "pie") {
    const series = data.series[0];
    const total =
      series?.values.reduce((sum, v) => sum + Math.max(v, 0), 0) || 1;
    const r = Math.min(width, height) / 2 - 24;
    let angle = -Math.PI / 2;
    return (
      <svg width={width} height={height} role="img" aria-label="Pie chart">
        {(series?.values ?? []).map((value, i) => {
          const sweep = (Math.max(value, 0) / total) * Math.PI * 2;
          const start = angle;
          angle += sweep;
          const cx = width / 2;
          const cy = height / 2;
          const large = sweep > Math.PI ? 1 : 0;
          const path = `M ${cx} ${cy} L ${cx + r * Math.cos(start)} ${cy + r * Math.sin(start)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} Z`;
          return (
            <path
              key={i}
              d={path}
              fill={colors[i % colors.length]}
              opacity={1 - (i % 4) * 0.18}
              stroke={theme.palette.background}
              strokeWidth={4}
            />
          );
        })}
      </svg>
    );
  }
  const groupW = plotW / Math.max(data.labels.length, 1);
  const x = (i: number) => pad.left + groupW * i + groupW / 2;
  const y = (v: number) => pad.top + plotH - (v / max) * plotH;
  return (
    <svg width={width} height={height} role="img" aria-label="Chart">
      {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
        <g key={t}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(max * t)}
            y2={y(max * t)}
            stroke={theme.palette.border}
            strokeWidth={2}
          />
          <text
            x={pad.left - 12}
            y={y(max * t) + 8}
            textAnchor="end"
            style={labelStyle}
          >
            {Math.round(max * t).toLocaleString()}
          </text>
        </g>
      ))}
      {data.labels.map((label, i) => (
        <text
          key={label}
          x={x(i)}
          y={height - 20}
          textAnchor="middle"
          style={labelStyle}
        >
          {label}
        </text>
      ))}
      {data.chart === "bar"
        ? data.series.map((series, s) => {
            const barW = (groupW * 0.7) / data.series.length;
            return series.values.map((value, i) => (
              <rect
                key={`${s}-${i}`}
                x={x(i) - (groupW * 0.7) / 2 + barW * s}
                y={y(value)}
                width={barW - 6}
                height={pad.top + plotH - y(value)}
                rx={6}
                fill={colors[s % colors.length]}
              />
            ));
          })
        : data.series.map((series, s) => (
            <polyline
              key={s}
              fill="none"
              stroke={colors[s % colors.length]}
              strokeWidth={6}
              strokeLinejoin="round"
              points={series.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
          ))}
    </svg>
  );
}

interface TableViewProps {
  data: TableData;
  theme: DeckTheme;
}

export function TableView({ data, theme }: TableViewProps) {
  return (
    <table
      className="h-full w-full border-collapse"
      style={{
        fontFamily: fontStack(theme.fonts.body),
        fontSize: theme.sizes.caption,
        color: theme.palette.text,
      }}
    >
      <tbody>
        {data.rows.map((row, r) => (
          <tr
            key={r}
            style={{ borderBottom: `2px solid ${theme.palette.border}` }}
          >
            {row.map((cell, c) => (
              <td
                key={c}
                className="px-4 py-3 text-left"
                style={
                  data.header && r === 0
                    ? { fontWeight: 600, background: theme.palette.surface }
                    : undefined
                }
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface ElementBodyProps {
  element: DeckElementView;
  theme: DeckTheme;
  blocks: JSONContent[];
}

// What an element shows when it is not being edited.
export function ElementBody({ element, theme, blocks }: ElementBodyProps) {
  const data = element.data;
  switch (element.kind) {
    case "text":
      return (
        <div className={slideTextClass} style={textStyle(theme, element.style)}>
          <RichBlocks blocks={blocks} />
        </div>
      );
    case "shape": {
      const shape = data && "shape" in data ? data.shape : "rect";
      const fill = themeColor(theme, element.style.fill) ?? "transparent";
      const stroke = themeColor(theme, element.style.stroke);
      return shape === "line" ? (
        <svg width={element.w} height={element.h}>
          <line
            x1={0}
            y1={element.h / 2}
            x2={element.w}
            y2={element.h / 2}
            stroke={stroke ?? theme.palette.muted}
            strokeWidth={4}
          />
        </svg>
      ) : (
        <div
          className="h-full w-full"
          style={{
            background: fill,
            opacity: element.style.opacity,
            border: stroke ? `3px solid ${stroke}` : undefined,
            borderRadius:
              shape === "ellipse" ? "50%" : (element.style.radius ?? 0),
          }}
        />
      );
    }
    case "chart":
      return data && "chart" in data ? (
        <ChartView
          data={data}
          theme={theme}
          width={element.w}
          height={element.h}
        />
      ) : null;
    case "table":
      return data && "rows" in data ? (
        <TableView data={data} theme={theme} />
      ) : null;
    case "image":
      return data && "url" in data && /^https:\/\//.test(data.url) ? (
        <img
          src={data.url}
          alt={data.alt}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            background: theme.palette.surface,
            color: theme.palette.muted,
          }}
        >
          {data && "alt" in data ? data.alt : "Image"}
        </div>
      );
  }
}

// Bullet markers take the deck's accent through a CSS variable.
export function deckVars(theme: DeckTheme): Record<"--deck-accent", string> {
  return { "--deck-accent": theme.palette.accent };
}

interface SlideSurfaceProps {
  theme: DeckTheme;
  scale: number;
  children: ReactNode;
  className?: string;
}

// A 1920×1080 slide drawn at `scale`, with the deck's background and accent variable.
export function SlideSurface({
  theme,
  scale,
  children,
  className,
}: SlideSurfaceProps) {
  return (
    <div
      className={className}
      style={{
        width: slideWidth * scale,
        height: slideHeight * scale,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        style={{
          width: slideWidth,
          height: slideHeight,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          background: theme.palette.background,
          ...deckVars(theme),
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface StaticSlideProps {
  elements: DeckElementView[];
  blocks: Map<string, JSONContent[]>;
  theme: DeckTheme;
  scale: number;
  className?: string;
}

export function StaticSlide({
  elements,
  blocks,
  theme,
  scale,
  className,
}: StaticSlideProps) {
  return (
    <SlideSurface theme={theme} scale={scale} className={className}>
      {elements.map((element) => (
        <div key={element.id} style={boxStyle(element)}>
          <ElementBody
            element={element}
            theme={theme}
            blocks={blocks.get(element.id) ?? []}
          />
        </div>
      ))}
    </SlideSurface>
  );
}
