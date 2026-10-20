import {
  LazyMotion,
  MotionConfig,
  m,
  useInView,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Diagram } from "./Diagram.tsx";
import { MotionStage } from "./MotionStage.tsx";

const base = import.meta.env.BASE_URL;
const repo = "https://github.com/MemoAir-labs/Airlink";
const docsFallback = `${repo}/tree/main/docs`;
const steps: [string, string?][] = [
  [`git clone ${repo}.git`],
  ["cd Airlink"],
  ["npm install"],
  ["cd apps/airlink"],
  [
    "cp .env.example .env",
    "your ANTHROPIC_API_KEY, or paste a key in Settings later",
  ],
  [
    "docker compose up -d",
    "Postgres, LiveKit, the shared browser and the desktop",
  ],
  ["npm run dev", "http://localhost:3030"],
];
const quickstart = steps.map(([cmd]) => cmd).join("\n");

// Motion's animation features (including layout) load as their own chunk after first paint.
const loadFeatures = () =>
  import("./motion/features.ts").then((mod) => mod.default);

const ease = [0.16, 1, 0.3, 1] as const;
const reveal = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease } },
};
const revealList = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08 } },
};
const viewport = { once: true, amount: 0.1 } as const;

function Reveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <m.div
      className={className}
      variants={reveal}
      initial="hidden"
      whileInView="shown"
      viewport={viewport}
    >
      {children}
    </m.div>
  );
}

function Cta(props: ComponentProps<typeof m.a>) {
  return (
    <m.a
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      {...props}
    />
  );
}

function useDocsHref() {
  const [href, setHref] = useState(docsFallback);
  useEffect(() => {
    const local = `${base}docs/`;
    fetch(local, { method: "HEAD" })
      .then((r) => r.ok && setHref(local))
      .catch(() => undefined);
  }, []);
  return href;
}

export function App() {
  const docs = useDocsHref();
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadFeatures} strict>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <Nav docs={docs} />
        <main id="main">
          <Hero />
          <Demo />
          <Capabilities />
          <How />
          <Quickstart docs={docs} />
          <Faq />
          <Closing />
        </main>
        <Footer docs={docs} />
      </LazyMotion>
    </MotionConfig>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="AirLink, back to top">
      <span className="brand-mark">
        <img src={`${base}memoair.svg`} alt="" width={28} height={28} />
      </span>
      AirLink
    </a>
  );
}

function Nav({ docs }: { docs: string }) {
  return (
    <header className="nav" id="top">
      <div className="wrap nav-inner">
        <Brand />
        <nav aria-label="Main">
          <ul className="nav-links">
            <li className="optional">
              <a href="#capabilities">Capabilities</a>
            </li>
            <li className="optional">
              <a href="#how">How it works</a>
            </li>
            <li>
              <a href="#quickstart">Quickstart</a>
            </li>
            <li>
              <a href={docs}>Docs</a>
            </li>
          </ul>
        </nav>
        <Cta
          className="btn btn-ghost btn-sm"
          href={repo}
          aria-label="AirLink on GitHub"
        >
          <GitHubIcon />
          <span className="optional-text">GitHub</span>
        </Cta>
      </div>
    </header>
  );
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end start"],
  });
  const stageY = useTransform(scrollYProgress, [0, 1], [0, -72]);
  return (
    <section ref={ref} className="hero" aria-labelledby="hero-title">
      <div className="wrap hero-grid">
        <m.div variants={revealList} initial="hidden" animate="shown">
          <m.h1 id="hero-title" variants={reveal}>
            One room for people <span className="soft">and agents.</span>
          </m.h1>
          <m.p className="hero-pitch" variants={reveal}>
            Chat, live docs, a shared browser, a desktop and a voice huddle, on
            one event log. Your agents work in the same channel you do, with
            their cursors on the same objects.
          </m.p>
          <m.div className="hero-actions" variants={reveal}>
            <Cta className="btn btn-primary" href={repo}>
              <GitHubIcon />
              View on GitHub
            </Cta>
            <Cta className="btn btn-ghost" href="#quickstart">
              Quickstart
            </Cta>
          </m.div>
          <m.ul className="hero-facts" variants={reveal}>
            <li>MIT licensed</li>
            <li>Runs on your machine</li>
            <li>Pre-release</li>
          </m.ul>
        </m.div>
        <m.div
          style={reduced ? undefined : { y: stageY }}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease, delay: 0.15 }}
        >
          <MotionStage
            name="roomAlive"
            ratio="16 / 10"
            label="An AirLink channel coming alive: channels appear, a person asks for a budget, an agent opens a sheet and fills it with its cursor, then a huddle starts and the agent answers by voice."
          />
        </m.div>
      </div>
    </section>
  );
}

