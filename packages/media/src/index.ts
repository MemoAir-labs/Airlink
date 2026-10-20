import type * as Y from "yjs";

export type MediaActor = {
  kind: "human" | "agent";
  id: string;
  name: string;
};

export type TranscriptLine = {
  id: string;
  at: string;
  actor: MediaActor;
  text: string;
  final: boolean;
  cut?: boolean;
};

export type MediaState = {
  room: string;
  startedAt: string | null;
};

// A media room's durable half: when it started and what was said, attributed per speaker. The
// audio and video themselves travel over WebRTC and never enter the doc.
const transcriptCap = 2000;

export const mediaState = (doc: Y.Doc) => doc.getMap<unknown>("mediaState");
export const transcript = (doc: Y.Doc) =>
  doc.getArray<TranscriptLine>("transcript");

export function isMediaDoc(doc: Y.Doc): boolean {
  return typeof mediaState(doc).get("room") === "string";
}

export function initMedia(doc: Y.Doc, room: string) {
  const state = mediaState(doc);
  state.set("room", room);
  state.set("startedAt", new Date().toISOString());
}

export function readMediaState(doc: Y.Doc): MediaState {
  const state = mediaState(doc);
  const room = state.get("room");
  const startedAt = state.get("startedAt");
  return {
    room: typeof room === "string" ? room : "",
    startedAt: typeof startedAt === "string" ? startedAt : null,
  };
}

// An interim line is replaced in place by its final version, so a listener sees words appear as
// they are recognised and settle once the speaker pauses.
export function addTranscript(doc: Y.Doc, line: TranscriptLine) {
  const lines = transcript(doc);
  const index = lines.toArray().findIndex((l) => l.id === line.id);
  if (index >= 0) {
    lines.delete(index, 1);
    lines.insert(index, [line]);
  } else {
    lines.push([line]);
  }
  if (lines.length > transcriptCap) {
    lines.delete(0, lines.length - transcriptCap);
  }
}

// A huddle in a call that already had one: the transcript keeps every line, and the huddle's own
// are those since it started.
// ponytail: `at` is the server's clock and this is the browser's, so a skew of more than the gap
// before the first line drops it; stamp the start on the server if that bites.
export function startHuddle(doc: Y.Doc, at = new Date().toISOString()) {
  mediaState(doc).set("startedAt", at);
}

export function readHuddleTranscript(doc: Y.Doc): TranscriptLine[] {
  const { startedAt } = readMediaState(doc);
  return readTranscript(doc).filter(
    (line) => startedAt === null || line.at >= startedAt
  );
}

export function readTranscript(doc: Y.Doc, limit = 200): TranscriptLine[] {
  const lines = transcript(doc);
  return lines.slice(Math.max(0, lines.length - limit));
}
