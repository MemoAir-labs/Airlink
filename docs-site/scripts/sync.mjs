// Copies the repo's markdown into Starlight's content folder before every docs build, so GitHub and
// the site read one source: the root README, docs/*.md, each published package's README and each
// template's README. The first H1 becomes the page title; relative links become site routes, or
// GitHub links for files the site does not publish. Also writes llms.txt with absolute links.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import { liveRoot, publishedPackages } from "../../scripts/packages.mjs";

export const siteBase = "/Airlink/docs/";
export const siteOrigin = "https://memoair-labs.github.io";
const repoBlob = "https://github.com/MemoAir-labs/Airlink/blob/main/";
const contentDir = join(import.meta.dirname, "../src/content/docs");
const publicDir = join(import.meta.dirname, "../public");

// Repo path → route under the docs base; "" is the docs home.
export function pagesOf() {
  const pages = new Map([["README.md", ""]]);
  for (const name of readdirSync(join(liveRoot, "docs")).filter((file) =>
    file.endsWith(".md")
  )) {
    pages.set(`docs/${name}`, name.slice(0, -3));
  }
  for (const { dir } of publishedPackages()) {
    if (existsSync(join(dir, "README.md"))) {
      pages.set(
        `packages/${basename(dir)}/README.md`,
        `packages/${basename(dir)}`
      );
    }
  }
  for (const name of readdirSync(join(liveRoot, "templates"))) {
    if (existsSync(join(liveRoot, "templates", name, "README.md"))) {
      pages.set(`templates/${name}/README.md`, `templates/${name}`);
    }
  }
  return pages;
}

export function titleAndBody(markdown, fallback) {
  const heading = markdown.match(/^# (.+)$/m);
  return heading
    ? {
        title: heading[1].trim(),
        body: markdown.replace(`${heading[0]}\n`, ""),
      }
    : { title: fallback, body: markdown };
}

export function rewriteLinks(markdown, fromPath, pages, prefix) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, target) => {
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) {
      return link;
    }
    const [path, hash] = target.split("#");
    const repoPath = posix.normalize(posix.join(posix.dirname(fromPath), path));
    const anchor = hash ? `#${hash}` : "";
    const route = pages.get(repoPath);
    return route === undefined
      ? `](${repoBlob}${repoPath}${anchor})`
      : `](${prefix}${route}${route ? "/" : ""}${anchor})`;
  });
}

if (import.meta.main) {
  const pages = pagesOf();
  rmSync(contentDir, { recursive: true, force: true });
  for (const [repoPath, route] of pages) {
    const { title, body } = titleAndBody(
      readFileSync(join(liveRoot, repoPath), "utf8"),
      route || "AirLink"
    );
    const out = join(contentDir, route ? `${route}.md` : "index.md");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `---\ntitle: ${JSON.stringify(title)}\n---\n\n${rewriteLinks(body, repoPath, pages, siteBase).trimStart()}`
    );
  }
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(
    join(publicDir, "llms.txt"),
    rewriteLinks(
      readFileSync(join(liveRoot, "llms.txt"), "utf8"),
      "llms.txt",
      pages,
      `${siteOrigin}${siteBase}`
    )
  );
  process.stdout.write(`sync: ${pages.size} pages\n`);
}
