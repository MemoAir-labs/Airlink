# @memo-air/media

A huddle's state and transcript in a Y.Doc, and LiveKit tokens on the server.

## Main exports

- `.` — `initMedia`, `readMediaState`, `addTranscript`, `readTranscript`, `startHuddle`,
  `readHuddleTranscript`.
- `./server` — `createMediaTokens` (LiveKit grants per actor, hidden participants included),
  `liveKitSpeaker` and `openAiTts` (server-side speech for the standalone live-server).

## Used by

`@memo-air/server` (the `media-token`, `transcript` and `speak` routes), `apps/airlink`
(tokens for `@memo-air/voice`) and `@memo-air/react`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
