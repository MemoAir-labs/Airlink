import { useInView, useReducedMotion } from "motion/react";
import {
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  Suspense,
  useRef,
} from "react";
import type { SceneProps } from "./motion/parts.tsx";

// Each scene is its own chunk, fetched only when its stage nears the viewport.
const scenes = {
  roomAlive: lazy(() => import("./motion/RoomAlive.tsx")),
  spaceKinds: lazy(() => import("./motion/SpaceKinds.tsx")),
  agentSuggest: lazy(() => import("./motion/AgentSuggest.tsx")),
  huddleBarge: lazy(() => import("./motion/HuddleBarge.tsx")),
} satisfies Record<string, LazyExoticComponent<ComponentType<SceneProps>>>;

type Props = { name: keyof typeof scenes; label: string; ratio: string };

export function MotionStage({ name, label, ratio }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, { once: true, margin: "300px 0px" });
  const visible = useInView(ref, { amount: 0.25 });
  const reduced = useReducedMotion() ?? false;
  const Scene = scenes[name];
  return (
    <div
      ref={ref}
      className="stage"
      style={{ "--ratio": ratio }}
      role="img"
      aria-label={label}
    >
      {near && (
        <Suspense fallback={null}>
          <Scene active={visible} reduced={reduced} />
        </Suspense>
      )}
    </div>
  );
}
