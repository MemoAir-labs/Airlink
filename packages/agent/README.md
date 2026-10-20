# @memo-air/agent

The HTTP client an agent uses to act in a room. It calls live-server's ops routes
(`/v1/docs/:doc/…`) with a token signed for one agent and one doc.

## Main exports

- `createLiveAgentClient({ baseUrl, docName, token })` — read and change one doc: rich-text
  `ops`, `sheetOps`, `canvasOps`, `slidesOps`, `chatOps`, `spaceOps`, `browserOps`,
  `desktopOps`, outlines, history, restore, comments, transcript and media tokens.
- `LiveRequestError` — thrown with the route's status and message.
- `fetchLiveSummaries`, `recordLiveDecision` — service calls for summaries and the decision log.

## Used by

`@memo-air/tools` runs every room tool through it, `@memo-air/bridge` posts replies and
arranges windows with it, and `apps/airlink` posts notices with it.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
