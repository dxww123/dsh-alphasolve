/** Durable AlphaSolve state, worker records, and exactly-once completion ledger. */

import { lstat, readdir } from 'node:fs/promises'
import { atomicWriteJson, DurableDataError, readJsonObject } from './atomic.js'
import {
  MODEL_ROLES,
  STATE_VERSION,
  VERIFIER_PROFILES,
  type ModelOverride,
  type ModelRole,
  type SessionState,
  type WorkerCompletion,
  type WorkerRecord,
} from './types.js'
import { normalizeRelativePath, resolveWorkspacePath } from './workspace.js'

interface WorkerTraceManifest {
  readonly version: typeof STATE_VERSION
  readonly workerId: string
  readonly paths: readonly string[]
}

/** Serialize asynchronous state transactions inside one workspace-owning runtime. */
class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    const gate = Promise.withResolvers<void>()
    this.tail = previous.then(() => gate.promise)
    await previous
    try {
      return await operation()
    } finally {
      gate.resolve()
    }
  }
}

function expectExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) throw new DurableDataError(`unknown fields: ${extras.join(', ')}`, path)
}

function expectString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value === '') throw new DurableDataError(`field ${field} must be a non-empty string`, path)
  return value
}

function expectOptionalString(value: unknown, field: string, path: string): string | undefined {
  return value === undefined ? undefined : expectString(value, field, path)
}

function expectIsoDate(value: unknown, field: string, path: string): string {
  const text = expectString(value, field, path)
  if (Number.isNaN(Date.parse(text))) throw new DurableDataError(`field ${field} must be an ISO date`, path)
  return text
}

function requireCallId(callId: string): void {
  if (typeof callId !== 'string' || callId.trim() === '') throw new TypeError('callId must not be empty')
}

function requireWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workerId)) {
    throw new TypeError(`invalid worker id: ${workerId}`)
  }
}

function requireTracePath(tracePath: string): string {
  const normalized = normalizeRelativePath(tracePath)
  if (normalized !== tracePath || !normalized.startsWith('.alphasolve/traces/')) {
    throw new TypeError(`trace artifact must be a canonical path below .alphasolve/traces/: ${tracePath}`)
  }
  return normalized
}

function parseTraceManifest(
  value: Record<string, unknown>,
  manifestPath: string,
  workerId: string,
): WorkerTraceManifest {
  expectExactKeys(value, ['version', 'workerId', 'paths'], manifestPath)
  if (value.version !== STATE_VERSION) throw new DurableDataError('unsupported trace-manifest version', manifestPath)
  if (value.workerId !== workerId) throw new DurableDataError('trace manifest worker id does not match', manifestPath)
  if (!Array.isArray(value.paths) || value.paths.some(item => typeof item !== 'string')) {
    throw new DurableDataError('trace manifest paths must be a string array', manifestPath)
  }
  let paths: string[]
  try {
    paths = value.paths.map(item => requireTracePath(item as string))
  } catch (error) {
    throw new DurableDataError('trace manifest contains an invalid path', manifestPath, { cause: error })
  }
  if (new Set(paths).size !== paths.length) throw new DurableDataError('trace manifest contains duplicate paths', manifestPath)
  return { version: STATE_VERSION, workerId, paths }
}

function expectPositiveInteger(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new DurableDataError(`field ${field} must be a positive safe integer`, path)
  }
  return value
}

function expectNonNegativeInteger(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DurableDataError(`field ${field} must be a non-negative safe integer`, path)
  }
  return value
}

function parseModelOverrides(value: unknown, path: string): Partial<Record<ModelRole, ModelOverride>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableDataError('modelOverrides must be an object', path)
  }
  const object = value as Record<string, unknown>
  expectExactKeys(object, MODEL_ROLES, path)
  const result: Partial<Record<ModelRole, ModelOverride>> = {}
  for (const role of MODEL_ROLES) {
    const candidate = object[role]
    if (candidate === undefined) continue
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new DurableDataError(`modelOverrides.${role} must be an object`, path)
    }
    const fields = candidate as Record<string, unknown>
    expectExactKeys(fields, ['provider', 'model', 'reasoningEffort'], path)
    const override: { provider?: string; model?: string; reasoningEffort?: string } = {}
    if (fields.provider !== undefined) override.provider = expectString(fields.provider, `${role}.provider`, path)
    if (fields.model !== undefined) override.model = expectString(fields.model, `${role}.model`, path)
    if (fields.reasoningEffort !== undefined) {
      override.reasoningEffort = expectString(fields.reasoningEffort, `${role}.reasoningEffort`, path)
    }
    result[role] = override
  }
  return result
}

