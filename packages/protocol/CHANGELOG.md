# @memo-air/protocol

## 0.2.0

### Minor Changes

- Agents read the channel and search the room: each turn carries the channel's running summary, the five latest messages and the agent's matching memories; `search_room` and `read_chat` reach everything older. Scripts run by `run_code` can call the room's tools. Channels get a reply mode (Auto or on mention). Huddle voices add Cartesia and Deepgram. live-server gains an `onStored` hook and a `browserHistoryFrames` option.
