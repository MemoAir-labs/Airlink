import { m } from "motion/react";

const ease = [0.16, 1, 0.3, 1] as const;
const stagger = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.05, delayChildren: 0.1 } },
};
const draw = {
  hidden: { pathLength: 0, opacity: 0 },
  shown: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.9, ease },
  },
};
const fade = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.5, ease } },
};

type NodeProps = {
  x: number;
  y: number;
  w: number;
  h?: number;
  title: string;
  sub?: string;
  core?: boolean;
};

function Node({ x, y, w, h = 56, title, sub, core }: NodeProps) {
  return (
    <m.g className={core ? "node core" : "node"} variants={fade}>
      <rect x={x} y={y} width={w} height={h} rx={10} />
      <text x={x + 16} y={sub ? y + 24 : y + h / 2 + 5}>
        {title}
      </text>
      {sub && (
        <text className="sub" x={x + 16} y={y + 43}>
          {sub}
        </text>
      )}
    </m.g>
  );
}

function Label({
  x,
  y,
  children,
  rtc,
  anchor,
}: {
  x: number;
  y: number;
  children: string;
  rtc?: boolean;
  anchor?: "end" | "middle";
}) {
  return (
    <m.text
      variants={fade}
      className={rtc ? "edge-label rtc" : "edge-label"}
      x={x}
      y={y}
      textAnchor={anchor}
    >
      {children}
    </m.text>
  );
}

export function Diagram() {
  return (
    <m.svg
      variants={stagger}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.3 }}
      className="diagram"
      viewBox="0 0 1040 640"
      role="img"
      aria-labelledby="diagram-title diagram-desc"
    >
      <title id="diagram-title">How AirLink fits together</title>
      <desc id="diagram-desc">
        Each person's browser runs the web app, which syncs with live-server
        over Yjs, calls the app API over REST, and reaches LiveKit, the shared
        Chromium and the desktop container over WebRTC. Inside the AirLink
        process, live-server and the app API write to Postgres; live-server
        hands turns to the agent bridge; the bridge runs a harness, writes
        memory folders and sends ops back to live-server under the agent's own
        token; the voice layer talks to LiveKit and hands work to the bridge.
        live-server drives the shared Chromium over CDP and the desktop over
        token-gated HTTP.
      </desc>
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="oklch(80% 0.03 225 / 0.8)" />
        </marker>
        <marker
          id="arrow-rtc"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="oklch(76% 0.09 196)" />
        </marker>
      </defs>

      <rect className="group" x={20} y={180} width={230} height={190} rx={14} />
      <text className="group-label" x={36} y={206}>
        EACH PERSON'S BROWSER
      </text>
      <rect className="group" x={300} y={20} width={340} height={580} rx={14} />
      <text className="group-label" x={316} y={46}>
        AIRLINK PROCESS · ONE NODE PROCESS
      </text>
      <text className="group-label" x={760} y={46}>
        DOCKER AND YOUR MACHINE
      </text>

      <m.path
        variants={draw}
        className="edge"
        d="M250 262 H272 V88 H328"
        markerEnd="url(#arrow)"
      />
      <Label x={262} y={160} anchor="end">
        REST
      </Label>
      <m.path
        variants={draw}
        className="edge"
        d="M250 290 H292 V198 H328"
        markerEnd="url(#arrow)"
      />
      <Label x={300} y={252}>
        Yjs sync
      </Label>
      <m.path
        variants={fade}
        className="edge rtc"
        d="M135 352 V616 H724 V184 H758"
        markerEnd="url(#arrow-rtc)"
      />
      <m.path
        variants={fade}
        className="edge rtc"
        d="M724 284 H758"
        markerEnd="url(#arrow-rtc)"
      />
      <m.path
        variants={fade}
        className="edge rtc"
        d="M724 552 H758"
        markerEnd="url(#arrow-rtc)"
      />
      <Label x={430} y={609} rtc>
        WebRTC: voice, video, the shared browser and the desktop
      </Label>

      <m.path
        variants={draw}
        className="edge"
        d="M620 88 H758"
        markerEnd="url(#arrow)"
      />
      <m.path variants={draw} className="edge" d="M620 182 H680 V88" />
      <Label x={690} y={80}>
        update log
      </Label>
      <m.path
        variants={draw}
        className="edge"
        d="M620 198 H700 V166 H758"
        markerEnd="url(#arrow)"
      />
      <Label x={706} y={158}>
        CDP
      </Label>
      <m.path
        variants={draw}
        className="edge"
        d="M620 214 H710 V256 H758"
        markerEnd="url(#arrow)"
      />
      <Label x={660} y={244} anchor="end">
        token-gated HTTP
      </Label>

      <m.path
        variants={draw}
        className="edge"
        d="M420 226 V328"
        markerEnd="url(#arrow)"
      />
      <Label x={412} y={282} anchor="end">
        turn
      </Label>
      <m.path
        variants={draw}
        className="edge"
        d="M520 328 V228"
        markerEnd="url(#arrow)"
      />
      <Label x={530} y={274}>
        ops, under the
      </Label>
      <Label x={530} y={290}>
        agent's own token
      </Label>

      <m.path
        variants={draw}
        className="edge"
        d="M620 358 H758"
        markerEnd="url(#arrow)"
      />
      <m.path
        variants={draw}
        className="edge"
        d="M620 374 H700 V448 H758"
        markerEnd="url(#arrow)"
      />
      <m.path
        variants={draw}
        className="edge"
        d="M470 508 V388"
        markerEnd="url(#arrow)"
      />
      <Label x={480} y={452}>
        work
      </Label>
      <m.path
        variants={draw}
        className="edge"
        d="M620 532 H758"
        markerStart="url(#arrow)"
        markerEnd="url(#arrow)"
      />

      <Node
        x={40}
        y={226}
        w={190}
        h={124}
        title="Web app"
        sub="@memo-air/react"
      />
      <Node
        x={330}
        y={60}
        w={290}
        title="App API"
        sub="channels · members · files · settings"
        core
      />
      <Node
        x={330}
        y={170}
        w={290}
        title="live-server"
        sub="Yjs over Hocuspocus"
        core
      />
      <Node
        x={330}
        y={330}
        w={290}
        title="Agent bridge"
        sub="routing · harnesses · memory"
        core
      />
      <Node
        x={330}
        y={508}
        w={290}
        title="Voice"
        sub="ears · floor · talkers"
        core
      />

      <Node
        x={760}
        y={60}
        w={260}
        title="Postgres"
        sub="update log · channels · files"
      />
      <Node x={760} y={150} w={260} title="neko" sub="shared Chromium" />
      <Node
        x={760}
        y={240}
        w={260}
        title="Desktop container"
        sub="XFCE + control server"
      />
      <Node
        x={760}
        y={330}
        w={260}
        title="Harness"
        sub="Pi in process, or an ACP harness"
      />
      <Node
        x={760}
        y={420}
        w={260}
        title="Memory folders"
        sub="Markdown, one per agent"
      />
      <Node x={760} y={510} w={260} title="LiveKit" sub="voice and video" />
    </m.svg>
  );
}
