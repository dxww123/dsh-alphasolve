# Compatibility

The current source checkout targets DSH `0.2.1-rc.3`, source commit
`22ddee3792402c3e70ec5f86a63c3e3e895a2f60` on `master`, 1533 commits after
tag `dsh-v0.2.1-rc.3` (`1f81c047fc48fa190a683e469daa699857e9afe8`),
and AlphaSolve `main` commit
`a336b85001d8c8cd7ea3147f7e224d5acb8c7534` recorded in
`THIRD_PARTY_NOTICES.md`.

The published npm package `dsh-alphasolve@0.4.0` targets DSH `0.2.0-rc.2`.
The updated peer requirements in this checkout have not been published to npm;
for this DSH source snapshot, build both checkouts and install AlphaSolve locally using the
[development instructions](docs/advanced.md#development-and-validation).
The rc.3 tag predates the projection and executor API changes used here;
the same version string does not make the released rc.3 binaries equivalent
to this source commit.

Windows validation on 2026-10-24 passed against the source commit above:
both frozen-lockfile installs; all 10 Harness build and aggregate checks with
its 364-file artifact digest verified; AlphaSolve Host/Client typechecking and
build; all 31 test files (294 passed, 4 existing platform skips); client-bundle
isolation; and packed installation through the real Cordis Loader with current
peers, package-owned dependencies, and confined Python/SymPy execution.
Real Headless profile probes activated AlphaSolve, restored the same Session
in a second process, and changed persisted capacity from 1 to 3. The Web
profile authenticated its launch token (303 plus cookie) and served its built
homepage (200). Model requests used a deterministic localhost fixture, with
no external fetches. Live-model mathematical quality, installed Desktop, and
macOS/Linux execution were not tested in this validation.

- Runtime: Node.js `>=24.9.0`.
- Package manager used for development: pnpm 11.
- Compute runtime: a dedicated Python environment with SymPy, prepared by
  `node scripts/setup-python.mjs` or selected with deployment `python.executable`.
  The `compute` and `numerical_experiment` helpers use `alphasolve_python` with
  per-helper persistent namespaces; no arithmetic-only fallback is retained.
  Their scopes require Harness `subprocess` and `sandbox` services. The process
  uses a read-only policy; Python denies project reads, writes, networking, and
  child processes. Windows reports partial process confinement; the Python
  policies do not provide a strong sandbox for hostile code or native extensions.
  Approved role file tools remain the source of project inputs.
- Migration validation platform: Windows.
- Additional design targets: macOS and Linux. Path validation understands both
  POSIX and Windows spellings even when running on the other platform.
- DSH surfaces: the one-shot `headless` profile, long-lived `web` profile,
  Desktop, and custom profiles into which this package is explicitly installed.
  The previous installed-Desktop probe covered `0.2.0-rc.2`; Desktop
  rc.3 has not been validated here.
- DSH installation: standard profile bundle metadata and
  `dsh plugin --profile <name> add ...`; no DSH source patch is required.
- DSH Agent presets: `standard` and `cordis` with native tool execution are
  supported. PTC activation and restoration are refused with
  `agent_executor_requires_native` before workspace changes. Select a native
  executor before using AlphaSolve. The plugin leaves the parent executor
  unchanged throughout preflight, runtime, and teardown; `run_code` remains
  denied during AlphaSolve preflight and role execution. `minimal`, or any custom preset without
  `read`, `write`, `edit`, `glob`, and `grep`, is rejected before activation
  with `agent_preset_missing_required_tools`; the plugin never widens the
  preset implicitly.
- A custom preset with a complete system prompt is rejected with
  `agent_preset_blocks_alphasolve_prompt`; activation never continues without
  an effective AlphaSolve orchestrator section.
- DSH composition: role Agents join the main session's existing preset
  generation, then receive AlphaSolve's scoped, role-specific restrictions.
  Cordis and DSH Service Definition packages remain host-provided peers;
  Schemastery is an ordinary package-owned runtime validator. All use their
  `@deepseek-ai/*` package names, and each role Agent receives its resolved model route at creation. A role
  inheriting the same provider/model also inherits reasoning effort; changing
  provider/model clears that effort unless the role explicitly configures it.
- Curator persistence requires Harness `sessionPersistence`. The durable queue
  reopens the same Session with `agents.resume`, rebuilding the task's scoped
  tools on every invocation. Native subagent descriptors remain read-only
  (`one-shot`): generic subagent continuation cannot reconstruct these tools.
  The plugin writes the supported versioned one-shot descriptor directly;
  Harness's descriptor factory now accepts only continuable children.
- AlphaSolve semantics: ordinary orchestrator/worker flow from local
  `main@a336b850`; MCTS is intentionally out of scope.

The port deliberately strengthens one boundary exposed by DeepSeek V4 Flash:
ordinary verifiers and the reviser do not receive the full original problem.
They judge and repair only the self-contained candidate proposition; the fresh
theorem checker is the sole consumer of `problem.md` for the solved decision.
This prevents a correct auxiliary proposition from being rejected merely for
not being the final answer. DSH-specific session isolation, durable wait
delivery, problem digests, two-phase promotion, and atomic winner publication
are retained as safety extensions.

This checkout pins DSH peers to `0.2.1-rc.3` and Cordis to `4.0.5`,
and does not contain older API adapters. Session restoration runs in the
awaited `agent/created` hook.
Harness checks `engines.dsh` when present and otherwise checks DSH
peers. AlphaSolve leaves `engines.dsh` undeclared and uses the peer rule.
AlphaSolve owns an asynchronously registered projection handle through
`AlphaSolveSessionStateService`; its activation and wait-acknowledgement state
remains version 1. Custom programmatic compositions using the low-level runtime
entry points mount that service before reading state. The controller mounts it
automatically and waits for registration before accepting events.
Role Agents mount the native executor for their lifetime. Parent Sessions retain
their existing executor because the latest Harness API has no reversible
presentation override. Ordinary forks, including parentless seeded Sessions,
remain excluded from dormant activation. Role creation continues to write in
Agent setup after Session publication, and durable role identity still requires
`origin: 'subagent'`. All notices use the registered `alphasolve` message source.

The package depends on release-specific DSH peer packages. A DSH update that
changes Agent lifecycle events, Agent preset composition, scoped ToolRuntime
behavior, Session events, model selection, role-Agent construction, profile
composition, or bundle discovery requires this repository's full tests plus
real Web and Headless profile probes before updating this compatibility pin.
`pnpm test:packed` additionally installs the built tarball with automatic peer
installation disabled, resolves its package-owned runtime dependencies from the
isolated consumer, checks peer versions against the local Harness, and activates
it through the real Cordis Loader and service implementations; a config
dump alone is not a production-loader acceptance test.

The 0.3.0 client bundle adds a session-scoped workflow sidebar using the shipped
workspace-file resource subscription and native one-shot Session viewer. Role
Sessions publish the current subagent descriptor and parent catalog; workers
remain multi-session workflows. The overview uses a versioned, atomic workspace
index instead of extending the stored Session event vocabulary. No Harness
source or installed Desktop patch is required.
