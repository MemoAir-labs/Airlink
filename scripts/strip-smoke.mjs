// Loads every source entry that runs under Node with plain `node` (Node 24 strips types by default,
// no flags), plus AirLink's server modules, and fails on the first set that does not load. Catches
// what type-check cannot: a missing `.ts` extension, a runtime-only syntax error, a non-erasable
// construct in a file outside every tsconfig. AirLink's main.ts starts a server when imported, so
// it is only stripped, not loaded.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { liveRoot, platformOf, workspacePackages } from "./packages.mjs";

const marker = "@@strip-smoke@@";

export function sourceEntries() {
  const entries = workspacePackages()
    .filter(({ manifest }) => platformOf(manifest) !== "browser")
    .flatMap(({ dir, manifest }) =>
      Object.values(manifest.exports ?? {})
        .filter((source) => source.endsWith(".ts"))
        .map((source) => join(dir, source))
    );
  const serverDir = join(liveRoot, "apps/airlink/server");
  const serverModules = readdirSync(serverDir)
    .filter(
      (name) =>
        name.endsWith(".ts") && name !== "main.ts" && !name.endsWith(".test.ts")
    )
    .map((name) => join(serverDir, name));
  return [...entries, ...serverModules];
}

export const parseOnlyEntries = () => [
  join(liveRoot, "apps/airlink/server/main.ts"),
];

// One child process imports them all, so a module that opens a handle cannot keep this one alive.
// `at` is the first stack line, which names the module that failed when it is a nested import.
export function loadErrors(files, parseOnly = []) {
  const script = [
    'import { readFileSync } from "node:fs";',
    'import { stripTypeScriptTypes } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    "const failures = [];",
    "const fail = (file, error) => {",
    '  const first = String(error?.stack ?? "").split("\\n")[0];',
    "  failures.push({",
    "    file,",
    "    message: String(error?.message ?? error),",
    '    at: first.includes("/") ? first : (error?.code ?? first),',
    "  });",
    "};",
    "for (const file of JSON.parse(process.argv[1])) {",
    "  try {",
    "    await import(pathToFileURL(file).href);",
    "  } catch (error) {",
    "    fail(file, error);",
    "  }",
    "}",
    "for (const file of JSON.parse(process.argv[2])) {",
    "  try {",
    '    stripTypeScriptTypes(readFileSync(file, "utf8"));',
    "  } catch (error) {",
    "    fail(file, error);",
    "  }",
    "}",
    `process.stdout.write("${marker}" + JSON.stringify(failures));`,
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      JSON.stringify(files),
      JSON.stringify(parseOnly),
    ],
    { cwd: liveRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const output = result.stdout ?? "";
  const at = output.lastIndexOf(marker);
  if (at === -1) {
    return [{ file: "(loader)", message: result.stderr || "no output" }];
  }
  return JSON.parse(output.slice(at + marker.length));
}

if (import.meta.main) {
  const entries = sourceEntries();
  const parsed = parseOnlyEntries();
  const failures = loadErrors(entries, parsed);
  for (const { file, message, at } of failures) {
    process.stderr.write(`strip-smoke: ${file}\n  ${message}\n  at ${at}\n`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
  process.stdout.write(
    `strip-smoke: ${entries.length} source entries load and ${parsed.length} strip under plain node\n`
  );
}
