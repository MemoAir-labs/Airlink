import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import {
  Canvas,
  Line,
  type SceneProps,
  spring,
  useSequence,
  Win,
} from "./parts.tsx";

type Kind =
  | "doc"
  | "sheet"
  | "slides"
  | "canvas"
  | "file"
  | "browser"
  | "desktop";

const dock: { kind: Kind; hue: number; opensAt?: number }[] = [
  { kind: "doc", hue: 255, opensAt: 1 },
  { kind: "sheet", hue: 150, opensAt: 2 },
  { kind: "canvas", hue: 80, opensAt: 3 },
  { kind: "slides", hue: 35, opensAt: 4 },
  { kind: "browser", hue: 230 },
  { kind: "file", hue: 300, opensAt: 5 },
  { kind: "desktop", hue: 200 },
];

const durationsMs = [700, 550, 550, 550, 550, 550, 900, 900, 1700, 1900];
const fromDock = { y: 180 };
const cells = Array.from({ length: 6 * 13 }, (_, i) => `c${i}`);

const dockList = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.05 } },
};
const dockItem = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0, transition: spring },
};

export default function SpaceKinds(props: SceneProps) {
  const step = useSequence(durationsMs, props);
  const maximized = step === 8;
  return (
    <Canvas
      width={960}
      height={600}
      style={{
        background:
          "linear-gradient(160deg, var(--space-top), var(--space-bottom))",
      }}
    >
      <AnimatePresence>
        {step >= 1 && (
          <Win
            key="doc"
            title="Launch plan"
            from={fromDock}
            style={{ left: 24, top: 28, width: 286, height: 214 }}
          >
            <div style={{ padding: 16, display: "grid", gap: 9 }}>
              <span style={{ fontSize: 19, fontWeight: 700 }}>Launch plan</span>
              <Line w="90%" />
              <Line w="72%" />
              <span
                style={{
                  fontSize: 14,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background: "var(--teal-wash)",
                  width: "fit-content",
                }}
              >
                2 comments · history
              </span>
              <Line w="80%" />
              <Line w="58%" />
            </div>
          </Win>
        )}
        {step >= 3 && (
          <Win
            key="canvas"
            title="Launch flow"
            from={fromDock}
            style={{ left: 24, top: 262, width: 286, height: 200 }}
          >
            <svg
              viewBox="0 0 286 160"
              width="286"
              height="160"
              aria-hidden="true"
            >
              <rect
                x="22"
                y="56"
                width="70"
                height="40"
                rx="8"
                fill="var(--teal-wash)"
                stroke="var(--teal)"
                strokeWidth="1.5"
              />
              <rect
                x="138"
                y="30"
                width="70"
                height="40"
                rx="20"
                fill="none"
                stroke="var(--win-muted)"
                strokeWidth="1.5"
              />
              <rect
                x="138"
                y="96"
                width="70"
                height="40"
                rx="8"
                fill="none"
                stroke="var(--win-muted)"
                strokeWidth="1.5"
              />
              <path
                d="M92 70 C112 70 118 50 136 50 M92 82 C112 82 118 116 136 116"
                stroke="var(--win-muted)"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          </Win>
        )}
        {step >= 5 && (
          <Win
            key="file"
            title="contract.pdf"
            from={fromDock}
            style={{ left: 330, top: 262, width: 240, height: 200 }}
          >
            <div style={{ padding: "16px 22px", display: "grid", gap: 8 }}>
              <div
                style={{
                  height: 120,
                  borderRadius: 6,
                  boxShadow: "0 0 0 1px var(--win-line)",
                  padding: 12,
                  display: "grid",
                  gap: 7,
                  alignContent: "start",
                }}
              >
                <Line w="60%" strong />
                <Line w="92%" />
                <Line w="86%" />
                <Line w="90%" />
                <Line w="40%" />
              </div>
              <span style={{ fontSize: 14, color: "var(--win-muted)" }}>
                PDF · page 1 of 4
              </span>
            </div>
          </Win>
        )}
        {step >= 4 && step < 7 && (
          <Win
            key="slides"
            title="Launch deck"
            from={fromDock}
            style={{ left: 590, top: 262, width: 346, height: 200 }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "70px 1fr",
                gap: 10,
                padding: 12,
              }}
            >
              <div style={{ display: "grid", gap: 6 }}>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{
                      height: 38,
                      borderRadius: 4,
                      boxShadow: `0 0 0 ${i === 0 ? 2 : 1}px ${i === 0 ? "var(--teal)" : "var(--win-line)"}`,
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  borderRadius: 6,
                  boxShadow: "0 0 0 1px var(--win-line)",
                  padding: 16,
                  display: "grid",
                  gap: 8,
                  alignContent: "center",
                }}
              >
                <span style={{ fontSize: 18, fontWeight: 700 }}>
                  Launch plan
                </span>
                <Line w="70%" />
              </div>
            </div>
          </Win>
        )}
        {step >= 6 && (
          <Win
            key="bin"
            title="Bin"
            from={fromDock}
            style={{ left: 670, top: 28, width: 266, height: 214 }}
          >
            <div
              style={{ padding: 14, display: "grid", gap: 10, fontSize: 15 }}
            >
              <span style={{ color: "var(--win-muted)" }}>
                Deleted objects wait here first.
              </span>
              {["Old draft", "Pricing v1"].map((t) => (
                <span
                  key={t}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    borderRadius: 8,
                    boxShadow: "0 0 0 1px var(--win-line)",
                  }}
                >
                  {t}
                  <span style={{ color: "var(--teal-ink)", fontWeight: 600 }}>
                    Restore
                  </span>
                </span>
              ))}
            </div>
          </Win>
        )}
        {step >= 2 && (
          <Win
            key="sheet"
            title="Launch budget"
            from={fromDock}
            layout
            style={
              maximized
                ? { left: 24, top: 24, width: 912, height: 450, zIndex: 3 }
                : { left: 330, top: 28, width: 320, height: 214, zIndex: 1 }
            }
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(6, 120px)",
              }}
            >
              {cells.map((cell) => (
                <span
                  key={cell}
                  style={{
                    height: 30,
                    borderRight: "1px solid var(--win-line)",
                    borderBottom: "1px solid var(--win-line)",
                    fontSize: 14,
                    padding: "0 8px",
                    display: "flex",
                    alignItems: "center",
                    color: "var(--win-muted)",
                  }}
                >
                  {cell === "c2" ? "=SUM(C2:C6)" : ""}
                </span>
              ))}
            </div>
          </Win>
        )}
      </AnimatePresence>

      <m.div
        variants={dockList}
        initial="hidden"
        animate="shown"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 26,
          margin: "0 auto",
          width: "fit-content",
          display: "flex",
          gap: 10,
          padding: 10,
          borderRadius: 18,
          background: "color-mix(in oklch, var(--win) 85%, transparent)",
          boxShadow:
            "0 0 0 1px var(--win-line), 0 18px 40px -16px rgb(0 0 0 / 0.4)",
          zIndex: 4,
        }}
      >
        {dock.map((d) => (
          <DockIcon
            key={d.kind}
            hue={d.hue}
            lifted={d.opensAt === step}
            minimized={d.kind === "slides" && step >= 7}
          >
            <Glyph kind={d.kind} />
          </DockIcon>
        ))}
      </m.div>
    </Canvas>
  );
}