/** Parse persisted session state and reject corruption or a future format. */
export function parseSessionState(value: Record<string, unknown>, path: string): SessionState {
  expectExactKeys(value, [
    'version', 'sessionId', 'workspace', 'activatedAt', 'updatedAt', 'status',
    'problemDigest', 'hintDigest', 'notifiedHintDigest', 'capacity', 'detailedTrace',
    'modelOverrides', 'nextCompletionSequence', 'winnerWorkerId',
  ], path)
  if (value.version !== STATE_VERSION) throw new DurableDataError('unsupported state version', path)
  if (!['active', 'stopping', 'interrupted', 'solved'].includes(String(value.status))) {
    throw new DurableDataError('invalid runtime status', path)
  }
  if (typeof value.detailedTrace !== 'boolean') throw new DurableDataError('detailedTrace must be boolean', path)
  const result: SessionState = {
    version: STATE_VERSION,
    sessionId: expectString(value.sessionId, 'sessionId', path),
    workspace: expectString(value.workspace, 'workspace', path),
    activatedAt: expectIsoDate(value.activatedAt, 'activatedAt', path),
    updatedAt: expectIsoDate(value.updatedAt, 'updatedAt', path),
    status: value.status as SessionState['status'],
    problemDigest: expectString(value.problemDigest, 'problemDigest', path),
    capacity: expectPositiveInteger(value.capacity, 'capacity', path),
    detailedTrace: value.detailedTrace,
    modelOverrides: parseModelOverrides(value.modelOverrides, path),
    nextCompletionSequence: expectPositiveInteger(value.nextCompletionSequence, 'nextCompletionSequence', path),
    ...expectOptionalString(value.hintDigest, 'hintDigest', path) === undefined
      ? {}
      : { hintDigest: value.hintDigest as string },
    ...expectOptionalString(value.notifiedHintDigest, 'notifiedHintDigest', path) === undefined
      ? {}
      : { notifiedHintDigest: value.notifiedHintDigest as string },
    ...expectOptionalString(value.winnerWorkerId, 'winnerWorkerId', path) === undefined
      ? {}
      : { winnerWorkerId: value.winnerWorkerId as string },
  }
  return result
}

/** Parse enough completion fields to make wait delivery fail closed. */
export function parseCompletion(value: Record<string, unknown>, path: string): WorkerCompletion {
  expectExactKeys(value, [
    'version', 'sequence', 'workerId', 'status', 'startedAt', 'completedAt',
    'problemDigest', 'hintDigest',
    'producedVerifiedProposition', 'solved', 'summary', 'statement', 'propositionPath',
    'failureStage', 'reason', 'artifactPaths', 'reservedByCallId',
    'deliveredByCallId', 'deliveredAt',
  ], path)
  if (value.version !== STATE_VERSION) throw new DurableDataError('unsupported completion version', path)
  const statuses = [
    'verified', 'solved', 'rejected', 'failed', 'cancelled', 'interrupted',
    'stale_problem', 'write_conflict', 'discarded_after_solution',
  ]
  if (!statuses.includes(String(value.status))) throw new DurableDataError('invalid completion status', path)
  if (typeof value.producedVerifiedProposition !== 'boolean' || typeof value.solved !== 'boolean') {
    throw new DurableDataError('completion booleans are invalid', path)
  }
  if (!Array.isArray(value.artifactPaths) || value.artifactPaths.some(item => typeof item !== 'string')) {
    throw new DurableDataError('artifactPaths must be a string array', path)
  }
  const reservedByCallId = expectOptionalString(value.reservedByCallId, 'reservedByCallId', path)
  const deliveredByCallId = expectOptionalString(value.deliveredByCallId, 'deliveredByCallId', path)
  const deliveredAt = expectOptionalString(value.deliveredAt, 'deliveredAt', path)
  if ((deliveredByCallId === undefined) !== (deliveredAt === undefined)) {
    throw new DurableDataError('deliveredByCallId and deliveredAt must be present together', path)
  }
  if (deliveredByCallId !== undefined && deliveredByCallId !== reservedByCallId) {
    throw new DurableDataError('delivered completion must retain the matching reservation call id', path)
  }
  if (deliveredAt !== undefined) expectIsoDate(deliveredAt, 'deliveredAt', path)
  return {
    version: STATE_VERSION,
    sequence: expectPositiveInteger(value.sequence, 'sequence', path),
    workerId: expectString(value.workerId, 'workerId', path),
    status: value.status as WorkerCompletion['status'],
    startedAt: expectIsoDate(value.startedAt, 'startedAt', path),
    completedAt: expectIsoDate(value.completedAt, 'completedAt', path),
    problemDigest: expectString(value.problemDigest, 'problemDigest', path),
    producedVerifiedProposition: value.producedVerifiedProposition,
    solved: value.solved,
    summary: expectString(value.summary, 'summary', path),
    artifactPaths: value.artifactPaths,
    ...expectOptionalString(value.hintDigest, 'hintDigest', path) === undefined
      ? {}
      : { hintDigest: value.hintDigest as string },
    ...expectOptionalString(value.statement, 'statement', path) === undefined ? {} : { statement: value.statement as string },
    ...expectOptionalString(value.propositionPath, 'propositionPath', path) === undefined
      ? {}
      : { propositionPath: value.propositionPath as string },
    ...expectOptionalString(value.failureStage, 'failureStage', path) === undefined
      ? {}
      : { failureStage: value.failureStage as string },
    ...expectOptionalString(value.reason, 'reason', path) === undefined ? {} : { reason: value.reason as string },
    ...reservedByCallId === undefined ? {} : { reservedByCallId },
    ...deliveredByCallId === undefined ? {} : { deliveredByCallId },
    ...deliveredAt === undefined ? {} : { deliveredAt },
  }
}

