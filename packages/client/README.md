# @memo-air/client

A client for a live room, for people's apps and agents alike: join with a token the host minted,
read and write the room's objects, subscribe to everything that happens, send input, speak, and
bind your own values into the room. What each caller may do is decided by the token.

## Main exports

- `joinRoom({ url, token, docName, presence })` — returns a `LiveRoom`.
- `bindValue` — keep one of your values in sync through the room.
- Types: `LiveRoom`, `RoomEvent`, `Peer`, `Binding`, `JoinOptions`.

## Used by

`templates/agent-node`. `livekit-client` is an optional peer dependency for huddles.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
