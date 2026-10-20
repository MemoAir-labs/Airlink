import { AnimatePresence, m } from "motion/react";
import {
  Avatar,
  Canvas,
  Cursor,
  Line,
  type SceneProps,
  spring,
  Typed,
  useSequence,
  Win,
} from "./parts.tsx";

const suggestion = "the price from the pricing sheet, per seat";
const durationsMs = [500, 900, 1900, 900, 900, 260, 2800];

const agentAt = [
  { x: 900, y: 560, visible: false },
  { x: 470, y: 268, visible: true },
  { x: 800, y: 268, visible: true },
  { x: 880, y: 540, visible: false },
];
const personAt = [
  { x: 120, y: 580, visible: false },
  { x: 712, y: 350, visible: true },
  { x: 740, y: 430, visible: true },
];

export default function AgentSuggest(props: SceneProps) {
  const step = useSequence(durationsMs, props);
  const accepted = step >= 6;
  const agent = agentAt[Math.min(step, 3)];
  const person = personAt[step < 4 ? 0 : step < 6 ? 1 : 2];
  return (
    <Canvas
      width={960}
      height={600}
      style={{
        background:
          "linear-gradient(160deg, var(--space-top), var(--space-bottom))",
      }}
    >
      <Win
        title="Launch plan"
        style={{ left: 48, top: 44, width: 864, height: 512 }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 250px",
            height: "100%",
          }}
        >
          <div
            style={{
              padding: "30px 36px",
              display: "grid",
              alignContent: "start",
              gap: 16,
            }}
          >
            <span
              style={{
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              Launch plan
            </span>
            <Line w="78%" />
            <Line w="64%" />
            <span style={{ fontSize: 20, fontWeight: 650, marginTop: 10 }}>
              Pricing
            </span>
            <div style={{ fontSize: 20, lineHeight: 1.5 }}>
              Early access is priced at{" "}
              <span style={{ position: "relative", whiteSpace: "nowrap" }}>
                <m.span
                  initial={false}
                  animate={{ opacity: accepted ? 0 : 1 }}
                  transition={{ duration: 0.4 }}
                  style={{
                    position: "absolute",
                    inset: "-2px -3px",
                    borderRadius: 4,
                    background: "var(--teal-wash)",
                    borderBottom: "2px solid var(--teal)",
                  }}
                />
                <span
                  style={{
                    position: "relative",
                    color: accepted ? "var(--win-ink)" : "var(--teal-ink)",
                    transition: "color 0.4s",
                  }}
                >
                  <Typed
                    text={suggestion}
                    on={step >= 2}
                    stepMs={38}
                    instant={props.reduced}
                  />
                </span>
              </span>
            </div>
            <Line w="70%" />
            <Line w="52%" />
            <span style={{ fontSize: 20, fontWeight: 650, marginTop: 10 }}>
              Owners
            </span>
            <Line w="40%" />
          </div>
          <div style={{ borderLeft: "1px solid var(--win-line)", padding: 18 }}>
            <AnimatePresence>
              {step >= 3 && (
                <m.div
                  layout
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  transition={spring}
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    background: "var(--bg-raised)",
                    boxShadow:
                      "0 0 0 1px var(--win-line), 0 10px 24px -12px rgb(0 0 0 / 0.3)",
                    marginTop: 150,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 16,
                      fontWeight: 650,
                    }}
                  >
                    <Avatar name="Assistant" kind="agent" size={24} />
                    {accepted ? "Accepted" : "Suggestion"}
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    <m.div
                      key={accepted ? "done" : "pending"}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: { duration: 0.12 } }}
                      style={{
                        fontSize: 15,
                        color: "var(--win-muted)",
                        marginTop: 8,
                        lineHeight: 1.45,
                      }}
                    >
                      {accepted
                        ? "Lin accepted the suggestion."
                        : "Assistant has suggest access here. A person decides."}
                    </m.div>
                  </AnimatePresence>
                  {!accepted && (
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <m.span
                        initial={false}
                        animate={{ scale: step === 5 ? 0.92 : 1 }}
                        transition={{
                          type: "spring",
                          stiffness: 600,
                          damping: 20,
                        }}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 8,
                          background: "var(--teal)",
                          color: "var(--on-teal)",
                          fontSize: 15,
                          fontWeight: 650,
                        }}
                      >
                        Accept
                      </m.span>
                      <span
                        style={{
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: "1px solid var(--win-line)",
                          fontSize: 15,
                          fontWeight: 560,
                        }}
                      >
                        Reject
                      </span>
                    </div>
                  )}
                </m.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </Win>
      <Cursor {...agent} label="Assistant" kind="agent" />
      <Cursor {...person} label="Lin" kind="person" pressed={step === 5} />
    </Canvas>
  );
}
