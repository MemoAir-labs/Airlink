# @memo-air/react

The live views (docs, sheets, slides, canvas, browser, desktop, huddle, files and the space) and
their small UI kit, drawn behind a `LiveHost` contract that any app implements.

## Entries

Import only the views you draw: each subpath needs only its own optional peers.

| Import | Exports | Install alongside |
|---|---|---|
| `@memo-air/react` | `LiveHostProvider`, `useLiveHost`, `createLiveServerHost`, `LiveSpaceView` (takes `renderObject`), `useLiveDocSession`, `AgentCursors`, `PresenceStack`, `liveDocIcon`, `liveDocKindLabel`, `colorForId`, the `LiveHost` types | nothing |
| `@memo-air/react/doc` | `LiveDocView`: rich text with comments, margin and history | `@tiptap/react`, `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret` |
| `@memo-air/react/sheet` | `LiveSheetView` | nothing |
| `@memo-air/react/slides` | `LiveSlidesView` | the three TipTap packages above |
| `@memo-air/react/canvas` | `LiveCanvasView` | `@excalidraw/excalidraw` |
| `@memo-air/react/browser`, `/desktop`, `/runner`, `/file` | one view each | nothing |
| `@memo-air/react/media` | `LiveMediaView` (the huddle) | `livekit-client`, `@elevenlabs/client`, `@mediapipe/tasks-vision` (all three to bundle it; mediapipe is loaded only when perception is on) |
| `@memo-air/react/all` | `LiveObjectView`: any object, drawn by its kind | all of the above |
| `@memo-air/react/ui`, `@memo-air/react/theme.css` | the UI kit and the colour tokens (Tailwind 4) | nothing |

React 18 or 19 (`react`, `react-dom` `^18.3.1 || ^19.0.0`) is a peer. A missing optional peer fails your build with
the module's name.

## A live-server and nothing else

`createLiveServerHost({ liveUrl, docs, user, getToken })` is a `LiveHost` for an app that has only a
live-server and a token endpoint (the `room-react` template). History, exports, browser frames, call
tokens and sharing need a full host and show as unavailable.

## Used by

`apps/airlink/web` implements `LiveHost` in `host.tsx` and draws every kind through `/all`.

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
