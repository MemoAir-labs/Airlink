# @memo-air/chat

A channel's chat: one Y.Array of messages. People post through their own connection; agents post
through `chat-ops`, which streams a message by appending to it. Chat is never binding.

## Main exports

- `postMessage`, `appendMessageText`, `editMessage`, `react`.
- `readMessages`, `observeNewMessages`, `isChatDoc`.
- Types: `ChatMessage`, `ChatActor`, `ChatMention`, `ChatAttachment`.

## Used by

`@memo-air/server` (chat ops and message turns) and `apps/airlink`, which reads who wrote in
each channel.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
