# @memo-air/runner

The `runner` kind's Y.Doc model: a code runner's public state (title, language, code, status, last
run, schedule, outputs, stdout and stderr tails), read and written as one validated map.

## Main exports

- `readRunnerState(doc)`, `writeRunnerState(doc, patch)`, `isRunnerDoc(doc)`, `runnerState(doc)`.
- `emptyRunnerState`, `runnerTailChars`, `notSetUpText`, `tailOf(text, maxChars)`.
- Types: `RunnerState`, `RunnerStatus`, `RunnerLanguage`, `RunnerOutput`.

## Used by

`apps/airlink` writes it after every run; `@memo-air/react`'s runner view reads it.
