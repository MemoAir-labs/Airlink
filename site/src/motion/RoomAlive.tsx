import { AnimatePresence, m } from "motion/react";
import type { ReactNode } from "react";
import {
  Avatar,
  type AvatarKind,
  Bars,
  Canvas,
  Cursor,
  type SceneProps,
  spring,
  Typed,
  useSequence,
  Win,
} from "./parts.tsx";

const markUrl = `${import.meta.env.BASE_URL}memoair.svg`;

const budget: [string, string, string][] = [
  ["Design", "Marketing", "1,200"],
  ["Demo video", "Marketing", "800"],
  ["Launch ads", "Marketing", "2,500"],
  ["Hosting", "Operations", "300"],
  ["Total", "", "4,800"],
];

const firstRow = 6;
const durationsMs = [
  800, 500, 900, 900, 700, 700, 650, 650, 650, 650, 650, 900, 1000, 1700, 2800,
];

const list = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.06 } },
};
const item = {
  hidden: { opacity: 0, x: -10 },
  shown: { opacity: 1, x: 0, transition: spring },
};

function cursorAt(step: number) {
  if (step < 5) {
    return { x: 1240, y: 760, visible: false };
  }
  if (step === 5) {
    return { x: 1190, y: 175, visible: true };
  }
  if (step < firstRow + budget.length) {
    return { x: 1190, y: 175 + (step - firstRow) * 34, visible: true };
  }
  return { x: 1150, y: 352, visible: true };
}