function DockIcon({
  hue,
  lifted,
  minimized,
  children,
}: {
  hue: number;
  lifted: boolean;
  minimized: boolean;
  children: ReactNode;
}) {
  return (
    <m.span variants={dockItem} style={{ position: "relative" }}>
      <m.span
        initial={false}
        animate={{ y: lifted ? -10 : 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 18 }}
        style={{
          width: 50,
          height: 50,
          borderRadius: 13,
          display: "grid",
          placeItems: "center",
          background: `oklch(93% 0.05 ${hue})`,
          color: `oklch(45% 0.13 ${hue})`,
        }}
      >
        {children}
      </m.span>
      <m.span
        initial={false}
        animate={{ opacity: minimized ? 1 : 0, scale: minimized ? 1 : 0 }}
        style={{
          position: "absolute",
          left: 22,
          bottom: -7,
          width: 6,
          height: 6,
          borderRadius: 6,
          background: "var(--teal)",
        }}
      />
    </m.span>
  );
}

function Glyph({ kind }: { kind: Kind }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      {kind === "doc" && (
        <path {...common} d="M7 3h7l4 4v14H7z M10 11h6 M10 15h6 M10 7h2" />
      )}
      {kind === "sheet" && (
        <path {...common} d="M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14" />
      )}
      {kind === "canvas" && (
        <path {...common} d="M4 20l4-1 11-11-3-3L5 16z M14 7l3 3" />
      )}
      {kind === "slides" && (
        <path {...common} d="M3 4h18 M5 4v11h14V4 M12 15v4 M8 20h8" />
      )}
      {kind === "browser" && (
        <path
          {...common}
          d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18"
        />
      )}
      {kind === "file" && (
        <path
          {...common}
          d="M7 3h7l4 4v14H7z M12 17v-6 M9.5 13.5L12 11l2.5 2.5"
        />
      )}
      {kind === "desktop" && (
        <path {...common} d="M3 5h18v11H3z M9 20h6 M12 16v4" />
      )}
    </svg>
  );
}
