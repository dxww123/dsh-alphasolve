/** Shared durable and model-facing types for AlphaSolve for DSH. */

/** Current on-disk state format. Unknown newer versions are rejected. */
export const STATE_VERSION = 1 as const

/** Roles that may receive an explicit model-route override. */
export const MODEL_ROLES = [
  'generator',
  'verifier',
  'reviser',
  'theorem_checker',
  'curator',
  'compute',
  'numerical_experiment',
  'research_reviewer',
  'reasoning',
] as const

/** One configurable AlphaSolve role. */
export type ModelRole = typeof MODEL_ROLES[number]

/** Per-role route fields; omitted fields inherit the orchestrator route. */
export interface ModelOverride {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Strict contents accepted from user- and project-level configuration files. */
export interface AlphaSolveFileConfig {
  readonly capacity?: number
  readonly detailedTrace?: boolean
  readonly models?: Readonly<Partial<Record<ModelRole, ModelOverride>>>
}

/** Fully resolved session configuration. */
export interface AlphaSolveConfig {
  readonly capacity: number
  readonly detailedTrace: boolean
  readonly models: Readonly<Partial<Record<ModelRole, ModelOverride>>>
}

/** Stable verifier order from AlphaSolve main. */
export const VERIFIER_PROFILES = [
  'format_references',
  'citation',
  'failure_modes',
  'stepwise',
  'premise_chain',
] as const

/** One verifier profile. */
export type VerifierProfile = typeof VERIFIER_PROFILES[number]

/** Persisted worker phase, suitable for progress cards and crash diagnostics. */
export type WorkerPhase =
  | 'created'
  | 'generator'
  | 'verifier'
  | 'reviser'
  | 'theorem_checker'
  | 'arbitrating'
  | 'promoting'
  | 'complete'

/** Worker terminal state. */
export type WorkerTerminalStatus =
  | 'verified'
  | 'solved'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'stale_problem'
  | 'write_conflict'
  | 'discarded_after_solution'

/** Durable record for one asynchronous worker. */
export interface WorkerRecord {
  readonly version: typeof STATE_VERSION
  readonly id: string
  readonly instruction?: string
  readonly phase: WorkerPhase
  readonly terminalStatus?: WorkerTerminalStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt?: string
  readonly problemDigest: string
  readonly hintDigest?: string
  readonly round: number
  readonly verifierProfile?: VerifierProfile
  readonly theoremChecks: number
  readonly propositionPath?: string
  readonly verifiedPath?: string
  readonly statement?: string
  readonly summary?: string
  readonly failureStage?: string
  readonly reason?: string
  readonly artifactPaths: readonly string[]
}

/** Exactly-once wait-delivery metadata stored with a completion. */
export interface CompletionDelivery {
  readonly reservedByCallId?: string
  readonly deliveredByCallId?: string
  readonly deliveredAt?: string
}

/** Durable worker completion. */
export interface WorkerCompletion extends CompletionDelivery {
  readonly version: typeof STATE_VERSION
  readonly sequence: number
  readonly workerId: string
  readonly status: WorkerTerminalStatus
  readonly startedAt: string
  readonly completedAt: string
  readonly problemDigest: string
  readonly hintDigest?: string
  readonly producedVerifiedProposition: boolean
  readonly solved: boolean
  readonly summary: string
  readonly statement?: string
  readonly propositionPath?: string
  readonly failureStage?: string
  readonly reason?: string
  readonly artifactPaths: readonly string[]
}

/** Runtime-level durable status. */
export type RuntimeStatus = 'active' | 'stopping' | 'interrupted' | 'solved'

/** Durable state shared by recovery, capacity management, and winner arbitration. */
export interface SessionState {
  readonly version: typeof STATE_VERSION
  readonly sessionId: string
  readonly workspace: string
  readonly activatedAt: string
  readonly updatedAt: string
  readonly status: RuntimeStatus
  readonly problemDigest: string
  readonly hintDigest?: string
  readonly notifiedHintDigest?: string
  readonly capacity: number
  readonly detailedTrace: boolean
  readonly modelOverrides: Readonly<Partial<Record<ModelRole, ModelOverride>>>
  readonly nextCompletionSequence: number
  readonly winnerWorkerId?: string
}

/** Curator queue item kinds preserved across restart. */
export type CuratorTaskKind = 'digest' | 'verifier_final' | 'health_check'

/** One durable, idempotent curator task. */
export interface CuratorTask {
  readonly version: typeof STATE_VERSION
  readonly id: string
  readonly kind: CuratorTaskKind
  readonly createdAt: string
  readonly sourceWorkerId?: string
  readonly tracePath?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
  readonly status: 'pending' | 'active' | 'completed' | 'failed'
  readonly attempts: number
  readonly lastError?: string
}

/** Result of the preflight activation tool. */
export interface ActivateResult {
  readonly activated: boolean
  readonly reason?: string
  readonly workspace: string
  readonly capacity?: number
  readonly resumed?: boolean
}

/** Immediate result of starting one worker. */
export interface WorkerStartResult {
  readonly accepted: boolean
  readonly workerId?: string
  readonly reason?: 'capacity_full' | 'problem_changed' | 'runtime_stopping' | 'invalid_instruction' | 'internal_error'
  readonly capacity: number
  readonly active: number
  readonly overCapacity: boolean
}

/** Result returned by the no-argument wait tool. */
export interface WorkerWaitResult {
  readonly status: 'completed' | 'no_active_workers'
  readonly completed: readonly WorkerCompletion[]
  readonly activeWorkerIds: readonly string[]
  readonly active: number
  readonly capacity: number
}

/** Result of changing the current hard worker capacity. */
export interface ConfigureResult {
  readonly previousCapacity: number
  readonly capacity: number
  readonly active: number
  readonly overCapacity: boolean
}

/** A safe workspace input and its content digest. */
export interface InputSnapshot {
  readonly path: string
  readonly content: string
  readonly digest: string
}

/** Validated activation-time workspace inputs. */
export interface WorkspaceSnapshot {
  readonly root: string
  readonly problem: InputSnapshot
  readonly hint?: InputSnapshot
  readonly solutionExists: boolean
}

/** File identity captured before a role mutates an active proposition. */
export interface FileStamp {
  readonly digest: string
  readonly size: number
  readonly mtimeMs: number
}