export default function RoomAlive(props: SceneProps) {
  const step = useSequence(durationsMs, props);
  const cursor = cursorAt(step);
  return (
    <Canvas width={1280} height={800}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          background: "var(--win)",
        }}
      >
        <aside
          style={{
            width: 236,
            background: "var(--navy)",
            color: "var(--navy-ink)",
            padding: "0 14px",
          }}
        >
          <div
            style={{
              height: 60,
              display: "flex",
              alignItems: "center",
              gap: 10,
              borderBottom: "1px solid var(--navy-line)",
              margin: "0 -14px 14px",
              padding: "0 18px",
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                background: "rgb(255 255 255 / 0.1)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <img src={markUrl} alt="" width={30} height={30} />
            </span>
            <span
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.03em",
              }}
            >
              AirLink
            </span>
          </div>
          <m.div variants={list} initial="hidden" animate="shown">
            <SideLabel>Channels</SideLabel>
            {["general", "market", "launch"].map((c) => (
              <m.div
                key={c}
                variants={item}
                style={{
                  position: "relative",
                  height: 38,
                  display: "flex",
                  alignItems: "center",
                  padding: "0 12px",
                  borderRadius: 9,
                  fontSize: 19,
                  fontWeight: c === "launch" ? 650 : 450,
                  color:
                    c === "launch" ? "var(--navy-ink)" : "var(--navy-muted)",
                }}
              >
                {c === "launch" && (
                  <m.span
                    initial={false}
                    animate={{ scaleX: step >= 1 ? 1 : 0 }}
                    transition={spring}
                    style={{
                      position: "absolute",
                      inset: 0,
                      borderRadius: 9,
                      background: "linear-gradient(90deg, #2b5c82, #2a7f88)",
                      transformOrigin: "left",
                    }}
                  />
                )}
                <span style={{ position: "relative" }}># {c}</span>
              </m.div>
            ))}
            <SideLabel>Humans</SideLabel>
            <SidePerson name="Lin" kind="p1" />
            <SidePerson name="Grace" kind="p2" />
            <SideLabel>Agents</SideLabel>
            <SidePerson name="Assistant" kind="agent" />
            <SidePerson name="Researcher" kind="agent" />
          </m.div>
        </aside>

        <section
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <header
            style={{
              height: 60,
              display: "flex",
              alignItems: "center",
              padding: "0 22px",
              borderBottom: "1px solid var(--win-line)",
              fontSize: 22,
              fontWeight: 650,
              color: "var(--win-ink)",
            }}
          >
            # launch
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Pill>Space</Pill>
              <Pill on={step >= 12}>Huddle</Pill>
            </span>
          </header>
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <div
              style={{
                width: 380,
                borderRight: "1px solid var(--win-line)",
                padding: "18px 20px",
                display: "flex",
                flexDirection: "column",
                gap: 18,
                color: "var(--win-ink)",
              }}
            >
              <AnimatePresence>
                {step >= 2 && (
                  <Message
                    key="m1"
                    name="Lin"
                    kind="p1"
                    text="Can someone put the launch budget in a sheet, next to the plan?"
                  />
                )}
                {step >= 3 && (
                  <Message
                    key="m2"
                    name="Assistant"
                    kind="agent"
                    text="Opening a sheet in the space. I'll fill it from the plan."
                  />
                )}
                {step >= 11 && (
                  <Message
                    key="m3"
                    name="Assistant"
                    kind="agent"
                    text="Done. The total is 4,800; contingency is still 0."
                  />
                )}
                {step >= 12 && (
                  <Message
                    key="m4"
                    name="Grace"
                    kind="p2"
                    text="Let's talk it through. Starting a huddle."
                  />
                )}
              </AnimatePresence>
            </div>
            <div
              style={{
                flex: 1,
                background:
                  "linear-gradient(160deg, var(--space-top), var(--space-bottom))",
              }}
            />
          </div>
        </section>
      </div>

      <AnimatePresence>
        {step >= 3 && (
          <Win
            key="doc"
            title="Launch plan"
            style={{ left: 640, top: 92, width: 256, height: 282 }}
          >
            <div style={{ padding: "16px 18px", display: "grid", gap: 10 }}>
              <span style={{ fontSize: 20, fontWeight: 700 }}>Launch plan</span>
              <span style={{ fontSize: 16, fontWeight: 650 }}>Timeline</span>
              {[
                "Record the demo",
                "Write the README",
                "Post the launch",
                "Answer issues",
                "Ship v0.2",
              ].map((t, i) => (
                <span
                  key={t}
                  style={{ fontSize: 15, color: "var(--win-muted)" }}
                >
                  {i + 1}. {t}
                </span>
              ))}
            </div>
          </Win>
        )}
        {step >= 4 && (
          <Win
            key="sheet"
            title="Launch budget"
            style={{ left: 912, top: 92, width: 352, height: 282 }}
          >
            <div style={{ fontSize: 16 }}>
              <Row cells={["Item", "Category", "Amount"]} head />
              {budget.map((r, i) => (
                <Row
                  key={r[0]}
                  cells={r}
                  filled={step >= firstRow + i}
                  reduced={props.reduced}
                  strong={r[0] === "Total"}
                  focus={step === firstRow + i}
                />
              ))}
            </div>
          </Win>
        )}
        {step >= 5 && (
          <Win
            key="canvas"
            title="Launch flow"
            style={{ left: 640, top: 392, width: 256, height: 180 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "40px 18px",
              }}
            >
              <Box label="Demo" />
              <Arrow />
              <Box label="README" />
            </div>
          </Win>
        )}
        {step >= 12 && (
          <Huddle
            key="huddle"
            speaker={step === 13 ? "Grace" : step >= 14 ? "Assistant" : null}
          />
        )}
      </AnimatePresence>

      <Cursor {...cursor} label="Assistant" kind="agent" />
    </Canvas>
  );
}

function Huddle({ speaker }: { speaker: "Grace" | "Assistant" | null }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24, transition: { duration: 0.25 } }}
      transition={spring}
      style={{
        position: "absolute",
        left: 912,
        top: 396,
        width: 352,
        padding: 14,
        borderRadius: 14,
        background: "var(--navy)",
        color: "var(--navy-ink)",
        boxShadow:
          "0 24px 50px -16px rgb(0 0 0 / 0.5), 0 0 0 1px var(--navy-line)",
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
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: "var(--teal)",
          }}
        />
        Huddle
        <span
          style={{
            marginLeft: "auto",
            color: "var(--navy-muted)",
            fontWeight: 450,
          }}
        >
          3 in call
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginTop: 12,
        }}
      >
        <Tile name="Lin" kind="p1" on={false} />
        <Tile name="Grace" kind="p2" on={speaker === "Grace"} />
        <Tile name="Assistant" kind="agent" on={speaker === "Assistant"} />
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 16,
          color: "var(--navy-muted)",
          minHeight: 22,
        }}
      >
        <AnimatePresence mode="wait">
          {speaker && (
            <m.span
              key={speaker}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
            >
              {speaker === "Grace"
                ? "Grace: Is contingency really zero?"
                : "Assistant: It is. I'll leave a note on that row."}
            </m.span>
          )}
        </AnimatePresence>
      </div>
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
        gap: 6,
        padding: "12px 6px 8px",
        borderRadius: 10,
        background: "rgb(255 255 255 / 0.06)",
        color: kind === "agent" ? "var(--teal)" : "var(--navy-ink)",
      }}
    >
      <m.span
        initial={false}
        animate={{ opacity: on ? 1 : 0 }}
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 10,
          boxShadow: "inset 0 0 0 2px var(--teal)",
        }}
      />
      <Avatar name={name} kind={kind} size={34} />
      <span style={{ fontSize: 14, color: "var(--navy-ink)" }}>{name}</span>
      <Bars on={on} />
    </div>
  );
}

