# AlphaSolve for DSH

[中文](README.zh-CN.md)

AlphaSolve for DSH integrates the AlphaSolve mathematical workflow with
DeepSeek Harness. The installed controller is dormant by default. It loads the
solver tools for one session only when the user explicitly mentions
`AlphaSolve` and asks it to solve the selected workspace's `problem.md`.

## Compatible DSH version

This version is built and tested against the following DSH snapshot:

```text
branch: snapshots/20260806T160212Z-279244acb0
commit: b3adbb736ae7dd3c7857eee5d97c82a3ac4ac96f
```

The plugin uses this snapshot's profile-bundle and scoped Agent lifecycle APIs.
DSH snapshot branches are independent roots; do not merge or rebase an older
snapshot into this one.

## Installation

First switch to and install the compatible DSH snapshot:

```sh
cd /path/to/deepseek-harness
git fetch origin
git switch snapshots/20260806T160212Z-279244acb0
sh scripts/install.sh
(cd ~/.dsh/source/current && pnpm run build)
```

For a GitHub installation, pin a full commit SHA and install the bundle into
both the Web and terminal profiles:

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
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

Each output should contain one `dsh-alphasolve` row. Install the bundle
separately into every custom profile that should support it. Restart the
corresponding `dsh` or `dsh web` process after installation or upgrade;
refreshing a browser tab alone does not load new code.

## Usage

Place a non-empty UTF-8 `problem.md` in the terminal's starting directory or in
the directory selected by the `dsh web` workspace picker. `hint.md` is optional.
For the terminal surface, run:

```sh
cd /path/to/problem-workspace
dsh --profile headless
```

For the Web surface, run:

```sh
dsh web
```

Then make an explicit AlphaSolve request in the main session, for example:

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

## Workflow

1. The dormant controller examines direct user messages. When the keyword and
   solve intent match, preflight checks the workspace, `problem.md`, optional
   `hint.md`, and any existing `solution.md`.
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

Every worker is a fresh Agent without shell, arbitrary code execution, Web, or
general subagent access. AlphaSolve tools, prompts, capacity state, and
permissions belong only to the triggering session; other sessions in the same
`dsh web` process do not gain those tools.
