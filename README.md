# AlphaSolve for DSH

[中文](README.zh-CN.md)

AlphaSolve for DSH integrates the
[AlphaSolve](https://github.com/tanzcoding/alphasolve) mathematical workflow
with DeepSeek Harness. The installed controller is dormant by default. It loads
the solver tools for one session only when the user explicitly mentions
`AlphaSolve` and asks it to solve the selected workspace's `problem.md`.

## Compatible DSH version

This version is built and tested against the following DSH snapshot:

```text
branch: snapshots/20260812T172954Z-final-unwatermarked-5fa48343c7
commit: 7b9644f2b664e46c9518506035aa6c8d5af4d8e8
package version: 0.0.1-rc.2
```

The plugin uses this snapshot's per-session Agent presets, scoped tool registry,
model-selection service, and scoped Cordis packages. Use the matching DSH build;
another snapshot is not covered by this compatibility statement.

## Installation

First make sure the installed `dsh` comes from the compatible snapshot above.
For a source checkout, build that exact revision with:

```sh
cd /path/to/deepseek-harness
git fetch origin
git switch snapshots/20260812T172954Z-final-unwatermarked-5fa48343c7
pnpm install
pnpm run build
```

For a GitHub installation, pin a full commit SHA and install the bundle into
both the Web and Headless profiles:

```sh
gh auth login -h github.com
gh auth setup-git
dsh plugin --profile web add 'github:dsh-external/dsh-alphasolve#<full-commit-sha>'
dsh plugin --profile headless add 'github:dsh-external/dsh-alphasolve#<full-commit-sha>'
```

To install from a local checkout:

```sh
cd /path/to/dsh-alphasolve
dsh plugin --profile web add .
dsh plugin --profile headless add .
```

Check the composed profiles without starting a model request:

```sh
dsh --version
dsh plugin --profile web list --depth 0
dsh plugin --profile headless list --depth 0
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

`dsh --version` should report `0.0.1-rc.2`; both dependency lists should show
`@dsh-external/dsh-alphasolve`; and each config dump should contain exactly one
`dsh-alphasolve` row. The Headless profile must use the current
`base + headless` composition, without the Web bundle. Install the plugin
separately into every custom profile that should support it. Restart a running
`dsh web` process after installation or upgrade; refreshing a browser tab alone
does not load new code.

## Usage

Place a non-empty UTF-8 `problem.md` in the terminal's starting directory or in
the directory selected by the `dsh web` workspace picker. `hint.md` is optional.

Headless is a one-shot surface: pass the complete AlphaSolve request as the task
argument. It creates a fresh persisted session, prints the final answer, and
exits:

```sh
cd /path/to/problem-workspace
dsh --profile headless "Use AlphaSolve to solve problem.md, with at most 2 workers."
```

For the long-lived Web surface, run:

```sh
dsh web
```

Select the workspace containing `problem.md`, then choose a compatible Agent
preset:

| Web preset | AlphaSolve behavior |
|---|---|
| `standard` | Supported. |
| `cordis` | Supported; AlphaSolve's narrower role permissions still apply. |
| `code` | Supported. While AlphaSolve is active, its tools use native presentation and `run_code` remains denied; unloading restores Code Mode. |
| `minimal` | Refused with `agent_preset_missing_required_tools`; the plugin never grants the missing capabilities implicitly. |

A custom preset is accepted only when it supplies `read`, `write`, `edit`,
`glob`, and `grep` and does not enforce a complete system prompt that suppresses
AlphaSolve's workflow sections. Prompt-incompatible presets are refused with
`agent_preset_blocks_alphasolve_prompt`. In the main Web session, make an
explicit AlphaSolve request, for example:

```text
Use AlphaSolve to solve the problem in the current workspace's problem.md, with at most 2 workers.
```

The triggering message must contain the whole word `AlphaSolve`
(ASCII-case-insensitive) and express intent to solve the problem. Merely
discussing AlphaSolve, explicitly negating its use, writing `alpha solve`, or
writing `alpha-solve` does not activate it. If `problem.md` is missing, the
controller reports that fact and remains dormant. If `solution.md` already
exists, the main session asks before backing it up and replacing it.

The default worker capacity is `2`. The triggering prompt may specify another
capacity, and the main session may adjust it while the runtime is active.
Lowering capacity does not cancel workers that are already running.

After a Web process restart, reopening the same session in the same workspace
automatically restores its previously activated AlphaSolve runtime before the
first follow-up is sent to the model. A short prompt such as `continue` is then
enough. A fresh session, a different session, or a session that called
`alphasolve_stop` remains dormant and still requires a new explicit AlphaSolve
request. Headless always creates a fresh session for its one-shot task and does
not provide an interactive continuation command.

## Workflow

1. The dormant controller examines direct user messages. When the keyword and
   solve intent match, preflight checks the session's Agent preset, required
   file tools, workspace, `problem.md`, optional `hint.md`, and any existing
   `solution.md`.
2. After preflight succeeds, a runtime is created only for that session.
   It initializes `knowledge/`, `unverified_propositions/`,
   `verified_propositions/`, and `.alphasolve/`.
3. The main session starts asynchronous workers with `alphasolve_worker`.
   Requests made at capacity return without queueing. Parameterless
   `alphasolve_wait` waits for the first completion and returns every completion
   not delivered by a previous successful wait.
4. Every worker runs the fixed pipeline:

   ```text
   generator
   -> all format/references, citation, failure-modes, stepwise, and premise-chain verifiers
   -> a fresh reviser repairs the same candidate and restarts all verifiers after a mathematical failure (up to 6 rounds)
   -> 5 independent theorem-checker decisions
   ```

5. Only propositions that pass the checks are promoted into
   `verified_propositions/`. A background curator can organize research
   material, and the main session can request a read-only research review before
   splitting the next worker tasks.
6. When a verified proposition solves the original problem, the plugin writes
   `solution.md` atomically. The final successful tool result is recorded first,
   then the runtime unloads before the next step. If the problem remains
   unsolved, the runtime stays active for further guidance and workers.
7. On same-session recovery, the plugin verifies the session identity,
   workspace, and `problem.md` digest, then restores the persisted capacity and
   model settings. A worker that was in flight when the old process stopped is
   reported once as `interrupted`, with its artifacts retained; the main
   session can inspect that completion and dispatch a replacement worker. The
   plugin does not pretend to resume an LLM call in the middle of a workflow
   phase.

Every worker is a fresh Agent joined to the same preset generation as its main
session, then narrowed by AlphaSolve's role-specific restrictions. Workers have
no shell, `run_code`, Web, or general subagent access. AlphaSolve tools, native
presentation override, prompts, capacity state, and permissions belong only to
the triggering session; other sessions in the same `dsh web` process do not
gain them.
