# AlphaSolve for DSH

[中文](README.zh-CN.md)

AlphaSolve for DSH integrates the
[AlphaSolve](https://github.com/tanzcoding/alphasolve) mathematical workflow
with DeepSeek Harness. The installed controller is dormant by default. It loads
the solver tools for one session only when the user explicitly mentions
`AlphaSolve` and asks it to solve the selected workspace's `problem.md`.

## Compatible DSH version

This version targets the following DSH release and source revision:

```text
branch: master
commit: 477b4f420553e8a52c2fbccc464d7561b239c443
package version: 0.1.7-rc.2
```

The plugin requires DSH `0.1.7-rc.2`, Cordis `4.0.4`, declarative Agent presets,
Session projections, and the current Agent creation lifecycle. Older Harness
releases are unsupported.

## Installation

First make sure the installed `dsh` comes from the compatible release above.
For a source checkout, build that exact revision with:

```sh
cd /path/to/deepseek-harness
git fetch origin
git switch --detach 477b4f4205
pnpm install
pnpm run build
```

For a GitHub installation, pin a full commit SHA and install the bundle into
both the Web and Headless profiles:

```sh
gh auth login -h github.com
gh auth setup-git
dsh plugin --profile web add 'github:dxww123/dsh-alphasolve#<full-commit-sha>'
dsh plugin --profile headless add 'github:dxww123/dsh-alphasolve#<full-commit-sha>'
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

`dsh --version` should report `0.1.7-rc.2`; both dependency lists should show
`@dsh-external/dsh-alphasolve`; and each config dump should contain exactly one
`dsh-alphasolve` row. The Headless profile must use the current
`base + headless` composition, without the Web bundle. Install the plugin
separately into every custom profile that should support it. Restart a running
`dsh web` process after installation or upgrade; refreshing a browser tab alone
does not load new code.

## Desktop installation

Use DeepSeek Harness Desktop `0.1.7-rc.2`. Build this checkout with
`pnpm run build`, create a tarball with `pnpm pack`, and install that local
package through the desktop application's Plugin Manager. Restart the Host
when prompted. Desktop owns its own plugin profile; a Web or Headless CLI
installation does not install the plugin into Desktop. The CLI cannot modify
the Desktop profile.

## Python and SymPy

From this plugin checkout, create the dedicated Python environment before starting a compute helper:

```sh
node scripts/setup-python.mjs
```

The setup script requires Python 3.10 or newer and installs SymPy 1.14.0 and mpmath 1.3.0 under `${DSH_HOME:-~/.dsh}/runtimes/alphasolve-python`. This virtual environment disables system site packages. The plugin uses `Scripts/python.exe` on Windows and `bin/python` on macOS/Linux. It checks that SymPy imports when starting a helper and reports missing dependencies without substituting an arithmetic calculator. The Harness profile must provide the `subprocess` and `sandbox` services when a compute helper starts.

Both `compute` and `numerical_experiment` receive `alphasolve_python`. Each helper has a separate persistent Python process: imports, variables, functions, and exact SymPy objects survive its calls and disappear when the helper ends. A timeout, cancellation, or interpreter failure closes that process and the tool reports the reset; the next execution starts with a fresh namespace. Normal Python exceptions preserve the namespace. Successful results contain stdout, stderr, the final expression, truncation status, and SymPy's version. Print only the relevant values; code and output are bounded.

Python runs with Harness's read-only process policy and an additional Python policy restricting reads to its runtime dependencies. Retrieve project inputs through the helper's permitted file tools and put the needed definitions into code. Python cannot write project files, read other worker drafts, start subprocesses, or use the network. The Windows Harness read-only backend reports partial enforcement. The Python audit and syntax policies add restrictions for mathematical workloads; they are not a strong sandbox for hostile code or native extensions. Only these two helper roles get the tool; ordinary workflow roles retain their existing tool permissions.

To use another Python 3.10+ with SymPy 1.14.0 and mpmath 1.3.0 installed, set `python.executable` in the AlphaSolve plugin's deployment configuration. The other optional fields are `timeoutMs` (default `300000`), `maxOutputChars` (`65536`), `maxCodeChars` (`200000`), and `graceMs` (`1000`). These are positive integers no greater than `2147483647`; `maxOutputChars` must be at least `1024`. They belong to the plugin's Cordis configuration, not `.alphasolve/config.json` or model settings. For example, the plugin row may contain:

```yaml
name: '@dsh-external/dsh-alphasolve'
config:
  python:
    executable: 'C:/Python/python.exe'
    timeoutMs: 300000
```

Restart the Host after changing this deployment configuration. Existing mathematical Sessions and their stored transcripts are retained; Python memory is local to each live helper.

The `@dsh-external/dsh-alphasolve/python` entry exports `PythonSession` and `resolvePythonOptions` for embedding the same managed interpreter with Harness subprocess and sandbox providers.

## Inspect worker activity

In Desktop or Web, open the main conversation and click **AlphaSolve** in its header. The right sidebar groups the work by worker, then verification round. Active workers and the current round expand automatically; completed workers and earlier rounds remain collapsible. Each role shows its status and model-request step count. Select **View transcript** to open that role's native Harness conversation, including its messages and tool calls. Completed roles remain readable after their Agents are disposed. Delegated helpers appear under the role that created them.

A worker is a workflow, not a single subagent conversation. Its generator, verifier profiles, reviser, theorem checks, and supporting roles have separate Sessions. The ordinary left sidebar stays free of these role Sessions. Knowledge curation may continue after a worker finishes.

The overview follows the workspace file watcher and reads the session-owned index at `.alphasolve/workflows/<main-session-id>.json`. It does not depend on `detailedTrace`. Keep this directory together with the workspace and retain Harness's Session storage: the index holds navigation and progress, while Harness stores the transcripts. Restoring AlphaSolve marks unfinished observations from its previous runtime as interrupted.

This overview records role links created by version 0.3.0 and later. Earlier role transcripts are still stored by Harness but have no complete workflow index to reconstruct their grouping. After upgrading from a version without a client bundle, fully restart Desktop or the Web Host; a browser refresh alone is insufficient.

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
| `ptc` | Supported. While AlphaSolve is active, its tools use native presentation and `run_code` remains denied; unloading restores PTC presentation. |
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

The curator keeps one durable Session for the same main Session and problem generation, including after Desktop restarts or AlphaSolve reactivation. Each queued task restores that conversation with fresh task-local tools and permissions. It reuses its remembered wiki map and reads only relevant notes and current edit targets; health checks still inspect the root index. The Session ID is recorded in `.alphasolve/curator/session.json`, while Harness stores the conversation. A new main Session, changed problem, or a new generation after solving starts a separate curator conversation. Missing or corrupt saved history is reported as an error.

Every worker is a fresh Agent joined to the same preset generation as its main
session, then narrowed by AlphaSolve's role-specific restrictions. Workers have
no shell, `run_code`, Web, or general subagent access. AlphaSolve tools, native
presentation override, prompts, capacity state, and permissions belong only to
the triggering session; other sessions in the same `dsh web` process do not
gain them.

## Role file discovery

Standard file tools use paths relative to the session workspace, including inside worker roles. A generator receives the exact paths of its proposition and any worker hint. The task already contains the problem and available hints; optional files and indexes may be absent.

`glob` accepts an omitted `path`, `.`, or a workspace-absolute search base. It searches the role's readable roots and checks every result, including symlink targets, before returning paths or UI metadata. Broad generator searches expose only that worker's draft; verifier discovery retains its restricted inputs. `read`, `write`, and `edit` require workspace-relative paths; `grep` requires an explicit readable file or directory, such as `knowledge`.

Curator tools use workspace-relative `knowledge/...` paths. Curator list/grep also accept `.` as the knowledge root. A curator read whose requested end line exceeds the file length stops at EOF and returns the actual line range.

## Development and validation

Keep this checkout next to the matching `deepseek-harness` checkout. Development
dependencies link to its workspace packages; `vitest.config.ts` resolves tests
directly to the Harness source and uses its standard decorator transform.
Install and build Harness before compiling AlphaSolve or running the packed
installation probe.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run test:packed
```

The packed installation probe loads the tarball through the real Cordis Loader
and current Harness services in an isolated temporary consumer. It does not
make a model request. Model-backed mathematical quality and a desktop UI run
require separate verification with the configured model provider.

On Windows, validate against an installed desktop without changing its profile:

```sh
pnpm run test:desktop-load "C:/path/to/DeepSeek Harness"
```

This checks bundled peer versions and plugin loading under the installed
Electron host. It uses temporary application directories and does not open the
desktop UI or send a model request.
