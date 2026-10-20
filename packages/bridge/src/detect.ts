import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Harnesses that speak ACP, natively or through their maintained adapter, offered when their CLI
// is on PATH (spec D4). dsh and hermes have no ACP mode yet, so they are not listed.
const knownHarnesses = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.93.0"],
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    command: ["npx", "-y", "@agentclientprotocol/codex-acp@2.2.2"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    bin: "gemini",
    command: ["gemini", "--acp"],
  },
  {
    id: "opencode",
    name: "opencode",
    bin: "opencode",
    command: ["opencode", "acp"],
  },
];

export type DetectedHarness = { id: string; name: string; command: string[] };

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false
  );

export async function detectHarnesses(
  searchPath: string = process.env.PATH ?? ""
): Promise<DetectedHarness[]> {
  const dirs = searchPath.split(delimiter).filter(Boolean);
  const found: DetectedHarness[] = [];
  for (const harness of knownHarnesses) {
    for (const dir of dirs) {
      if (await isExecutable(join(dir, harness.bin))) {
        found.push({
          id: harness.id,
          name: harness.name,
          command: harness.command,
        });
        break;
      }
    }
  }
  return found;
}
