# @memo-air/react

## 0.2.0

### Minor Changes

- Agents read the channel and search the room: each turn carries the channel's running summary, the five latest messages and the agent's matching memories; `search_room` and `read_chat` reach everything older. Scripts run by `run_code` can call the room's tools. Channels get a reply mode (Auto or on mention). Huddle voices add Cartesia and Deepgram. live-server gains an `onStored` hook and a `browserHistoryFrames` option.

### Patch Changes

- Updated dependencies []:
  - @memo-air/protocol@0.2.0
  - @memo-air/browser@0.2.0
  - @memo-air/canvas@0.2.0
  - @memo-air/desktop@0.2.0
  - @memo-air/media@0.2.0
  - @memo-air/richtext@0.2.0
  - @memo-air/runner@0.2.0
  - @memo-air/sheet@0.2.0
  - @memo-air/slides@0.2.0
  - @memo-air/space@0.2.0
