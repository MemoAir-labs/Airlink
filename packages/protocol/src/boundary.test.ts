import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const liveRoot = join(import.meta.dirname, "../../..");
const forbiddenImport =
  /(from |import\()["'](@app\/|@front-api\/|@viz\/|swr["'/]|(\.\.\/)+(front|front-api|viz)\/)/;

function listFiles(dir: string, keep: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".packs" ||
      entry.name === ".astro"
    ) {
      return [];
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(path, keep);
    }
    return keep.test(entry.name) ? [path] : [];
  });
}

const listSourceFiles = (dir: string) => listFiles(dir, /\.tsx?$/);

// Airlink is published on its own: it names no upstream product it was carved from. Built from
// parts so this file does not match itself; a letter right before it, inside a longer word, is not.
const upstreamName = new RegExp(
  `(^|[^a-z])${["d", "u", "s", "t"].join("")}`,
  "i"
);

// The scope these packages had before AirLink was named, in parts so this file does not match it.
const oldScope = `@${["memoair", "live"].join("-")}`;

// The pre-launch scope, whose npm org belongs to someone else; in parts for the same reason.
const airlinkScope = `@${["air", "link"].join("")}/`;

const textFiles =
  /\.(tsx?|mjs|cjs|js|json|md|css|ya?ml|sh|html|txt)$|Dockerfile$|^\.env/;

describe("live/ boundary", () => {
  it("imports nothing from front, front-api or viz", () => {
    const offenders = listSourceFiles(liveRoot).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => forbiddenImport.test(line))
        .map((line) => `${file}: ${line.trim()}`)
    );
    expect(offenders).toEqual([]);
  });

  it("licenses every package MIT", () => {
    const unlicensed = listFiles(liveRoot, /^package\.json$/).filter(
      (file) =>
        !file.endsWith(join("live", "package.json")) &&
        JSON.parse(readFileSync(file, "utf8")).license !== "MIT"
    );
    expect(unlicensed).toEqual([]);
  });

  it("names no upstream product anywhere in the tree", () => {
    const mentions = listFiles(
      liveRoot,
      /\.(tsx?|mjs|cjs|js|json|md|css|ya?ml|sh|html)$|Dockerfile$|^\.env/
    ).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          upstreamName.test(line) ? [`${file}:${index + 1}`] : []
        )
    );
    expect(mentions).toEqual([]);
  });

  it("names the old package scope nowhere in the tree", () => {
    const mentions = listFiles(liveRoot, textFiles).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          line.includes(oldScope) ? [`${file}:${index + 1}`] : []
        )
    );
    expect(mentions).toEqual([]);
  });

  it("names the pre-launch package scope nowhere in the tree", () => {
    const mentions = listFiles(liveRoot, textFiles).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          line.includes(airlinkScope) ? [`${file}:${index + 1}`] : []
        )
    );
    expect(mentions).toEqual([]);
  });
});
