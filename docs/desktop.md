# Desktop

A desktop object is a Linux desktop in the channel's space. Everyone sees it live over WebRTC;
agents operate it with mouse, keyboard and screenshots through `open_live_desktop`,
`read_live_desktop` and `act_live_desktop`.

AirLink runs it one of two ways:

| Provider | When | Needs |
|---|---|---|
| Docker (`selfHostedDesktopProvider`) | Default, no key | The compose `desktop` service. |
| E2B (`e2bDesktopProvider`) | `E2B_API_KEY` is set | An E2B account. |

`AIRLINK_DESKTOP=off` turns the Docker desktop off. With no E2B key and the desktop off, desktop
objects are not available.

## The Docker desktop

`docker/desktop.Dockerfile` builds on neko's XFCE image (`ghcr.io/m1k1o/neko/xfce:3.2.0`) and adds
a terminal, the Thunar file manager, the Mousepad editor, `xdotool`, `scrot` and a small control
server (`docker/desktop/control.mjs`).

```sh
cd apps/airlink
docker compose up -d desktop
```

For LibreOffice and Firefox, build the image with the extras (it is much larger):

```sh
docker compose build --build-arg DESKTOP_EXTRAS=1 desktop
docker compose up -d desktop
```

### Ports

| Port | What |
|---|---|
| `127.0.0.1:3034` | The neko viewer the browser shows (`AIRLINK_DESKTOP_VIEWER_URL`). |
| `127.0.0.1:3035` | The control server AirLink drives (`AIRLINK_DESKTOP_CONTROL_URL`). Not 7000 on the host, because macOS's AirPlay Receiver listens there. |
| `52011/udp` | WebRTC media. |

### The control server

It turns AirLink's mouse, keyboard and screenshot calls into `xdotool` and `scrot` on neko's X
display. Every request needs the token (`AIRLINK_DESKTOP_TOKEN`, compose's
`DESKTOP_CONTROL_TOKEN`, default `airlink-desktop`). The checks keep each op to what it says:

- arguments are passed as arrays, never through a shell;
- key names that are `xdotool` commands are refused, so a key press cannot chain into `exec`;
- `launch` takes only a fixed list of apps (`terminal`, `files`, `editor`, `browser`, `writer`,
  `calc` and a few aliases);
- `open` takes only web and file URLs or absolute paths.

> [!WARNING]
> Whoever holds the token controls the whole desktop, its terminal included. The container is the
> security boundary. The control port is published on loopback only; if you ever expose it, change
> `AIRLINK_DESKTOP_TOKEN` (and the matching compose variable) first.

### One desktop at a time

There is one Docker desktop, so one desktop object holds it at a time. A second desktop object
says "The desktop is in use by another object." until the first is closed. A pool of desktop
containers, like the browser's, is a later step.

## E2B

Set `E2B_API_KEY` and AirLink runs each desktop object in its own E2B Desktop sandbox instead of
Docker. A sandbox lives for up to 55 minutes. The standalone live-server also reads
`LIVE_DESKTOP_TEMPLATE` for a custom E2B template; AirLink uses E2B's default.

## What agents see

Agents act on the desktop in steps of up to 20 actions (move, click, drag, scroll, keys, type,
open a URL or file, launch an app, wait), and each step returns a fresh screenshot.
`read_live_desktop` returns a screenshot, the screen size, who is driving and the last actions with
who took them. If a person is driving, the agent's action fails with their name and the agent
waits. The desktop's state and every action are kept in the desktop's own doc.
