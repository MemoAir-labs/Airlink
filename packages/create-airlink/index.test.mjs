import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  packageManagerOf,
  packageNameOf,
  parseCli,
  pinImages,
  scaffold,
  shellPath,
} from "./index.mjs";

function templatesFixture() {
  const root = mkdtempSync(join(tmpdir(), "create-airlink-"));
  const room = join(root, "templates", "room-react");
  mkdirSync(room, { recursive: true });
  writeFileSync(
    join(room, "package.json"),
    JSON.stringify({
      name: "airlink-template-room-react",
      private: true,
      dependencies: { "@memo-air/react": "*", react: "^18.3.1" },
      devDependencies: { "@memo-air/protocol": "*", vite: "^7.3.1" },
    })
  );
  writeFileSync(join(room, "_gitignore"), "node_modules\n.env\n");
  writeFileSync(
    join(room, "_env.example"),
    "# shared with compose\nLIVE_JWT_SECRET=\n"
  );
  mkdirSync(join(root, "templates", "full"));
  writeFileSync(
    join(root, "templates", "full", "docker-compose.yml"),
    "services: {}\n"
  );
  return root;
}

test("reads the directory, the template and --no-install", () => {
  assert.deepEqual(parseCli(["my-app", "--template", "full", "--no-install"]), {
    dir: "my-app",
    template: "full",
    install: false,
    help: false,
  });
  assert.deepEqual(parseCli([]), {
    dir: null,
    template: null,
    install: true,
    help: false,
  });
  assert.equal(parseCli(["-t", "agent-node", "x"]).template, "agent-node");
});

test("installs with the package manager that ran it, npm otherwise", () => {
  assert.equal(
    packageManagerOf("pnpm/9.12.0 npm/? node/v22.18.0 darwin arm64"),
    "pnpm"
  );
  assert.equal(packageManagerOf("yarn/4.5.0 npm/? node/v22.18.0"), "yarn");
  assert.equal(packageManagerOf("bun/1.2.0 npm/? node/v22.18.0"), "bun");
  assert.equal(packageManagerOf("deno/2.0"), "npm");
  assert.equal(packageManagerOf(undefined), "npm");
});

test("copies the template, restores dotfiles, pins @memo-air, writes a secret", async () => {
  const root = templatesFixture();
  const dir = join(root, "My App");
  await scaffold({
    dir,
    template: "room-react",
    version: "0.3.1",
    templatesDir: join(root, "templates"),
  });
  assert.ok(existsSync(join(dir, ".gitignore")));
  assert.ok(!existsSync(join(dir, "_gitignore")));
  assert.ok(existsSync(join(dir, ".env.example")));
  assert.match(
    readFileSync(join(dir, ".env"), "utf8"),
    /^LIVE_JWT_SECRET=[0-9a-f]{64}$/m
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
    {
      name: "my-app",
      private: true,
      dependencies: { "@memo-air/react": "^0.3.1", react: "^18.3.1" },
      devDependencies: { "@memo-air/protocol": "^0.3.1", vite: "^7.3.1" },
    }
  );
});

test("scaffolds a template that has no package.json", async () => {
  const root = templatesFixture();
  const dir = join(root, "everything");
  await scaffold({
    dir,
    template: "full",
    version: "0.3.1",
    templatesDir: join(root, "templates"),
  });
  assert.ok(existsSync(join(dir, "docker-compose.yml")));
  assert.ok(!existsSync(join(dir, "package.json")));
});

test("refuses a non-empty directory and an unknown template", async () => {
  const root = templatesFixture();
  const busy = join(root, "busy");
  mkdirSync(busy);
  writeFileSync(join(busy, "keep.txt"), "");
  const templatesDir = join(root, "templates");
  await assert.rejects(
    scaffold({
      dir: busy,
      template: "room-react",
      version: "0.3.1",
      templatesDir,
    }),
    /is not empty/
  );
  await assert.rejects(
    scaffold({
      dir: join(root, "new"),
      template: "vue",
      version: "0.3.1",
      templatesDir,
    }),
    /Unknown template "vue"/
  );
});

