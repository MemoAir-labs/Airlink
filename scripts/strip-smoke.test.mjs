import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { liveRoot } from "./packages.mjs";
import { loadErrors, parseOnlyEntries, sourceEntries } from "./strip-smoke.mjs";

const parameterProperty =
  "export class A {\n  constructor(private readonly n: number) {}\n}\n";

function fixture(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "airlink-strip-")));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("reports the modules plain node cannot strip and passes the rest", () => {
  const dir = fixture({
    "good.ts": "export const ok: number = 1;\n",
    "enum.ts": "export enum Color {\n  Red,\n}\n",
    "param.ts": parameterProperty,
  });
  const errors = loadErrors(
    ["good.ts", "enum.ts", "param.ts"].map((name) => join(dir, name))
  );
  assert.deepEqual(
    errors.map(({ file }) => file),
    [join(dir, "enum.ts"), join(dir, "param.ts")]
  );
  assert.match(errors[0].message, /enum is not supported in strip-only mode/);
  assert.match(
    errors[1].message,
    /parameter property is not supported in strip-only mode/
  );
});

test("names the nested module that failed, not the entry that imported it", () => {
  const dir = fixture({
    "entry.ts": 'import "./nested.ts";\n',
    "nested.ts": "export enum Color {\n  Red,\n}\n",
  });
  const [error] = loadErrors([join(dir, "entry.ts")]);
  assert.equal(error.file, join(dir, "entry.ts"));
  assert.equal(error.at, `${join(dir, "nested.ts")}:1`);
});

test("strips parse-only files without running them", () => {
  const dir = fixture({
    "server.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(tmpdir(), "airlink-strip-ran"))}, "");\nexport const port: number = 1;\n`,
    "enum.ts": "export enum Color {\n  Red,\n}\n",
  });
  const errors = loadErrors(
    [],
    ["server.ts", "enum.ts"].map((name) => join(dir, name))
  );
  assert.deepEqual(
    errors.map(({ file, at }) => [file, at]),
    [[join(dir, "enum.ts"), "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX"]]
  );
  assert.ok(!existsSync(join(tmpdir(), "airlink-strip-ran")));
});

test("covers AirLink's server modules as well as package entries", () => {
  const entries = sourceEntries().map((file) =>
    file.slice(liveRoot.length + 1)
  );
  assert.ok(entries.includes("apps/airlink/server/runner.ts"));
  assert.ok(entries.includes("packages/protocol/src/tokens.ts"));
  assert.ok(entries.includes("packages/desktop/src/session.ts"));
  assert.ok(!entries.includes("apps/airlink/server/main.ts"));
  assert.deepEqual(parseOnlyEntries(), [
    join(liveRoot, "apps/airlink/server/main.ts"),
  ]);
  assert.ok(
    !entries.some(
      (file) => file.endsWith(".test.ts") || file.startsWith("packages/react/")
    )
  );
});

test("type-check refuses non-erasable syntax (TS1294)", () => {
  const dir = fixture({
    "tsconfig.json": JSON.stringify({
      extends: join(liveRoot, "tsconfig.base.json"),
      compilerOptions: { types: [] },
      include: ["*.ts"],
    }),
    "param.ts": parameterProperty,
  });
  const result = spawnSync(
    "npx",
    ["--no-install", "tsgo", "--noEmit", "-p", join(dir, "tsconfig.json")],
    { cwd: liveRoot, encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /TS1294/);
});
