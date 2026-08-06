# Compatibility

The current implementation targets DSH snapshot
`snapshots/20260806T160212Z-279244acb0` at
`b3adbb736ae7dd3c7857eee5d97c82a3ac4ac96f` and AlphaSolve `main` commit
`a336b85001d8c8cd7ea3147f7e224d5acb8c7534` recorded in
`THIRD_PARTY_NOTICES.md`.

- Runtime: Node.js `^22.19.0` or `>=24.0.0`.
- Package manager used for development: pnpm 11.
- Primary acceptance platform: Linux.
- Secondary design targets: macOS and Windows. Path validation understands both
  POSIX and Windows spellings even when running on the other platform.
- DSH surfaces: the `headless` and `web` profiles, plus custom profiles into
  which this package is explicitly installed.
- DSH installation: standard profile bundle metadata and
  `dsh plugin --profile <name> add ...`; no DSH source patch is required.
- DSH tool presentation: native is the acceptance baseline. In Code Mode the
  reserved `run_code` transport can remain schema-visible, but the runtime's
  scoped monotonic guard denies its execution.
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

The external package depends on snapshot-specific DSH peer packages. Snapshot branches
are independent roots, not a mergeable release train. A DSH update that changes
Agent lifecycle events, scoped ToolRegistry behavior, Session events,
role-Agent construction, profile composition, or bundle discovery must rebuild
DSH first and then run this repository's full tests and a real profile
composition probe before updating this compatibility pin.
