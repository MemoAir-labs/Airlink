import { randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

// An agent's memory is a folder of OKF documents: Markdown with YAML frontmatter where `type` is
// the one required field. The folder is the product — a person reads, edits and versions it, or
// points it at an Obsidian vault — so the store keeps no other state and reads what people wrote.

// OKF fixes no list of types; these are the ones an agent writes. Any other type is still read.
export const memoryTypes = [
  "person",
  "preference",
  "project",
  "decision",
  "fact",
  "procedure",
] as const;

export type MemoryEntry = {
  slug: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
  body: string;
};

export type MemoryWrite = {
  type: string;
  title: string;
  body: string;
  description?: string;
  resource?: string;
  tags?: string[];
};

export type MemoryStore = {
  list(): Promise<MemoryEntry[]>;
  read(query: string): Promise<MemoryEntry[]>;
  write(
    input: MemoryWrite
  ): Promise<{ ok: true; slug: string } | { ok: false; error: string }>;
};

// OKF reserves these two names at the bundle root.
const reserved = new Set(["index.md", "log.md"]);
const maxResults = 8;
const maxListed = 200;
const maxSlugChars = 60;

const slugOf = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxSlugChars)
    .replace(/-+$/, "") || "untitled";

const asString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// A person's vault is not ours to validate: frontmatter that is not YAML reads as none.
function frontmatterOf(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

function parseEntry(slug: string, text: string): MemoryEntry {
  const match = text.match(frontmatterPattern);
  const parsed: unknown = match ? frontmatterOf(match[1]) : null;
  const fields: Record<string, unknown> =
    parsed && typeof parsed === "object" ? { ...parsed } : {};
  const timestamp = fields.timestamp;
  return {
    slug,
    // A note with no frontmatter is still the person's knowledge; it reads as a plain note.
    type: asString(fields.type) ?? "note",
    title: asString(fields.title) ?? slug.split("/").at(-1) ?? slug,
    description: asString(fields.description),
    resource: asString(fields.resource),
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    timestamp:
      timestamp instanceof Date ? timestamp.toISOString() : asString(timestamp),
    body: match ? text.slice(match[0].length) : text,
  };
}

const occurrences = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

function scoreOf(entry: MemoryEntry, terms: string[]) {
  const title = entry.title.toLowerCase();
  const description = (entry.description ?? "").toLowerCase();
  const tags = entry.tags.join(" ").toLowerCase();
  const body = entry.body.toLowerCase();
  return terms.reduce(
    (score, term) =>
      score +
      3 * occurrences(title, term) +
      2 * occurrences(description, term) +
      2 * occurrences(tags, term) +
      occurrences(body, term),
    0
  );
}

export function okfDirectoryStore(dir: string): MemoryStore {
  // ponytail: a linear scan of the folder per call, fine to a few thousand notes; an in-memory
  // index invalidated by fs.watch, or the gbrain adapter, when a vault outgrows it.
  const list = async (): Promise<MemoryEntry[]> => {
    const names = await readdir(dir, { recursive: true }).catch(() => []);
    const paths = names.filter(
      (name) =>
        name.endsWith(".md") &&
        !reserved.has(name) &&
        !name.split(/[\\/]/).some((part) => part.startsWith("."))
    );
    return Promise.all(
      paths.map(async (path) =>
        parseEntry(
          relative(dir, join(dir, path))
            .replace(/\\/g, "/")
            .replace(/\.md$/, ""),
          await readFile(join(dir, path), "utf8")
        )
      )
    );
  };

  const writeIndex = async (entries: MemoryEntry[]) => {
    const lines = entries
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(
        (entry) =>
          `- [${entry.title}](${entry.slug}.md)${entry.description ? ` — ${entry.description}` : ""}`
      );
    await writeFile(join(dir, "index.md"), `# Memory\n\n${lines.join("\n")}\n`);
  };

  // Written to a temporary file and then linked into place: a crash never leaves half a note,
  // and the link fails rather than replace a note that already holds the name.
  const place = async (base: string, text: string): Promise<string> => {
    const temp = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temp, text);
    try {
      for (let n = 1; ; n++) {
        const slug = n === 1 ? base : `${base}-${n}`;
        try {
          await link(temp, join(dir, `${slug}.md`));
          return slug;
        } catch (err) {
          if (
            !(err instanceof Error && "code" in err && err.code === "EEXIST")
          ) {
            throw err;
          }
        }
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  };

  return {
    list,

    async read(query) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const entries = await list();
      if (terms.length === 0) {
        return entries;
      }
      return entries
        .map((entry) => ({ entry, score: scoreOf(entry, terms) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(({ entry }) => entry);
    },

    async write({ type, title, body, description, resource, tags }) {
      const timestamp = new Date().toISOString();
      const frontmatter = stringify({
        type,
        title,
        ...(description ? { description } : {}),
        ...(resource ? { resource } : {}),
        ...(tags?.length ? { tags } : {}),
        timestamp,
      });
      try {
        await mkdir(dir, { recursive: true });
        const slug = await place(
          slugOf(title),
          `---\n${frontmatter}---\n${body.endsWith("\n") ? body : `${body}\n`}`
        );
        await writeIndex(await list());
        await appendFile(
          join(dir, "log.md"),
          `- ${timestamp} wrote ${slug}.md (${type})\n`
        );
        return { ok: true, slug };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

const recallSchema = {
  query: z
    .string()
    .optional()
    .describe(
      "Words to look for in titles, tags and text. Leave empty to list everything you remember, one line each."
    ),
};

const rememberSchema = {
  type: z
    .enum(memoryTypes)
    .describe(
      "person, preference (including standing instructions), project, decision, fact or procedure."
    ),
  title: z
    .string()
    .min(1)
    .describe("A short name for the entry, such as 'Acme pricing contact'."),
  body: z
    .string()
    .min(1)
    .describe(
      "The entry in full sentences, with names and dates, readable on its own later."
    ),
  description: z
    .string()
    .optional()
    .describe("One line shown in the memory index."),
  tags: z.array(z.string()).optional(),
};

export type MemoryTool = {
  name: "recall_memory" | "remember";
  description: string;
  schema: z.ZodRawShape;
  run(args: unknown): Promise<{ ok: boolean; text: string }>;
};

const entryLine = (entry: MemoryEntry) =>
  `- ${entry.type} · ${entry.title} (${entry.slug})`;

const firstIssue = (error: z.ZodError) => error.issues[0]?.message ?? "invalid";

// The two tools an agent's harness gets over its store. `gate` is the host's check before a write
// and returns a reason to decline, or null; a host with no decision provider leaves it out.
export function memoryTools(
  store: MemoryStore,
  {
    resource,
    gate,
  }: {
    resource: string;
    gate?: (
      entry: z.infer<z.ZodObject<typeof rememberSchema>>
    ) => Promise<string | null>;
  }
): MemoryTool[] {
  return [
    {
      name: "recall_memory",
      description:
        "Search what you remembered in earlier conversations: people, preferences, projects, decisions, facts and procedures. Call it before work that may depend on earlier context, and before asking the person something they may already have told you. It does not search the room's live objects or the chat; use your other tools for those.",
      schema: recallSchema,
      run: async (args) => {
        const parsed = z.object(recallSchema).safeParse(args);
        if (!parsed.success) {
          return { ok: false, text: firstIssue(parsed.error) };
        }
        const query = parsed.data.query?.trim() ?? "";
        const entries = await store.read(query);
        if (entries.length === 0) {
          return {
            ok: true,
            text: query
              ? `Nothing you remember matches "${query}".`
              : "You have not remembered anything yet.",
          };
        }
        return {
          ok: true,
          text: query
            ? entries
                .map((entry) => `${entryLine(entry)}\n${entry.body.trim()}`)
                .join("\n\n")
            : [
                ...entries.slice(0, maxListed).map(entryLine),
                ...(entries.length > maxListed
                  ? [
                      `…and ${entries.length - maxListed} more; search with a query to find them.`,
                    ]
                  : []),
              ].join("\n"),
        };
      },
    },
    {
      name: "remember",
      description:
        "Save one thing worth knowing in a later conversation: a fact about a person or project, a preference or standing instruction, a decision and why, a procedure that worked. One idea per call, written to read on its own later. Not for progress on the current task, one-off numbers, or what is already in a shared document. Never save a password, card number or one-time code. An entry that only matters now may be declined; the result says so.",
      schema: rememberSchema,
      run: async (args) => {
        const parsed = z.object(rememberSchema).safeParse(args);
        if (!parsed.success) {
          return { ok: false, text: firstIssue(parsed.error) };
        }
        const declined = gate ? await gate(parsed.data) : null;
        if (declined) {
          return { ok: false, text: `Not saved: ${declined}` };
        }
        const written = await store.write({ ...parsed.data, resource });
        return written.ok
          ? { ok: true, text: `Remembered as ${written.slug}.` }
          : { ok: false, text: `Not saved: ${written.error}` };
      },
    },
  ];
}