/** Parse a worker snapshot strictly before recovery mutates or reports it. */
export function parseWorkerRecord(value: Record<string, unknown>, path: string): WorkerRecord {
  expectExactKeys(value, [
    'version', 'id', 'instruction', 'phase', 'terminalStatus', 'createdAt',
    'updatedAt', 'completedAt', 'problemDigest', 'hintDigest', 'round',
    'verifierProfile', 'theoremChecks', 'propositionPath', 'verifiedPath',
    'statement', 'summary', 'failureStage', 'reason', 'artifactPaths',
  ], path)
  if (value.version !== STATE_VERSION) throw new DurableDataError('unsupported worker version', path)
  const phases: readonly WorkerRecord['phase'][] = [
    'created', 'generator', 'verifier', 'reviser', 'theorem_checker',
    'arbitrating', 'promoting', 'complete',
  ]
  const statuses: readonly NonNullable<WorkerRecord['terminalStatus']>[] = [
    'verified', 'solved', 'rejected', 'failed', 'cancelled', 'interrupted',
    'stale_problem', 'write_conflict', 'discarded_after_solution',
  ]
  if (typeof value.phase !== 'string' || !phases.includes(value.phase as WorkerRecord['phase'])) {
    throw new DurableDataError('invalid worker phase', path)
  }
  if (value.terminalStatus !== undefined
    && (typeof value.terminalStatus !== 'string'
      || !statuses.includes(value.terminalStatus as NonNullable<WorkerRecord['terminalStatus']>))) {
    throw new DurableDataError('invalid worker terminalStatus', path)
  }
  if (value.verifierProfile !== undefined
    && (typeof value.verifierProfile !== 'string'
      || !VERIFIER_PROFILES.includes(value.verifierProfile as (typeof VERIFIER_PROFILES)[number]))) {
    throw new DurableDataError('invalid worker verifierProfile', path)
  }
  if (!Array.isArray(value.artifactPaths) || value.artifactPaths.some(item => typeof item !== 'string')) {
    throw new DurableDataError('worker artifactPaths must be a string array', path)
  }
  return {
    version: STATE_VERSION,
    id: expectString(value.id, 'id', path),
    ...expectOptionalString(value.instruction, 'instruction', path) === undefined
      ? {}
      : { instruction: value.instruction as string },
    phase: value.phase as WorkerRecord['phase'],
    ...value.terminalStatus === undefined
      ? {}
      : { terminalStatus: value.terminalStatus as NonNullable<WorkerRecord['terminalStatus']> },
    createdAt: expectIsoDate(value.createdAt, 'createdAt', path),
    updatedAt: expectIsoDate(value.updatedAt, 'updatedAt', path),
    ...value.completedAt === undefined
      ? {}
      : { completedAt: expectIsoDate(value.completedAt, 'completedAt', path) },
    problemDigest: expectString(value.problemDigest, 'problemDigest', path),
    ...expectOptionalString(value.hintDigest, 'hintDigest', path) === undefined
      ? {}
      : { hintDigest: value.hintDigest as string },
    round: expectNonNegativeInteger(value.round, 'round', path),
    ...value.verifierProfile === undefined
      ? {}
      : { verifierProfile: value.verifierProfile as (typeof VERIFIER_PROFILES)[number] },
    theoremChecks: expectNonNegativeInteger(value.theoremChecks, 'theoremChecks', path),
    ...expectOptionalString(value.propositionPath, 'propositionPath', path) === undefined
      ? {}
      : { propositionPath: value.propositionPath as string },
    ...expectOptionalString(value.verifiedPath, 'verifiedPath', path) === undefined
      ? {}
      : { verifiedPath: value.verifiedPath as string },
    ...expectOptionalString(value.statement, 'statement', path) === undefined
      ? {}
      : { statement: value.statement as string },
    ...expectOptionalString(value.summary, 'summary', path) === undefined
      ? {}
      : { summary: value.summary as string },
    ...expectOptionalString(value.failureStage, 'failureStage', path) === undefined
      ? {}
      : { failureStage: value.failureStage as string },
    ...expectOptionalString(value.reason, 'reason', path) === undefined
      ? {}
      : { reason: value.reason as string },
    artifactPaths: value.artifactPaths as string[],
  }
}

