const defaultWindowMs = 8000;
const echoShare = 0.6;
const minEchoWords = 3;

const wordsOf = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

// A laptop's speakers can leak an agent's voice into a person's microphone past the browser's echo
// canceller; a human line made mostly of what an agent just said is that leak, not the person.
export function createEchoFilter(windowMs = defaultWindowMs) {
  let said: { words: Set<string>; atMs: number }[] = [];
  return {
    agentSaid(text: string, atMs: number) {
      said = [
        ...said.filter((each) => atMs - each.atMs < windowMs),
        { words: new Set(wordsOf(text)), atMs },
      ];
    },
    isEcho(text: string, atMs: number) {
      const words = wordsOf(text);
      if (words.length < minEchoWords) {
        return false;
      }
      return said.some(
        (each) =>
          atMs - each.atMs < windowMs &&
          words.filter((word) => each.words.has(word)).length / words.length >=
            echoShare
      );
    },
  };
}

export type EchoFilter = ReturnType<typeof createEchoFilter>;
