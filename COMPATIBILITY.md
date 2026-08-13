# Compatibility

The current implementation targets DSH snapshot
`snapshots/20260812T172954Z-final-unwatermarked-5fa48343c7` at
`7b9644f2b664e46c9518506035aa6c8d5af4d8e8` (DSH package family
`0.0.1-rc.2`) and AlphaSolve `main` commit
`a336b85001d8c8cd7ea3147f7e224d5acb8c7534` recorded in
`THIRD_PARTY_NOTICES.md`.

- Runtime: Node.js `^22.19.0` or `>=24.0.0`.
- Package manager used for development: pnpm 11.
- Primary acceptance platform: Linux.
- Secondary design targets: macOS and Windows. Path validation understands both
  POSIX and Windows spellings even when running on the other platform.
- DSH surfaces: the one-shot `headless` profile and long-lived `web` profile,
  plus custom profiles into which this package is explicitly installed.
- DSH installation: standard profile bundle metadata and
  `dsh plugin --profile <name> add ...`; no DSH source patch is required.
- DSH Agent presets: `standard`, `cordis`, and `code` are supported. The plugin
  temporarily places its session in native tool presentation while active, so
  `run_code` remains denied even for `code`, and restores the original
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
  `@deepseek-ai/*` package names, and model routing uses the snapshot's
  `ModelSelection` service.
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

The package depends on snapshot-specific DSH peer packages. A DSH update that
changes Agent lifecycle events, Agent preset composition, scoped ToolRuntime
behavior, Session events, model selection, role-Agent construction, profile
composition, or bundle discovery requires this repository's full tests plus
real Web and Headless profile probes before updating this compatibility pin.
`pnpm test:packed` additionally installs the built tarball with automatic peer
installation disabled, resolves its package-owned runtime dependencies from the
isolated consumer, and activates it through the real Cordis Loader; a config
dump alone is not a production-loader acceptance test.
