import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { memoryTools, okfDirectoryStore } from "./index.ts";

const freshDir = () => mkdtemp(join(tmpdir(), "okf-"));

const frontmatterOf = (text: string) =>
  parse(text.split("---\n")[1] ?? "") as Record<string, unknown>;

describe("okfDirectoryStore", () => {
  it("writes an entry as OKF Markdown and reads it back by query", async () => {
    const dir = await freshDir();
    const store = okfDirectoryStore(dir);
    const written = await store.write({
      type: "fact",
      title: "Acme vendor price",
      body: "Acme quoted 1,200 per seat in October.",
      tags: ["vendor"],
      resource: "airlink:chat-1",
    });
    expect(written).toEqual({ ok: true, slug: "acme-vendor-price" });

    const [entry] = await store.read("vendor");
    expect(entry).toMatchObject({
      slug: "acme-vendor-price",
      type: "fact",
      title: "Acme vendor price",
      tags: ["vendor"],
      resource: "airlink:chat-1",
      body: "Acme quoted 1,200 per seat in October.\n",
    });

    const text = await readFile(join(dir, "acme-vendor-price.md"), "utf8");
    const frontmatter = frontmatterOf(text);
    expect(frontmatter.type).toBe("fact");
    expect(new Date(String(frontmatter.timestamp)).toISOString()).toBe(
      frontmatter.timestamp
    );
  });

  it("keeps index.md and log.md current", async () => {
    const dir = await freshDir();
    const store = okfDirectoryStore(dir);
    await store.write({
      type: "preference",
      title: "Short answers",
      description: "Wants replies under five lines",
      body: "Keep it short.",
    });
    await store.write({ type: "fact", title: "Office", body: "Berlin." });

    const index = await readFile(join(dir, "index.md"), "utf8");
    expect(index).toContain(
      "- [Short answers](short-answers.md) — Wants replies under five lines"
    );
    expect(index).toContain("- [Office](office.md)");
    const log = await readFile(join(dir, "log.md"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(2);
    expect((await store.list()).map((entry) => entry.slug).sort()).toEqual([
      "office",
      "short-answers",
    ]);
  });

  it("never overwrites: a second entry with the same title gets a suffix", async () => {
    const dir = await freshDir();
    const store = okfDirectoryStore(dir);
    await store.write({ type: "fact", title: "Plan", body: "first" });
    expect(
      await store.write({ type: "fact", title: "Plan", body: "second" })
    ).toEqual({ ok: true, slug: "plan-2" });
    expect(await readFile(join(dir, "plan.md"), "utf8")).toContain("first");
  });

  it("keeps every write inside its directory", async () => {
    const root = await freshDir();
    const dir = join(root, "agent");
    const store = okfDirectoryStore(dir);
    const written = await store.write({
      type: "fact",
      title: "../../etc/x",
      body: "nope",
    });
    expect(written).toEqual({ ok: true, slug: "etc-x" });
    expect((await readdir(root)).sort()).toEqual(["agent"]);
    expect(
      await store.write({ type: "fact", title: "///", body: "empty" })
    ).toEqual({ ok: true, slug: "untitled" });
  });

  it("reads a hand-written vault: unknown types, extra fields, nested notes, no frontmatter", async () => {
    const dir = await freshDir();
    await mkdir(join(dir, "meetings"), { recursive: true });
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    await writeFile(
      join(dir, "meetings", "kickoff.md"),
      "---\ntype: meeting\ntitle: Kickoff\nattendees: [Ana, Bo]\n---\nWe agreed on Q1.\n"
    );
    await writeFile(join(dir, "loose.md"), "Just a note about pricing.\n");
    await writeFile(join(dir, ".obsidian", "app.md"), "ignored");

    const entries = await okfDirectoryStore(dir).list();
    expect(entries.map((entry) => entry.slug).sort()).toEqual([
      "loose",
      "meetings/kickoff",
    ]);
    const [kickoff] = await okfDirectoryStore(dir).read("q1");
    expect(kickoff).toMatchObject({
      type: "meeting",
      title: "Kickoff",
      body: "We agreed on Q1.\n",
    });
    const [loose] = await okfDirectoryStore(dir).read("pricing");
    expect(loose).toMatchObject({ type: "note", title: "loose" });
  });

  it("ranks by matches and returns everything for an empty query", async () => {
    const dir = await freshDir();
    const store = okfDirectoryStore(dir);
    await store.write({ type: "fact", title: "Lunch", body: "pricing once" });
    await store.write({
      type: "fact",
      title: "Pricing",
      body: "pricing and more pricing",
    });
    expect((await store.read("pricing")).map((entry) => entry.slug)).toEqual([
      "pricing",
      "lunch",
    ]);
    expect(await store.read("  ")).toHaveLength(2);
    expect(await store.read("absent")).toEqual([]);
  });

  it("lists nothing on a missing directory and creates it on first write", async () => {
    const dir = join(await freshDir(), "later");
    const store = okfDirectoryStore(dir);
    expect(await store.list()).toEqual([]);
    expect(await store.write({ type: "fact", title: "A", body: "b" })).toEqual({
      ok: true,
      slug: "a",
    });
  });

  it("reads a note whose frontmatter is not YAML as a plain note, and keeps the rest", async () => {
    const dir = await freshDir();
    await writeFile(
      join(dir, "broken.md"),
      "---\ntype: [unclosed\n---\nStill text.\n"
    );
    await writeFile(join(dir, "fine.md"), "---\ntype: fact\n---\nFine.\n");
    const entries = await okfDirectoryStore(dir).list();
    expect(entries.map((entry) => [entry.slug, entry.type]).sort()).toEqual([
      ["broken", "note"],
      ["fine", "fact"],
    ]);
  });

  it("lists at most 200 entries on an empty recall and points at search", async () => {
    const dir = await freshDir();
    await Promise.all(
      Array.from({ length: 205 }, (_, n) =>
        writeFile(join(dir, `n${n}.md`), `---\ntype: fact\n---\n${n}\n`)
      )
    );
    const [recall] = memoryTools(okfDirectoryStore(dir), { resource: "test" });
    const { text } = await recall.run({});
    expect(text.split("\n")).toHaveLength(201);
    expect(text).toContain("…and 5 more; search with a query to find them.");
  });
});