/** Persistent storage owned by one locked AlphaSolve session runtime. */
export class RuntimeStore {
  private readonly mutex = new AsyncMutex()
  private readonly statePath: Promise<string>
  private readonly workerDir: Promise<string>
  private readonly completionDir: Promise<string>
  private state: SessionState | undefined

  constructor(public readonly workspace: string) {
    this.statePath = resolveWorkspacePath(workspace, '.alphasolve/state.json', { mustExist: false })
    this.workerDir = resolveWorkspacePath(workspace, '.alphasolve/workers', { mustExist: true })
    this.completionDir = resolveWorkspacePath(workspace, '.alphasolve/completions', { mustExist: true })
  }

  /** Initialize fresh state or load and reconcile an interrupted state. */
  async open(initial: SessionState): Promise<{ readonly state: SessionState; readonly resumed: boolean }> {
    return this.mutex.run(async () => {
      const statePath = await this.statePath
      let state: SessionState
      let resumed = false
      try {
        state = parseSessionState(await readJsonObject(statePath), statePath)
        resumed = true
      } catch (error) {
        const causeCode = ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code
        if (!(error instanceof DurableDataError) || causeCode !== 'ENOENT') throw error
        state = initial
      }
      const completions = await this.readCompletionsUnlocked()
      const maxSequence = completions.reduce((maximum, item) => Math.max(maximum, item.sequence), 0)
      if (state.nextCompletionSequence <= maxSequence || state.status === 'stopping') {
        state = {
          ...state,
          status: state.status === 'solved' ? 'solved' : 'interrupted',
          nextCompletionSequence: Math.max(state.nextCompletionSequence, maxSequence + 1),
          updatedAt: new Date().toISOString(),
        }
      }
      this.state = state
      await atomicWriteJson(statePath, state)
      return { state, resumed }
    })
  }

  /** Return the in-memory state only after {@link open}. */
  currentState(): SessionState {
    if (this.state === undefined) throw new Error('RuntimeStore.open() has not completed')
    return this.state
  }

  /** Atomically update the session state inside this runtime. */
  async updateState(update: (state: SessionState) => SessionState): Promise<SessionState> {
    return this.mutex.run(async () => {
      const next = update(this.currentState())
      this.state = { ...next, updatedAt: new Date().toISOString() }
      await atomicWriteJson(await this.statePath, this.state)
      return this.state
    })
  }

  /** Persist a complete worker snapshot. */
  async writeWorker(record: WorkerRecord): Promise<void> {
    const path = await resolveWorkspacePath(
      this.workspace,
      `.alphasolve/workers/${record.id}.json`,
      { mustExist: false },
    )
    await atomicWriteJson(path, record)
  }