test("pins the template's images to the release and names the package after its folder", () => {
  assert.equal(
    pinImages(
      "image: ghcr.io/memoair-labs/airlink-live-server:latest\nimage: ghcr.io/memoair-labs/airlink:latest\nimage: postgres:16-alpine\n",
      "0.3.1"
    ),
    "image: ghcr.io/memoair-labs/airlink-live-server:0.3.1\nimage: ghcr.io/memoair-labs/airlink:0.3.1\nimage: postgres:16-alpine\n"
  );
  assert.equal(packageNameOf("/tmp/My App"), "my-app");
});

test("takes the template positionally, as npm leaves it after eating --template", () => {
  assert.deepEqual(parseCli(["my-app", "full"]), {
    dir: "my-app",
    template: "full",
    install: true,
    help: false,
  });
  assert.deepEqual(parseCli(["my-app", "agent-node", "--no-install"]), {
    dir: "my-app",
    template: "agent-node",
    install: false,
    help: false,
  });
  assert.equal(
    parseCli(["my-app", "full", "--template", "room-react"]).template,
    "room-react"
  );
});

test("with no template and no terminal to ask in, exits with an error instead of guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "create-airlink-"));
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "index.mjs"), join(root, "app")],
    {
      input: "",
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No template given/);
  assert.ok(!existsSync(join(root, "app")));
});

function packFixture() {
  const root = mkdtempSync(join(tmpdir(), "create-airlink-pack-"));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const name of ["prepack.mjs", "index.mjs", "package.json"]) {
    write(
      `packages/create-airlink/${name}`,
      readFileSync(join(import.meta.dirname, name), "utf8")
    );
  }
  copyFileSync(
    join(import.meta.dirname, "../../LICENSE"),
    join(root, "LICENSE")
  );
  write(
    "templates/full/docker-compose.yml",
    "image: ghcr.io/memoair-labs/airlink:latest\n"
  );
  write("templates/full/data/agents.json", "[]\n");
  write("templates/room-react/.env.example", "LIVE_JWT_SECRET=\n");
  return { root, write, prepack: join(root, "packages/create-airlink") };
}

test("packs only the files git tracks, never what a local run left behind", () => {
  const { root, write, prepack } = packFixture();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "templates"], { cwd: root });
  write(
    "templates/full/data/settings.json",
    '{"anthropicApiKey":"sk-local"}\n'
  );
  write("templates/room-react/.env.local", "LIVE_JWT_SECRET=local\n");
  execFileSync(process.execPath, ["prepack.mjs"], { cwd: prepack });
  const out = join(prepack, "templates");
  assert.ok(existsSync(join(out, "full/data/agents.json")));
  assert.ok(existsSync(join(out, "room-react/_env.example")));
  const { version } = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8")
  );
  assert.ok(
    readFileSync(join(out, "full/docker-compose.yml"), "utf8").includes(
      `airlink:${version}`
    )
  );
  assert.ok(!existsSync(join(out, "full/data/settings.json")));
  assert.ok(!existsSync(join(out, "room-react/.env.local")));
});

test("refuses to pack outside a git checkout", () => {
  const { prepack } = packFixture();
  const result = spawnSync(process.execPath, ["prepack.mjs"], {
    cwd: prepack,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.ok(!existsSync(join(prepack, "templates")));
});

test("refuses a target that is a file, with a plain message", async () => {
  const root = templatesFixture();
  writeFileSync(join(root, "taken"), "");
  await assert.rejects(
    scaffold({
      dir: join(root, "taken"),
      template: "full",
      version: "0.1.0",
      templatesDir: join(root, "templates"),
    }),
    /taken is a file\. Pick a new or empty directory\./
  );
});

test("quotes the printed cd path only when a shell needs it", () => {
  assert.equal(shellPath("my-app"), "my-app");
  assert.equal(shellPath("../apps/my_app"), "../apps/my_app");
  assert.equal(shellPath("my app"), "'my app'");
  assert.equal(shellPath("it's"), "'it'\\''s'");
});