function Demo() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const started = useRef(false);
  useEffect(() => {
    const video = ref.current;
    if (!video || reduced) {
      return;
    }
    if (inView) {
      started.current = true;
      video.play().catch(() => undefined);
    } else if (started.current) {
      video.pause();
    }
  }, [inView, reduced, ref]);

  return (
    <section className="demo" aria-labelledby="demo-title">
      <div className="wrap">
        <Reveal className="demo-head">
          <h2 id="demo-title">Thirty seconds in a channel.</h2>
          <p>
            Two people and an agent in <code>#t-demo-launch</code>: the agent
            fills a sheet, sketches a flow on the canvas and joins the huddle.
            Recorded from the app as it runs today.
          </p>
        </Reveal>
        <div className="video-frame">
          <video
            ref={ref}
            src={`${base}airlink-demo.mp4`}
            poster={`${base}airlink-demo-poster.webp`}
            muted
            playsInline
            loop
            controls
            preload="none"
            aria-label="AirLink demo video"
          />
        </div>
        <div className="gallery">
          <figure>
            <Shot
              name="overview"
              alt="An AirLink channel: chat on the left, a sheet, slides, a canvas and a doc open as windows in the space."
            />
            <figcaption>
              A channel: the chat beside its space of live windows.
            </figcaption>
          </figure>
          <div className="gallery-side">
            <figure>
              <img
                src={`${base}shots/agent-cursor-dark.webp`}
                alt="The Assistant agent's labelled cursor drawing on a canvas while the chat explains what it did."
                width={1200}
                height={750}
                loading="lazy"
                decoding="async"
              />
              <figcaption>An agent's cursor at work on the canvas.</figcaption>
            </figure>
            <figure>
              <Shot
                name="huddle"
                alt="A huddle in light mode: the space stays live while a person and the agent sit in the call."
              />
              <figcaption>A huddle, with the space still live.</figcaption>
            </figure>
          </div>
        </div>
      </div>
    </section>
  );
}

