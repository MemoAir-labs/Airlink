import { m, type Transition } from "motion/react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const spring: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 30,
  mass: 0.9,
};
export const glide: Transition = {
  type: "spring",
  stiffness: 120,
  damping: 20,
};

export type SceneProps = { active: boolean; reduced: boolean };

export function useSequence(
  durationsMs: number[],
  { active, reduced }: SceneProps
) {
  const last = durationsMs.length - 1;
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active || reduced) {
      return;
    }
    const timer = setTimeout(
      () => setStep((s) => (s >= last ? 0 : s + 1)),
      durationsMs[step]
    );
    return () => clearTimeout(timer);
  }, [active, reduced, step, last, durationsMs]);
  return reduced ? last : step;
}

export function Canvas({
  width,
  height,
  children,
  style,
}: {
  width: number;
  height: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setScale(entry.contentRect.width / width)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div ref={ref} style={{ overflow: "hidden" }}>
      <div
        style={{
          position: "relative",
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          fontFamily: "var(--font-sans)",
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function Win({
  title,
  children,
  style,
  from = { y: 24 },
  layout = false,
}: {
  title: string;
  children?: ReactNode;
  style: CSSProperties;
  from?: { x?: number; y?: number };
  layout?: boolean;
}) {
  return (
    <m.div
      layout={layout}
      initial={{ opacity: 0, scale: 0.88, ...from }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, scale: 0.4, y: 160, transition: { duration: 0.28 } }}
      transition={spring}
      style={{
        position: "absolute",
        borderRadius: 12,
        background: "var(--win)",
        color: "var(--win-ink)",
        boxShadow:
          "0 2px 4px rgb(0 0 0 / 0.12), 0 18px 40px -12px rgb(0 0 0 / 0.35), 0 0 0 1px var(--win-line)",
        overflow: "hidden",
        ...style,
      }}
    >
      <m.div
        layout={layout ? "position" : false}
        style={{
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 12px",
          borderBottom: "1px solid var(--win-line)",
          fontSize: 14,
          color: "var(--win-muted)",
        }}
      >
        <Dots />
        <span
          style={{
            flex: 1,
            textAlign: "center",
            fontWeight: 560,
            color: "var(--win-ink)",
          }}
        >
          {title}
        </span>
        <span style={{ width: 34 }} />
      </m.div>
      {children}
    </m.div>
  );
}

function Dots() {
  return (
    <span style={{ display: "flex", gap: 5 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 9,
            height: 9,
            borderRadius: 9,
            background: "var(--win-line)",
          }}
        />
      ))}
    </span>
  );
}

export function Cursor({
  x,
  y,
  label,
  kind,
  visible = true,
  pressed = false,
}: {
  x: number;
  y: number;
  label: string;
  kind: "agent" | "person";
  visible?: boolean;
  pressed?: boolean;
}) {
  const color = kind === "agent" ? "var(--teal)" : "var(--person)";
  const ink = kind === "agent" ? "var(--on-teal)" : "oklch(20% 0.04 40)";
  return (
    <m.div
      initial={false}
      animate={{ x, y, opacity: visible ? 1 : 0, scale: pressed ? 0.88 : 1 }}
      transition={glide}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        display: "flex",
        alignItems: "flex-start",
        zIndex: 5,
        transformOrigin: "0 0",
      }}
    >
      <svg width="20" height="22" viewBox="0 0 13 19" aria-hidden="true">
        <path
          d="M0 0 L0 16 L4.5 12 L7.5 19 L10 18 L7 11 L13 11 Z"
          fill={color}
          stroke="white"
          strokeWidth="1"
        />
      </svg>
      <span
        style={{
          marginTop: 16,
          padding: "3px 9px",
          borderRadius: 7,
          background: color,
          color: ink,
          fontSize: 15,
          fontWeight: 650,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </m.div>
  );
}

export type AvatarKind = "agent" | "p1" | "p2";

export function Avatar({
  name,
  kind,
  size = 30,
}: {
  name: string;
  kind: AvatarKind;
  size?: number;
}) {
  const bg =
    kind === "agent"
      ? "var(--teal)"
      : kind === "p1"
        ? "oklch(55% 0.12 160)"
        : "oklch(52% 0.13 300)";
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: bg,
        color: kind === "agent" ? "var(--on-teal)" : "white",
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: size * 0.45,
        flex: "none",
      }}
    >
      {kind === "agent" ? <Spark size={size * 0.5} /> : name[0]}
    </span>
  );
}

export function Spark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function Bars({ on }: { on: boolean }) {
  return (
    <span className={on ? "bars on" : "bars"} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} />
      ))}
    </span>
  );
}

export function Line({ w, strong }: { w: string; strong?: boolean }) {
  return (
    <span
      style={{
        display: "block",
        width: w,
        height: strong ? 12 : 8,
        borderRadius: 4,
        background: strong
          ? "color-mix(in oklch, var(--win-ink) 35%, var(--win-line))"
          : "var(--win-line)",
      }}
    />
  );
}

export function Typed({
  text,
  on,
  stepMs = 32,
  by = "char",
  stopAt,
  instant = false,
}: {
  text: string;
  on: boolean;
  stepMs?: number;
  by?: "char" | "word";
  stopAt?: number;
  instant?: boolean;
}) {
  const units = by === "word" ? text.split(" ") : [...text];
  const end = stopAt ?? units.length;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!on) {
      setCount(0);
      return;
    }
    const timer = setInterval(
      () => setCount((c) => (c >= end ? c : c + 1)),
      stepMs
    );
    return () => clearInterval(timer);
  }, [on, end, stepMs]);
  return (
    <>{units.slice(0, instant ? end : count).join(by === "word" ? " " : "")}</>
  );
}
