# Security

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" on this repository
(Security → Advisories), not in a public issue. Include what you found, how to reproduce it and
what it gives an attacker. You will get an answer within a week.

## The model AirLink is built for

AirLink has no accounts. A person picks a name when they join, and the server signs a cookie for
it; anyone who can reach the server can join under any name. By default it listens on
`127.0.0.1` only and its API accepts only same-origin JSON from `localhost` and `127.0.0.1`, so a
web page you visit cannot drive your agents. Setting `AIRLINK_HOST=0.0.0.0` opens it to your
network: do that only on a network you trust.

What is in scope:

- An agent reading or changing an object outside its room, or beyond its configured access.
- A token for one doc working on another, or a forged or replayed token being accepted.
- The shared browser reaching a private address (its proxy only dials public addresses).
- A harness's own tools (shell, file writes) running without being refused.
- Keys stored in `.airlink/settings.json` leaking to the browser or a log.
- A person reaching a channel's docs, files or huddle without being a member of it.
- The desktop's control server accepting a request without its token, or running a command it
  should refuse (a shell, `xdotool` command chaining, an app outside its list).
- An uploaded file running as AirLink's own origin.

The full model, with a diagram, is in [docs/security.md](docs/security.md).

Out of scope: a person on a network you opened AirLink to joining under someone else's name, and
anything the desktop's own terminal can do inside its container.
