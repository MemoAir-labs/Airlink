// Installs every packed tarball into a fresh app outside the workspace, as a user would, and checks
// that each non-browser entry loads under plain node, that every entry and subpath type-checks under
// "bundler" and "nodenext" resolution, and that the React entries needing no optional peer bundle
// without one installed. Run after `npm run pack:all`; CI runs it on Node 22 and 24.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { liveRoot, platformOf, publishedPackages } from "./packages.mjs";

// Each React entry a consumer bundles: its minified weight with react and react-dom left out must stay
// under its budget (measured, plus about 15%; raise one on purpose, never to get a regression past).
// Entries with no `optionalPeers` bundle with none installed. The light entries must not reach the
// rich-text editor or the formula engine at all.
const reactEntries = [
  { specifier: "@memo-air/react", budgetKb: 680 },
  { specifier: "@memo-air/react/ui", budgetKb: 310 },
  { specifier: "@memo-air/react/sheet", budgetKb: 660 },
  { specifier: "@memo-air/react/browser", budgetKb: 400, light: true },
  { specifier: "@memo-air/react/desktop", budgetKb: 375, light: true },
  { specifier: "@memo-air/react/runner", budgetKb: 375, light: true },
  { specifier: "@memo-air/react/file", budgetKb: 280, light: true },
  {
    specifier: "@memo-air/react/media",
    budgetKb: 390,
    light: true,
    optionalPeers: [
      "livekit-client",
      "@elevenlabs/client",
      "@mediapipe/tasks-vision",
    ],
  },
];
const heavyInput =
  /node_modules\/(@tiptap\/|prosemirror-|fast-formula-parser\/)/;

const packs = join(liveRoot, ".packs");
const app = mkdtempSync(join(tmpdir(), "airlink-consumer-"));
const react19App = mkdtempSync(join(tmpdir(), "airlink-consumer-react19-"));
process.on("exit", (code) => {
  for (const dir of [app, react19App]) {
    if (code === 0) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      process.stderr.write(`consumer-smoke: kept ${dir} for inspection\n`);
    }
  }
});
const run = (command, args, cwd = app) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
const write = (name, text, dir = app) => writeFileSync(join(dir, name), text);

const specifiers = publishedPackages()
  .filter(({ manifest }) => manifest.exports)
  .flatMap(({ manifest }) =>
    Object.keys(manifest.exports)
      .filter((subpath) => !subpath.endsWith(".css"))
      .map((subpath) => ({
        specifier:
          subpath === "."
            ? manifest.name
            : `${manifest.name}${subpath.slice(1)}`,
        platform: platformOf(manifest),
      }))
  );

write(
  "package.json",
  `${JSON.stringify({ name: "airlink-consumer", private: true, type: "module" }, null, 2)}\n`
);
const tarballs = readdirSync(packs)
  .filter(
    (name) => name.endsWith(".tgz") && !name.startsWith("create-airlink-")
  )
  .map((name) => join(packs, name));
run("npm", [
  "install",
  "--no-audit",
  "--no-fund",
  ...tarballs,
  "react@^18.3.1",
  "react-dom@^18.3.1",
  "@types/react@^18.3.18",
  "@types/react-dom@^18.3.5",
  "@types/node@^24.12.2",
  "typescript@^5.9.3",
  "esbuild@^0.27.3",
]);

const nodeSpecifiers = specifiers
  .filter(({ platform }) => platform !== "browser")
  .map(({ specifier }) => specifier);
write(
  "load.mjs",
  `for (const specifier of ${JSON.stringify(nodeSpecifiers)}) {\n  await import(specifier);\n}\nprocess.exit(0);\n`
);
run(process.execPath, ["load.mjs"]);