function Shot({ name, alt }: { name: "overview" | "huddle"; alt: string }) {
  return (
    <picture>
      <source
        srcSet={`${base}shots/${name}-dark.webp`}
        media="(prefers-color-scheme: dark)"
      />
      <img
        src={`${base}shots/${name}-light.webp`}
        alt={alt}
        width={1200}
        height={750}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

function Ticks({ items }: { items: ReactNode[] }) {
  return (
    <ul className="ticks">
      {items.map((item, i) => (
        <li key={i}>
          <CheckIcon />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Coming({ children = "Coming" }: { children?: string }) {
  return <span className="coming">{children}</span>;
}

function Capabilities() {
  return (
    <section className="section" id="capabilities" aria-labelledby="cap-title">
      <div className="wrap">
        <Reveal className="section-head">
          <h2 id="cap-title">Everything a channel needs, in the channel.</h2>
          <p>
            Each channel is a room with three parts: a chat, a space of live
            objects and a huddle. Whatever anyone does there, person or agent,
            lands on the same log.
          </p>
        </Reveal>

        <div className="rows">
          <article className="row">
            <Reveal className="row-text">
              <h3>The room and its space</h3>
              <p>
                Every channel has a desktop of windows that opens, minimizes and
                maximizes for everyone at once. Deleted objects go to a bin
                first.
              </p>
              <Ticks
                items={[
                  "Rich-text docs with comments, suggestions and history",
                  <>
                    Sheets with formulas and <code>.xlsx</code> export
                  </>,
                  <>
                    Slides with themes and <code>.pptx</code> export
                  </>,
                  <>
                    A sketch canvas, and uploaded files: PDF, <code>.xlsx</code>
                    , text
                  </>,
                  <>
                    Cursors, carets and presence on every object{" "}
                    <Coming>Screen share coming</Coming>
                  </>,
                ]}
              />
            </Reveal>
            <MotionStage
              name="spaceKinds"
              ratio="8 / 5"
              label="A channel's space: a doc, a sheet, a canvas, slides and a PDF open from the dock as windows; the slides minimize back to the dock and the sheet maximizes, then restores."
            />
          </article>

          <article className="row flip">
            <Reveal className="row-text">
              <h3>Agents beside you, not behind a tab</h3>
              <p>
                Agents edit the same objects with their own cursors. They go
                through the same permission check as people, with a token per
                agent and per object, capped at <code>write</code> or{" "}
                <code>suggest</code>. Binding content goes in as a suggestion a
                named person accepts.
              </p>
              <p className="chips-label">Bring the agent you already use</p>
              <ul className="chips" aria-label="Agent harnesses">
                <li className="key">Your own LLM key, in process</li>
                <li>Claude Code</li>
                <li>Codex</li>
                <li>Gemini CLI</li>
                <li>opencode</li>
              </ul>
              <Ticks
                items={[
                  "Keys for Anthropic, OpenAI, Google, OpenRouter, Groq, xAI, Mistral or DeepSeek; each agent picks its own model",
                  "Claude Code, Codex, Gemini CLI and opencode run over ACP when they are on your PATH",
                  <>
                    A person's edits can earn an agent an unprompted turn{" "}
                    <Coming>Scheduled agents coming</Coming>
                  </>,
                ]}
              />
            </Reveal>
            <MotionStage
              name="agentSuggest"
              ratio="8 / 5"
              label="An agent's cursor types a pricing line into a doc as a suggestion; a person's cursor arrives and accepts it, and the text becomes part of the doc."
            />
          </article>

          <article className="row">
            <Reveal className="row-text">
              <h3>A huddle where agents listen and talk back</h3>
              <p>
                A full-duplex voice call on LiveKit. Each person is transcribed
                on the server, turn ends are detected, and one speaking floor
                keeps agents from talking over people. Talk over an agent with a
                real word and it stops within a moment.
              </p>
              <Ticks
                items={[
                  "Barge-in and an echo filter, with a distinct voice per agent",
                  "Agents hand long work to their harness and report back",
                  "ElevenLabs or OpenAI for speech; voice and video for people",
                ]}
              />
            </Reveal>
            <MotionStage
              name="huddleBarge"
              ratio="8 / 5"
              label="A huddle with two people and an agent. The agent starts answering, a person talks over it, the agent stops and its line is marked cut off, then it acknowledges."
            />
          </article>

          <article className="row flip">
            <Reveal className="row-text">
              <h3>A shared browser and a desktop</h3>
              <p>
                A Chromium everyone and every agent can drive, streamed over
                WebRTC. A Linux desktop in Docker with XFCE, a terminal, an
                editor and files, which agents operate through mouse, keyboard
                and screenshots.
              </p>
              <Ticks
                items={[
                  "E2B is optional, for one desktop per object",
                  <>
                    Today one desktop is shared by the server{" "}
                    <Coming>A pool of desktops coming</Coming>
                  </>,
                ]}
              />
            </Reveal>
            <BrowserDesktop />
          </article>
        </div>

        <m.div
          className="bento"
          variants={revealList}
          initial="hidden"
          whileInView="shown"
          viewport={viewport}
        >
          <m.article
            className="tile wide"
            variants={reveal}
            whileHover={{ y: -3 }}
          >
            <div>
              <h3>Memory you can read</h3>
              <p>
                Each agent remembers in a folder of Markdown files under{" "}
                <code>.airlink/memory/</code>. Read them, edit them, put them
                under git, or point the memory root at an Obsidian vault.
              </p>
            </div>
            <div className="mini files" aria-hidden="true">
              <ul>
                <li>.airlink/memory/</li>
                <li>&nbsp;&nbsp;assistant/</li>
                <li className="open">&nbsp;&nbsp;&nbsp;&nbsp;launch.md</li>
                <li>&nbsp;&nbsp;&nbsp;&nbsp;people.md</li>
                <li>&nbsp;&nbsp;researcher/</li>
              </ul>
              <pre>
                <b># Launch</b>
                {"\n"}- Budget lives in the sheet "Launch budget".
                {"\n"}- Grace owns the owners section.
                {"\n"}-{" "}
                <span className="typed">
                  Lin wants contingency filled first.
                </span>
              </pre>
            </div>
          </m.article>

          <m.article
            className="tile narrow"
            variants={reveal}
            whileHover={{ y: -3 }}
          >
            <div>
              <h3>Invite-only channels</h3>
              <p>
                Only member agents see a channel, and only they answer in it.
              </p>
            </div>
            <div className="mini" aria-hidden="true">
              <div className="mini-bar">
                <LockIcon />
                <span># launch-pricing</span>
              </div>
              <ul className="members">
                <li>
                  <span className="dot p1">L</span>Lin
                </li>
                <li>
                  <span className="dot agent">
                    <SparkIcon />
                  </span>
                  Assistant
                </li>
                <li className="out">
                  <span className="dot muted">
                    <SparkIcon />
                  </span>
                  Researcher<span className="tag">not a member</span>
                </li>
              </ul>
            </div>
          </m.article>

          <m.article
            className="tile narrow"
            variants={reveal}
            whileHover={{ y: -3 }}
          >
            <div>
              <h3>
                Code runner and live dashboards <Coming />
              </h3>
              <p>
                A code runner object for live dashboards is being built. Agents
                cannot run code yet.
              </p>
            </div>
            <div className="runner" aria-hidden="true">
              In progress
            </div>
          </m.article>

          <m.article
            className="tile wide"
            variants={reveal}
            whileHover={{ y: -3 }}
          >
            <div>
              <h3>MIT, and it runs on your machine</h3>
              <p>
                One Docker Compose file and one Node process, listening on{" "}
                <code>127.0.0.1</code> by default. Data, memory and keys stay in{" "}
                <code>.airlink/</code> and your Postgres; only what you send to
                the providers you configure leaves the machine. There is no
                hosted version and no accounts yet.
              </p>
            </div>
            <pre className="term" aria-hidden="true">
              <span className="c">$</span> docker compose up -d{"\n"}
              <span className="c">$</span> npm run dev{"\n"}
              <span className="ok">AirLink on http://localhost:3030</span>
              {"\n"}
              <span className="caret" />
            </pre>
          </m.article>
        </m.div>
      </div>
    </section>
  );
}

function BrowserDesktop() {
  return (
    <div
      className="screens"
      role="img"
      aria-label="A shared browser and a Linux desktop side by side, with a person's cursor and an agent's cursor moving across them."
    >
      <div className="win">
        <div className="mini-bar">
          <i />
          <i />
          <i />
          <span>Shared browser</span>
        </div>
        <div className="url">example.com/launch-notes</div>
        <div className="page">
          <i className="h" />
          <i />
          <i className="s" />
          <div className="card" />
          <i />
          <i className="s" />
        </div>
      </div>
      <div className="win xfce">
        <div className="mini-bar">
          <i />
          <i />
          <i />
          <span>Desktop</span>
        </div>
        <div className="desk-term">
          <span className="c">~/launch $ ls</span>
          <span>README.md budget.xlsx</span>
          <span className="c">~/launch $ _</span>
        </div>
      </div>
      <span className="pointer person" aria-hidden="true">
        <PointerIcon />
        <b>Lin</b>
      </span>
      <span className="pointer agent" aria-hidden="true">
        <PointerIcon />
        <b>Assistant</b>
      </span>
    </div>
  );
}

function How() {
  return (
    <section className="how" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <Reveal className="section-head">
          <h2 id="how-title">How it fits together</h2>
          <p>
            One Node process holds the app, live-server, the agent bridge and
            voice. Docker runs Postgres, LiveKit, the shared browser and the
            desktop.
          </p>
        </Reveal>
        <div className="diagram-scroll">
          <Diagram />
        </div>
        <p className="diagram-hint">
          Scroll sideways to see the whole diagram.
        </p>
        <div className="how-notes">
          <p>
            <strong>One event log.</strong> Every change to a room is a Yjs
            update with an <code>actor</code>, appended to Postgres off the
            keystroke path.
          </p>
          <p>
            <strong>Agents never write documents directly.</strong> The bridge
            calls live-server's ops routes with a token signed for that agent
            and that object, so an agent sees and changes only what is in its
            room.
          </p>
          <p>
            <strong>Who answers.</strong> An <code>@mention</code> or a tag
            picks the agent. When nobody is named, the decision node picks by
            role, or judges that the message was for a person.
          </p>
          <p>
            <strong>Any harness.</strong> A loopback MCP server exposes the
            room's tools, so Pi in process, Claude Code, Codex and the rest work
            the room the same way.
          </p>
        </div>
      </div>
    </section>
  );
}

function Quickstart({ docs }: { docs: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(quickstart)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      })
      .catch(() => undefined);
  };
  return (
    <section className="section" id="quickstart" aria-labelledby="qs-title">
      <div className="wrap qs-grid">
        <Reveal className="section-head">
          <h2 id="qs-title">Quickstart</h2>
          <p>From a clone to a room in your browser.</p>
          <ul className="needs">
            <li>
              <strong>Docker</strong> for Postgres, LiveKit, the browser and the
              desktop
            </li>
            <li>
              <strong>Node 24</strong>
            </li>
            <li>
              <strong>One LLM key</strong>: Anthropic or OpenAI
            </li>
          </ul>
        </Reveal>
        <div>
          <div className="code">
            <div className="code-bar">
              <span>Terminal</span>
              <button
                type="button"
                className="copy"
                onClick={copy}
                aria-label="Copy the quickstart commands"
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
            <pre>
              <code>
                {steps.map(([cmd, note]) => (
                  <span key={cmd}>
                    {note && (
                      <span className="c">
                        # {note}
                        {"\n"}
                      </span>
                    )}
                    <span className="p">$ </span>
                    {cmd}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          </div>
          <p className="qs-after">
            The first <code>docker compose up</code> builds the browser and
            desktop images, which takes a few minutes. Open{" "}
            <code>localhost:3030</code> in two browsers, give each a name and
            write in <code>#general</code>. Setup details and troubleshooting
            are in the <a href={docs}>docs</a>.
          </p>
        </div>
      </div>
    </section>
  );
}

const faqs: [string, ReactNode][] = [
  ["What do I need to run it?", "Docker, Node 24 and one LLM key."],
  [
    "Does anything leave my machine?",
    <>
      Only what goes to the providers you configure: your LLM provider, your
      speech provider in a huddle (ElevenLabs or OpenAI), and E2B if you set its
      key. Data, memory and keys stay in <code>.airlink/</code> and your
      Postgres.
    </>,
  ],
  [
    "Is there a hosted version?",
    "No. AirLink runs on your machine or your server.",
  ],
  [
    "Can people on other machines join?",
    <>
      Yes, with <code>AIRLINK_HOST=0.0.0.0</code>, but there are no accounts:
      anyone who reaches it can join under any name. Open it only to a network
      you trust.
    </>,
  ],
  [
    "Can I interrupt an agent?",
    "Yes. Talk over it with a real word (not “mm-hm”) and it stops within a moment. The transcript marks the line as cut off.",
  ],
  [
    "Can agents run code?",
    "Not yet. A code runner object for live dashboards is being built. Today agents work in docs, sheets, slides, canvases, the shared browser and the desktop.",
  ],
  [
    "Can I use the packages in my own app?",
    "Not from npm yet: every package is private and unpublished. You can use them from the repository's workspaces. Published packages and starter templates are coming.",
  ],
];

function Faq() {
  return (
    <section className="section" id="faq" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <Reveal className="section-head">
          <h2 id="faq-title">Questions</h2>
          <p>Short answers. The full list lives in the docs.</p>
        </Reveal>
        <div className="faq-list">
          {faqs.map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <PlusIcon />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="closing" aria-labelledby="closing-title">
      <div className="wrap">
        <div className="closing-inner">
          <div>
            <h2 id="closing-title">Bring your people and your agents.</h2>
            <p>
              AirLink is pre-release and MIT licensed. Star it, run it, and open
              an issue when something breaks.
            </p>
          </div>
          <Cta className="btn btn-primary" href={repo}>
            <GitHubIcon />
            View on GitHub
          </Cta>
        </div>
      </div>
    </section>
  );
}

function Footer({ docs }: { docs: string }) {
  return (
    <footer className="footer">
      <div className="wrap footer-inner">
        <div>
          <Brand />
          <small>MIT licensed. Pre-release: packages are not on npm yet.</small>
        </div>
        <nav aria-label="Footer">
          <ul>
            <li>
              <a href={repo}>GitHub</a>
            </li>
            <li>
              <a href={docs}>Docs</a>
            </li>
            <li>
              <a href={`${repo}/blob/main/LICENSE`}>Licence</a>
            </li>
            <li>
              <a href={`${repo}/blob/main/CHANGELOG.md`}>Changelog</a>
            </li>
            <li>
              <a href={`${repo}/blob/main/SECURITY.md`}>Security</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}

const icon = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function GitHubIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...icon}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg {...icon}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...icon}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...icon} className="lock">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PointerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 13 19" aria-hidden="true">
      <path
        d="M0 0 L0 16 L4.5 12 L7.5 19 L10 18 L7 11 L13 11 Z"
        fill="currentColor"
        stroke="white"
        strokeWidth="1"
      />
    </svg>
  );
}
