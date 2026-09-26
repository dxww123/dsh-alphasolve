# Compatibility

The current implementation targets DSH `0.1.7-rc.2`, source commit
`477b4f420553e8a52c2fbccc464d7561b239c443` on `master`,
and AlphaSolve `main` commit
`a336b85001d8c8cd7ea3147f7e224d5acb8c7534` recorded in
`THIRD_PARTY_NOTICES.md`.

- Runtime: Node.js `^22.19.0` or `>=24.0.0`.
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
- DSH surfaces: the one-shot `headless` profile and long-lived `web` profile and Desktop `0.1.7-rc.2`,
  plus custom profiles into which this package is explicitly installed.
- DSH installation: standard profile bundle metadata and
  `dsh plugin --profile <name> add ...`; no DSH source patch is required.
- DSH Agent presets: `standard`, `cordis`, and `ptc` are supported. The plugin
  temporarily places its session in native tool presentation while active, so
  `run_code` remains denied even for `ptc`, and restores the original
  presentation when it unloads. `minimal`, or any custom preset without
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

The package pins the current DSH peer release and does not contain older API
adapters. Session restoration runs in the awaited `agent/created` hook.
AlphaSolve registers a Session projection for activation authorization and
committed wait acknowledgements; role output and activity use current scoped
events. All notices use the registered `alphasolve` message source.

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