write(
  "check.ts",
  `${specifiers.map(({ specifier }, index) => `import type * as entry${index} from "${specifier}";`).join("\n")}\n`
);
for (const [name, options] of [
  ["bundler", { module: "esnext", moduleResolution: "bundler" }],
  ["nodenext", { module: "nodenext", moduleResolution: "nodenext" }],
]) {
  write(
    `tsconfig.${name}.json`,
    JSON.stringify({
      compilerOptions: {
        ...options,
        target: "es2022",
        lib: ["es2023", "dom"],
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        noUnusedLocals: false,
        types: ["node"],
      },
      files: ["check.ts"],
    })
  );
  run("npx", ["--no-install", "tsc", "-p", `tsconfig.${name}.json`]);
}

const { buildSync } = createRequire(join(app, "package.json"))("esbuild");
const sizes = reactEntries.map(
  ({ specifier, budgetKb, light, optionalPeers = [] }) => {
    // Stylesheets stay out: Excalidraw's resolves only under the "development"/"production"
    // conditions Vite sets and pulls in fonts, and what this checks is the JavaScript graph.
    const { outputFiles, metafile } = buildSync({
      stdin: { contents: `export * from "${specifier}";`, resolveDir: app },
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "browser",
      external: [
        "react",
        "react/*",
        "react-dom",
        "react-dom/*",
        "*.css",
        ...optionalPeers,
      ],
      logLevel: "warning",
    });
    const sizeKb = Math.round(outputFiles[0].contents.length / 1024);
    if (sizeKb > budgetKb) {
      throw new Error(
        `consumer-smoke: ${specifier} is ${sizeKb} KB minified, over its ${budgetKb} KB budget`
      );
    }
    const heavy = Object.keys(metafile.inputs).filter((input) =>
      heavyInput.test(input)
    );
    if (light && heavy.length > 0) {
      throw new Error(
        `consumer-smoke: ${specifier} bundles the editor or formula engine: ${heavy[0]}`
      );
    }
    return `${specifier.replace("@memo-air/react", ".")} ${sizeKb}/${budgetKb} KB`;
  }
);

// A React 19 app must install @memo-air/react with no peer conflict (no --legacy-peer-deps), type-check
// against React 19's types and bundle.
write(
  "package.json",
  `${JSON.stringify({ name: "airlink-consumer-react19", private: true, type: "module" }, null, 2)}\n`,
  react19App
);
run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    ...tarballs,
    "react@^19.0.0",
    "react-dom@^19.0.0",
    "@types/react@^19.0.0",
    "@types/react-dom@^19.0.0",
    "typescript@^5.9.3",
    "esbuild@^0.27.3",
  ],
  react19App
);
write(
  "check.tsx",
  `import { createRoot } from "react-dom/client";\nimport { PresenceStack } from "@memo-air/react";\nimport { XClose } from "@memo-air/react/ui";\nexport const mount = (el: HTMLElement) =>\n  createRoot(el).render(<><PresenceStack peers={[]} /><XClose size={16} /></>);\n`,
  react19App
);
write(
  "tsconfig.json",
  JSON.stringify({
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      target: "es2022",
      lib: ["es2023", "dom"],
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ["check.tsx"],
  }),
  react19App
);
run("npx", ["--no-install", "tsc", "-p", "tsconfig.json"], react19App);
const react19Kb = Math.round(
  createRequire(join(react19App, "package.json"))("esbuild").buildSync({
    stdin: {
      contents: `export * from "@memo-air/react";`,
      resolveDir: react19App,
    },
    bundle: true,
    minify: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["react", "react/*", "react-dom", "react-dom/*", "*.css"],
    logLevel: "warning",
  }).outputFiles[0].contents.length / 1024
);

process.stdout.write(
  `consumer-smoke: ${tarballs.length} tarballs, ${nodeSpecifiers.length} node loads, ${specifiers.length} entries type-checked twice, ${reactEntries.length} React entries bundled within budget (${process.version})\n${sizes.join(", ")}\nReact 19 app: installed, type-checked, bundled @memo-air/react (${react19Kb} KB)\n`
);
