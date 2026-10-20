// Prints the GitHub release notes for one version: the root CHANGELOG's section for it when there
// is one (the hand-written 0.1.0 entry), then each published package's section, skipping repeats
// (a fixed group writes the same "updated dependencies" lines into every package).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { liveRoot, publishedPackages } from "./packages.mjs";

export function sectionOf(markdown, version) {
  const lines = markdown.split("\n");
  const heading = new RegExp(
    `^## \\[?${version.replaceAll(".", "\\.")}\\]?(\\s|$)`
  );
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    return "";
  }
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ")
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

export function releaseNotes(version) {
  const seen = new Set();
  const sections = [];
  const root = sectionOf(
    readFileSync(join(liveRoot, "CHANGELOG.md"), "utf8"),
    version
  );
  if (root) {
    sections.push(root);
  }
  for (const { dir, manifest } of publishedPackages()) {
    const path = join(dir, "CHANGELOG.md");
    const section = existsSync(path)
      ? sectionOf(readFileSync(path, "utf8"), version)
      : "";
    if (section && !seen.has(section)) {
      seen.add(section);
      sections.push(`### ${manifest.name}\n\n${section}`);
    }
  }
  return sections.join("\n\n");
}

if (import.meta.main) {
  process.stdout.write(`${releaseNotes(process.argv[2])}\n`);
}
