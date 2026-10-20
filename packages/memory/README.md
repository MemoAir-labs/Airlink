# @memo-air/memory

An agent's memory as a folder of OKF documents: Markdown with YAML frontmatter, `type` required.
The folder is the whole store, so a person can read, edit and version it, or point it at an
Obsidian vault.

## Main exports

- `okfDirectoryStore(dir)` — creates the folder on first write, never overwrites a note, keeps
  every write inside the folder, keeps `index.md` and `log.md`, and reads hand-written notes.
- `memoryTools(store, { resource, gate })` — the `recall_memory` and `remember` tools.
- `memoryTypes`, `MemoryStore`, `MemoryEntry`.

## Used by

`@memo-air/bridge` serves the two tools to every agent. See
[docs/agents.md](../../docs/agents.md#memory).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
