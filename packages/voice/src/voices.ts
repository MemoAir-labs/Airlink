import type { AgentConfig } from "@memo-air/agents";

export type SpeechProviderId = "elevenlabs" | "openai";
export type VoiceOption = { id: string; name: string };

const minSpeed = 0.8;
const maxSpeed = 1.2;

// Used until the provider's own list arrives (ElevenLabs' premade voices, OpenAI's fixed set).
export const defaultVoices: Record<SpeechProviderId, VoiceOption[]> = {
  elevenlabs: [
    { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
    { id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
    { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
    { id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
    { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli" },
    { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
    { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
    { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam" },
  ],
  openai: [
    { id: "coral", name: "Coral" },
    { id: "ash", name: "Ash" },
    { id: "sage", name: "Sage" },
    { id: "ballad", name: "Ballad" },
    { id: "nova", name: "Nova" },
    { id: "onyx", name: "Onyx" },
    { id: "shimmer", name: "Shimmer" },
    { id: "alloy", name: "Alloy" },
    { id: "echo", name: "Echo" },
    { id: "fable", name: "Fable" },
  ],
};

const hashOf = (text: string) =>
  [...text].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);

// An agent keeps the voice it was given if the provider still offers it; otherwise agents take
// voices in id order, each starting from its own hash and stepping past voices already taken, so the
// pick survives restarts and two agents sound different while the catalog lasts.
export function voiceFor(
  agent: AgentConfig,
  agents: AgentConfig[],
  catalog: VoiceOption[]
) {
  const speed = Math.min(maxSpeed, Math.max(minSpeed, agent.voice.speed));
  const offered = new Set(catalog.map((voice) => voice.id));
  const chosen = (each: AgentConfig) =>
    each.voice.id && offered.has(each.voice.id) ? each.voice.id : null;
  const own = chosen(agent);
  if (own) {
    return { id: own, speed };
  }
  const taken = new Set(
    agents.flatMap((each) => {
      const id = chosen(each);
      return id ? [id] : [];
    })
  );
  const all = [...agents.filter((each) => each.id !== agent.id), agent].sort(
    (a, b) => a.id.localeCompare(b.id)
  );
  let id = catalog[0]?.id ?? "";
  for (const each of all) {
    if (chosen(each)) {
      continue;
    }
    const start = hashOf(each.id) % catalog.length;
    const free = [...catalog.slice(start), ...catalog.slice(0, start)].find(
      (voice) => !taken.has(voice.id)
    );
    const picked = free?.id ?? catalog[start]?.id ?? "";
    taken.add(picked);
    if (each.id === agent.id) {
      id = picked;
    }
  }
  return { id, speed };
}