  private async traceManifestPath(workerId: string): Promise<string> {
    requireWorkerId(workerId)
    return resolveWorkspacePath(
      this.workspace,
      `.alphasolve/traces/worker-${workerId}-manifest.json`,
      { mustExist: false },
    )
  }

  /** Append one already-persisted trace path to a durable per-worker manifest. */
  async appendWorkerTracePath(workerId: string, tracePath: string): Promise<void> {
    const normalized = requireTracePath(tracePath)
    await resolveWorkspacePath(this.workspace, normalized, { mustExist: true })
    await this.mutex.run(async () => {
      const manifestPath = await this.traceManifestPath(workerId)
      let manifest: WorkerTraceManifest = { version: STATE_VERSION, workerId, paths: [] }
      try {
        const info = await lstat(manifestPath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new DurableDataError('trace manifest is not an ordinary file', manifestPath)
        }
        manifest = parseTraceManifest(await readJsonObject(manifestPath), manifestPath, workerId)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (manifest.paths.includes(normalized)) return
      await atomicWriteJson(manifestPath, {
        ...manifest,
        paths: [...manifest.paths, normalized],
      })
    })
  }

  /** Read the durable trace manifest used by normal completion and crash recovery. */
  async listWorkerTracePaths(workerId: string): Promise<readonly string[]> {
    return this.mutex.run(async () => {
      const manifestPath = await this.traceManifestPath(workerId)
      try {
        const info = await lstat(manifestPath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new DurableDataError('trace manifest is not an ordinary file', manifestPath)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      return parseTraceManifest(await readJsonObject(manifestPath), manifestPath, workerId).paths
    })
  }

  /**
   * Convert crash-left worker snapshots into interrupted terminal records and
   * publish any terminal record whose completion write never happened.
   */
  async recoverInterruptedWorkers(): Promise<WorkerCompletion[]> {
    const directory = await this.workerDir
    const entries = await readdir(directory, { withFileTypes: true })
    const existing = new Set((await this.listCompletions()).map(item => item.workerId))
    const recovered: WorkerCompletion[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.json')) continue
      const relativePath = `.alphasolve/workers/${entry.name}`
      const workerPath = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true })
      if (!entry.isFile()) throw new DurableDataError('worker entry is not an ordinary file', workerPath)
      let worker = parseWorkerRecord(await readJsonObject(workerPath), workerPath)
      if (`${worker.id}.json` !== entry.name) {
        throw new DurableDataError('worker filename does not match worker id', workerPath)
      }
      if (worker.terminalStatus === undefined) {
        const completedAt = new Date().toISOString()
        worker = {
          ...worker,
          phase: 'complete',
          terminalStatus: 'interrupted',
          updatedAt: completedAt,
          completedAt,
          failureStage: worker.phase,
          reason: 'worker was active when the prior AlphaSolve runtime ended',
        }
        await atomicWriteJson(workerPath, worker)
      }
      if (existing.has(worker.id)) continue
      const status = worker.terminalStatus
      if (status === undefined) {
        throw new DurableDataError('worker recovery did not produce a terminal status', workerPath)
      }
      const tracePaths = await this.listWorkerTracePaths(worker.id)
      const completion = await this.recordCompletion({
        workerId: worker.id,
        status,
        startedAt: worker.createdAt,
        completedAt: worker.completedAt ?? worker.updatedAt,
        problemDigest: worker.problemDigest,
        ...worker.hintDigest === undefined ? {} : { hintDigest: worker.hintDigest },
        // A failed theorem-check can still leave a safely promoted proposition
        // after all mathematical verifiers passed.  The durable verifiedPath,
        // rather than the terminal status alone, is authoritative during
        // completion-write crash recovery.
        producedVerifiedProposition: worker.verifiedPath !== undefined
          || status === 'verified'
          || status === 'solved',
        solved: status === 'solved' || status === 'discarded_after_solution',
        summary: worker.summary
          ?? worker.reason
          ?? worker.statement
          ?? `worker ended with status ${status}`,
        ...worker.statement === undefined ? {} : { statement: worker.statement },
        ...worker.verifiedPath === undefined ? {} : { propositionPath: worker.verifiedPath },
        ...worker.failureStage === undefined ? {} : { failureStage: worker.failureStage },
        ...worker.reason === undefined ? {} : { reason: worker.reason },
        artifactPaths: [...new Set([...worker.artifactPaths, ...tracePaths])],
      })
      existing.add(worker.id)
      recovered.push(completion)
    }
    return recovered
  }

  /**
   * Strictly read every worker snapshot without applying recovery mutations.
   * Generation archival calls this before moving any durable ledger so a
   * malformed entry can never be silently hidden in a backup.
   */
  async validateWorkers(): Promise<WorkerRecord[]> {
    const directory = await this.workerDir
    const entries = await readdir(directory, { withFileTypes: true })
    const workers: WorkerRecord[] = []
    const ids = new Set<string>()
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.json')) continue
      const relativePath = `.alphasolve/workers/${entry.name}`
      const workerPath = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true })
      if (!entry.isFile()) throw new DurableDataError('worker entry is not an ordinary file', workerPath)
      const worker = parseWorkerRecord(await readJsonObject(workerPath), workerPath)
      if (`${worker.id}.json` !== entry.name) {
        throw new DurableDataError('worker filename does not match worker id', workerPath)
      }
      if (ids.has(worker.id)) throw new DurableDataError('duplicate worker id', workerPath)
      ids.add(worker.id)
      workers.push(worker)
    }
    return workers
  }

  /**
   * Reconcile the crash windows around a provisional winner claim.
   *
   * A solution is terminal only when both the unique durable winner
   * completion and the atomically-published complete solution are present.
   * A claim (including the legacy state=solved-before-completion window) with
   * no winner completion is provisional and is cleared so a fresh worker can
   * win. Conversely, a completion written just before a state update repairs
   * state to solved. A winner completion whose solution disappeared is
   * durable corruption and must fail closed rather than be delivered as
   * solved or silently rewritten.
   */
  async reconcileSolvedTerminal(solutionComplete: boolean): Promise<WorkerCompletion | undefined> {
    return this.mutex.run(async () => {
      const completions = await this.readCompletionsUnlocked()
      const state = this.currentState()
      const winners = completions.filter(completion => (
        completion.problemDigest === state.problemDigest
        && completion.status === 'solved'
        && completion.solved
      ))
      if (winners.length > 1) {
        throw new DurableDataError('multiple solved winner completions exist', await this.completionDir)
      }
      const winner = winners[0]
      if (winner !== undefined) {
        if (!solutionComplete) {
          throw new DurableDataError(
            `solved completion ${winner.workerId} has no complete solution.md`,
            await this.completionDir,
          )
        }
        if (state.status !== 'solved' || state.winnerWorkerId !== winner.workerId) {
          this.state = {
            ...state,
            status: 'solved',
            winnerWorkerId: winner.workerId,
            updatedAt: new Date().toISOString(),
          }
          await atomicWriteJson(await this.statePath, this.state)
        }
        return winner
      }

      if (state.winnerWorkerId !== undefined || state.status === 'solved') {
        const { winnerWorkerId: _provisional, ...withoutWinner } = state
        this.state = {
          ...withoutWinner,
          status: state.status === 'solved' ? 'interrupted' : state.status,
          updatedAt: new Date().toISOString(),
        }
        await atomicWriteJson(await this.statePath, this.state)
      }
      return undefined
    })
  }

  /** Assign a durable sequence and publish a worker completion before notifying waiters. */
  async recordCompletion(
    completion: Omit<WorkerCompletion, 'version' | 'sequence'>,
  ): Promise<WorkerCompletion> {
    return this.mutex.run(async () => {
      const state = this.currentState()
      const value: WorkerCompletion = {
        version: STATE_VERSION,
        sequence: state.nextCompletionSequence,
        ...completion,
      }
      const path = await resolveWorkspacePath(
        this.workspace,
        `.alphasolve/completions/${value.workerId}.json`,
        { mustExist: false },
      )
      const validated = parseCompletion(value as unknown as Record<string, unknown>, path)
      if (`${validated.workerId}.json` !== path.split(/[\\/]/).at(-1)) {
        throw new DurableDataError('completion workerId is not a safe filename', path)
      }
      try {
        await lstat(path)
        throw new DurableDataError(`completion already exists for worker ${value.workerId}`, path)
      } catch (error) {
        if (error instanceof DurableDataError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await atomicWriteJson(path, validated)
      this.state = {
        ...state,
        nextCompletionSequence: state.nextCompletionSequence + 1,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(await this.statePath, this.state)
      return validated
    })
  }

  private async readCompletionsUnlocked(): Promise<WorkerCompletion[]> {
    const dir = await this.completionDir
    const entries = await readdir(dir, { withFileTypes: true })
    const completions: WorkerCompletion[] = []
    const sequences = new Set<number>()
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue
      const relativePath = `.alphasolve/completions/${entry.name}`
      const path = await resolveWorkspacePath(this.workspace, relativePath, { mustExist: true })
      if (!entry.isFile()) throw new DurableDataError('completion entry is not an ordinary file', path)
      const completion = parseCompletion(await readJsonObject(path), path)
      if (`${completion.workerId}.json` !== entry.name) {
        throw new DurableDataError('completion filename does not match workerId', path)
      }
      if (sequences.has(completion.sequence)) throw new DurableDataError('duplicate completion sequence', path)
      sequences.add(completion.sequence)
      completions.push(completion)
    }
    return completions.sort((left, right) => left.sequence - right.sequence)
  }

  /** List all completion ledger entries in publication order. */
  async listCompletions(): Promise<WorkerCompletion[]> {
    return this.mutex.run(() => this.readCompletionsUnlocked())
  }

  /** Reserve every currently undelivered completion for one wait tool call. */
  async reserveUndelivered(callId: string): Promise<WorkerCompletion[]> {
    requireCallId(callId)
    return this.mutex.run(async () => {
      const entries = await this.readCompletionsUnlocked()
      const selected = entries.filter(entry => entry.deliveredByCallId === undefined
        && (entry.reservedByCallId === undefined || entry.reservedByCallId === callId))
      const reserved: WorkerCompletion[] = []
      for (const entry of selected) {
        const next: WorkerCompletion = { ...entry, reservedByCallId: callId }
        const path = await resolveWorkspacePath(
          this.workspace,
          `.alphasolve/completions/${entry.workerId}.json`,
          { mustExist: true },
        )
        await atomicWriteJson(path, next)
        reserved.push(next)
      }
      return reserved
    })
  }

  /** Commit delivery only after DSH records the authoritative tool result. */
  async commitDelivery(callId: string): Promise<void> {
    requireCallId(callId)
    await this.mutex.run(async () => {
      const entries = await this.readCompletionsUnlocked()
      for (const entry of entries.filter(item => item.reservedByCallId === callId && item.deliveredByCallId === undefined)) {
        const next: WorkerCompletion = {
          ...entry,
          deliveredByCallId: callId,
          deliveredAt: new Date().toISOString(),
        }
        const path = await resolveWorkspacePath(
          this.workspace,
          `.alphasolve/completions/${entry.workerId}.json`,
          { mustExist: true },
        )
        await atomicWriteJson(path, next)
      }
    })
  }

  /** Release a wait reservation whose result never reached the durable session. */
  async releaseReservation(callId: string): Promise<void> {
    requireCallId(callId)
    await this.mutex.run(async () => {
      const entries = await this.readCompletionsUnlocked()
      for (const entry of entries.filter(item => item.reservedByCallId === callId && item.deliveredByCallId === undefined)) {
        const { reservedByCallId: _ignored, ...next } = entry
        const path = await resolveWorkspacePath(
          this.workspace,
          `.alphasolve/completions/${entry.workerId}.json`,
          { mustExist: true },
        )
        await atomicWriteJson(path, next)
      }
    })
  }

  /** Reconcile crash-stuck reservations against tool results already present in the session log. */
  async recoverReservations(committedCallIds: ReadonlySet<string>): Promise<void> {
    await this.mutex.run(async () => {
      const entries = await this.readCompletionsUnlocked()
      for (const entry of entries) {
        if (entry.reservedByCallId === undefined || entry.deliveredByCallId !== undefined) continue
        const path = await resolveWorkspacePath(
          this.workspace,
          `.alphasolve/completions/${entry.workerId}.json`,
          { mustExist: true },
        )
        if (committedCallIds.has(entry.reservedByCallId)) {
          await atomicWriteJson(path, {
            ...entry,
            deliveredByCallId: entry.reservedByCallId,
            deliveredAt: new Date().toISOString(),
          })
        } else {
          const { reservedByCallId: _ignored, ...next } = entry
          await atomicWriteJson(path, next)
        }
      }
    })
  }
}
