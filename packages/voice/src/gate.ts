export const bargeInVoiceMs = 400;

const backchannels = new Set([
  "mm",
  "mhm",
  "mm-hm",
  "uh-huh",
  "yeah",
  "yes",
  "yep",
  "right",
  "ok",
  "okay",
  "sure",
  "cool",
  "nice",
  "ah",
  "oh",
  "hmm",
  "huh",
  "got",
  "it",
  "gotcha",
]);

const wordsOf = (text: string) =>
  text.toLowerCase().match(/[a-z0-9'-]+/g) ?? [];

// A person talking over an agent stops it only with real words held long enough; "mm-hm", a cough
// or a chair scrape does not.
export function isBargeIn({
  voicedMs,
  words,
}: {
  voicedMs: number;
  words: string;
}) {
  return (
    voicedMs >= bargeInVoiceMs &&
    wordsOf(words).some((word) => !backchannels.has(word))
  );
}
