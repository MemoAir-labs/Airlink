# @memo-air/decide

The decision node interface. A decision answers typed questions (`choice`, `score`, `noul`)
about a block of text with calibrated probabilities and no prose. A decision may have no opinion,
and every caller treats that as "fall through". Nothing here throws or hangs.

## Main exports

- `Decide`, `DecideInput`, `Question`, `Answer`, `Decision`.
- `systemOneProvider({ name, url, apiKey, model })` — any server speaking `POST /v1/systemone`
  (Laya locally, Jev by key).
- `noOpinion`, `withFallback`, `loggedDecide`, `hashState`, `decisionRecordSchema`.

## Used by

`@memo-air/agents` (routing), `@memo-air/server` (turns and the decision log),
`@memo-air/bridge` (`piDecide` implements `Decide`) and `apps/airlink`. See
[docs/architecture.md](../../docs/architecture.md#the-decision-node).

> [!NOTE]
> Not yet published to npm. It installs from this repository's workspaces; publishing is coming.