function SideLabel({ children }: { children: string }) {
  return (
    <m.div
      variants={item}
      style={{
        margin: "12px 12px 2px",
        fontSize: 16,
        fontWeight: 600,
        color: "var(--navy-muted)",
      }}
    >
      {children}
    </m.div>
  );
}

function SidePerson({ name, kind }: { name: string; kind: AvatarKind }) {
  return (
    <m.div
      variants={item}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 36,
        padding: "0 12px",
        fontSize: 18,
      }}
    >
      <Avatar name={name} kind={kind} size={22} />
      <span style={{ color: "var(--navy-ink)" }}>{name}</span>
    </m.div>
  );
}

function Message({
  name,
  kind,
  text,
}: {
  name: string;
  kind: AvatarKind;
  text: string;
}) {
  return (
    <m.div
      layout
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={spring}
      style={{ display: "flex", gap: 12 }}
    >
      <Avatar name={name} kind={kind} size={40} />
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 18,
            fontWeight: 650,
          }}
        >
          {name}
          {kind === "agent" && (
            <span
              style={{
                fontSize: 12,
                letterSpacing: "0.06em",
                padding: "1px 6px",
                borderRadius: 5,
                background: "var(--teal-wash)",
                color: "var(--teal-ink)",
              }}
            >
              AGENT
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 18,
            lineHeight: 1.45,
            color: "var(--win-ink)",
            marginTop: 2,
          }}
        >
          {text}
        </div>
      </div>
    </m.div>
  );
}

function Row({
  cells,
  head,
  strong,
  focus,
  filled,
  reduced,
}: {
  cells: string[];
  head?: boolean;
  strong?: boolean;
  focus?: boolean;
  filled?: boolean;
  reduced?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "1.2fr 1.1fr 0.8fr",
        height: 34,
        borderBottom: "1px solid var(--win-line)",
        fontWeight: head || strong ? 650 : 450,
        color: head ? "var(--win-muted)" : "var(--win-ink)",
      }}
    >
      <m.span
        initial={false}
        animate={{ opacity: focus ? 1 : 0 }}
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--teal-wash)",
          boxShadow: "inset 0 0 0 2px var(--teal)",
        }}
      />
      {cells.map((c, i) => (
        <span
          key={`${i}-${c}`}
          style={{
            position: "relative",
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            justifyContent: i === 2 ? "flex-end" : "flex-start",
            borderRight: i < 2 ? "1px solid var(--win-line)" : "none",
          }}
        >
          {head ? (
            c
          ) : (
            <Typed
              text={c}
              on={Boolean(filled)}
              stepMs={28}
              instant={reduced}
            />
          )}
        </span>
      ))}
    </div>
  );
}

function Box({ label }: { label: string }) {
  return (
    <span
      style={{
        padding: "10px 8px",
        borderRadius: 8,
        border: "1.5px solid var(--teal)",
        background: "var(--teal-wash)",
        fontSize: 15,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function Arrow() {
  return (
    <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
      <path
        d="M0 5 H15 M11 1 L16 5 L11 9"
        stroke="var(--win-muted)"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

function Pill({ children, on }: { children: ReactNode; on?: boolean }) {
  return (
    <span
      style={{
        padding: "6px 14px",
        borderRadius: 10,
        border: "1px solid var(--win-line)",
        fontSize: 16,
        fontWeight: 560,
        background: on ? "var(--teal-wash)" : "transparent",
        color: "var(--win-ink)",
        transition: "background-color 0.3s",
      }}
    >
      {children}
    </span>
  );
}
