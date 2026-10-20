import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import {
  Avatar,
  type AvatarKind,
  Bars,
  Canvas,
  type SceneProps,
  spring,
  Typed,
  useSequence,
} from "./parts.tsx";

const agentLine =
  "Two things are left: owners in the plan, and the contingency row in the budget, which is still";
const cutAfterWords = 11;
const durationsMs = [500, 1700, 2100, 900, 1500, 1500, 2600];

export default function HuddleBarge(props: SceneProps) {
  const step = useSequence(durationsMs, props);
  const speaker =
    step === 1
      ? "Lin"
      : step === 2
        ? "Assistant"
        : step === 3 || step === 4
          ? "Grace"
          : step === 5
            ? "Assistant"
            : null;
  return (
    <Canvas
      width={960}
      height={600}
      style={{ background: "var(--navy-deep)", color: "var(--navy-ink)" }}
    >
      <div style={{ padding: 40 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 20,
            fontWeight: 650,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 10,
              background: "var(--teal)",
            }}
          />
          Huddle in # launch
          <span
            style={{
              marginLeft: "auto",
              fontSize: 16,
              color: "var(--navy-muted)",
              fontWeight: 450,
            }}
          >
            One speaking floor
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 16,
            marginTop: 24,
          }}
        >
          <Tile name="Lin" kind="p1" on={speaker === "Lin"} />
          <Tile name="Grace" kind="p2" on={speaker === "Grace"} />
          <Tile name="Assistant" kind="agent" on={speaker === "Assistant"} />
        </div>
        <div
          style={{
            marginTop: 24,
            padding: "18px 22px",
            borderRadius: 14,
            background: "rgb(255 255 255 / 0.05)",
            boxShadow: "inset 0 0 0 1px var(--navy-line)",
            display: "grid",
            gap: 12,
            fontSize: 19,
            lineHeight: 1.45,
            minHeight: 236,
            alignContent: "start",
          }}
        >
          <AnimatePresence>
            {step >= 1 && (
              <Said key="l1" who="Lin">
                What's left before we launch?
              </Said>
            )}
            {step >= 2 && (
              <Said key="l2" who="Assistant" agent>
                <Typed
                  text={agentLine}
                  on={step >= 2}
                  by="word"
                  stepMs={150}
                  stopAt={cutAfterWords}
                  instant={props.reduced}
                />
                <AnimatePresence>
                  {step >= 3 && (
                    <m.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={spring}
                      style={{
                        display: "inline-block",
                        marginLeft: 8,
                        fontSize: 14,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: "rgb(255 255 255 / 0.12)",
                        color: "var(--navy-muted)",
                      }}
                    >
                      cut off
                    </m.span>
                  )}
                </AnimatePresence>
              </Said>
            )}
            {step >= 4 && (
              <Said key="l3" who="Grace">
                Hold on, I'll take owners myself.
              </Said>
            )}
            {step >= 5 && (
              <Said key="l4" who="Assistant" agent>
                Got it. Owners stay with Grace.
              </Said>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Canvas>
  );
}

function Said({
  who,
  agent,
  children,
}: {
  who: string;
  agent?: boolean;
  children: ReactNode;
}) {
  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={spring}
    >
      <span
        style={{
          fontWeight: 650,
          color: agent ? "var(--teal)" : "var(--navy-ink)",
        }}
      >
        {who}:{" "}
      </span>
      <span style={{ color: "var(--navy-ink)" }}>{children}</span>
    </m.div>
  );
}

function Tile({
  name,
  kind,
  on,
}: {
  name: string;
  kind: AvatarKind;
  on: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "grid",
        justifyItems: "center",
        gap: 10,
        padding: "22px 10px 16px",
        borderRadius: 16,
        background: "rgb(255 255 255 / 0.06)",
        boxShadow: "inset 0 0 0 1px var(--navy-line)",
        color: kind === "agent" ? "var(--teal)" : "var(--navy-ink)",
      }}
    >
      <m.span
        initial={false}
        animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.97 }}
        transition={{ duration: 0.2 }}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 16,
          boxShadow: "inset 0 0 0 3px var(--teal)",
        }}
      />
      <Avatar name={name} kind={kind} size={58} />
      <span style={{ fontSize: 18, fontWeight: 560, color: "var(--navy-ink)" }}>
        {name}
      </span>
      <Bars on={on} />
    </div>
  );
}
