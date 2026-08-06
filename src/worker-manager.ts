/** Capacity-bounded asynchronous worker scheduling and durable wait delivery. */

import { randomUUID } from 'node:crypto'
import { readWorkspaceInput, workspaceFileExists } from './workspace.js'
import {
  STATE_VERSION,
  type WorkerCompletion,
  type WorkerRecord,
  type WorkerStartResult,
  type WorkerWaitResult,
} from './types.js'
import type { RuntimeStore } from './store.js'

/** Thrown at workflow phase boundaries when the immutable problem changed. */
export class ProblemChangedError extends Error {
  constructor() {
    super('problem.md changed after AlphaSolve activation')
    this.name = 'ProblemChangedError'
  }
}

/** Terminal information returned by the fixed workflow implementation. */
export interface WorkflowResult {
  readonly status: WorkerCompletion['status']
  readonly producedVerifiedProposition: boolean
  readonly solved: boolean
  readonly statement?: string
  readonly propositionPath?: string
  readonly failureStage?: string
  readonly reason?: string
  readonly artifactPaths: readonly string[]
  /** In-process rollback for the post-publication digest/ledger window. */
  readonly rollbackPublishedSolution?: () => Promise<void>
}

/** Capabilities supplied to one fixed workflow execution. */
export interface WorkerExecutionContext {
  readonly id: string
  readonly instruction: string
  readonly signal: AbortSignal
  readonly problemDigest: string
  readonly hintDigest?: string
  progress(update: Partial<WorkerRecord>): Promise<void>
  assertInputsCurrent(): Promise<void>
  claimSolvedWinner(): Promise<boolean>
  releaseSolvedWinner?(): Promise<void>
}

/** Injectable fixed-workflow implementation. */
export type WorkerExecutor = (context: WorkerExecutionContext) => Promise<WorkflowResult>

function summarizeCompletion(result: WorkflowResult): string {
  if (result.solved) {
    return result.statement === undefined
      ? 'worker produced the accepted solution'
      : `worker produced the accepted solution: ${result.statement}`
  }
  // A theorem-checker infrastructure failure can happen only after all five
  // verifiers passed.  The candidate is still safely promoted, but the worker
  // completion must remain visibly failed rather than looking like an
  // ordinary verified-but-not-solved result.
  if (result.status === 'failed') {
    const prefix = result.producedVerifiedProposition
      ? 'worker produced a verified proposition, but the workflow failed'
      : 'worker workflow failed'
    const stage = result.failureStage === undefined ? '' : ` at ${result.failureStage}`
    return result.reason === undefined
      ? `${prefix}${stage}`
      : `${prefix}${stage}: ${result.reason}`
  }
  if (result.producedVerifiedProposition) {
    return result.statement === undefined
      ? 'worker produced a verified proposition'
      : `worker produced a verified proposition: ${result.statement}`
  }
  if (result.reason !== undefined) return result.reason
  return `worker ended with status ${result.status}`
}

interface ActiveWorker {
  readonly id: string
  readonly controller: AbortController
  readonly settled: Promise<void>
}

export interface ActiveWorkerProgress {
  readonly workerId: string
  readonly phase: WorkerRecord['phase']
  readonly round: number
  readonly verifierProfile?: WorkerRecord['verifierProfile']
  readonly theoremChecks: number
}

/** A notifier whose monotonically increasing generation closes check/wait races. */
class CompletionNotifier {
  private generation = 0
  private readonly waiters = new Set<() => void>()

  current(): number {
    return this.generation
  }

  notify(): void {
    this.generation += 1
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
  }

  async waitAfter(generation: number, signal: AbortSignal): Promise<void> {
    if (this.generation !== generation) return
    if (signal.aborted) throw signal.reason ?? new DOMException('wait cancelled', 'AbortError')
    const deferred = Promise.withResolvers<void>()
    const settle = (): void => deferred.resolve()
    const abort = (): void => deferred.reject(signal.reason ?? new DOMException('wait cancelled', 'AbortError'))
    this.waiters.add(settle)
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (this.generation !== generation) settle()
      await deferred.promise
    } finally {
      this.waiters.delete(settle)
      signal.removeEventListener('abort', abort)
    }
  }
}

/** Wait response before the tool-result commit phase. */
export type ReservedWaitResult = WorkerWaitResult

async function waitWithAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException('wait cancelled', 'AbortError')
  const aborted = Promise.withResolvers<never>()
  const abort = (): void => aborted.reject(signal.reason ?? new DOMException('wait cancelled', 'AbortError'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Own all detached worker promises for exactly one active AlphaSolve session. */
export class WorkerManager {
  private readonly active = new Map<string, ActiveWorker>()
  private readonly activeRecords = new Map<string, WorkerRecord>()
  private readonly notifier = new CompletionNotifier()
  private readonly pendingAdmissions = new Set<Promise<void>>()
  private stopping = false
  private solutionFound = false
  private finalizingWinnerId: string | undefined
  private solutionDrainGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
  private stopStatus: 'cancelled' | 'interrupted' = 'interrupted'
  private problemNoticeSent = false

  constructor(
    private readonly store: RuntimeStore,
    private readonly executeWorkflow: WorkerExecutor,
    private readonly onHintChanged: (message: string) => void,
    private readonly onBackgroundError: (error: unknown) => void = () => {},
    private readonly assertRuntimeOwned: () => Promise<void> = async () => undefined,
    private readonly onSolution: () => Promise<void> = async () => undefined,
  ) {
    this.solutionFound = store.currentState().status === 'solved'
  }

  /** Current active worker IDs in start order. */
  activeIds(): string[] {
    return [...this.active.keys()]
  }

  /** Synchronous model/UI summary updated at every durable phase boundary. */
  activeProgress(): readonly ActiveWorkerProgress[] {
    return [...this.activeRecords.values()].map(record => ({
      workerId: record.id,
      phase: record.phase,
      round: record.round,
      ...(record.verifierProfile === undefined ? {} : { verifierProfile: record.verifierProfile }),
      theoremChecks: record.theoremChecks,
    }))
  }

  /** Current hard capacity from durable session state. */
  capacity(): number {
    return this.store.currentState().capacity
  }

  /** Whether active work temporarily exceeds a newly lowered capacity. */
  overCapacity(): boolean {
    return this.active.size > this.capacity()
  }

  /** Verify problem/hint digests and notify the orchestrator once per hint version. */
  async assertInputsCurrent(): Promise<void> {
    await this.assertRuntimeOwned()
    const state = this.store.currentState()
    const problem = await readWorkspaceInput(this.store.workspace, 'problem.md', { nonEmpty: true })
    if (problem.digest !== state.problemDigest) {
      if (!this.problemNoticeSent) {
        this.problemNoticeSent = true
        this.onHintChanged([
          'AlphaSolve notice: problem.md changed after activation.',
          'New workers are blocked and old-digest results will never be promoted or used to write solution.md.',
          'Ask the user to choose explicitly: (1) restore the activation-time problem; (2) begin a new problem generation by stopping this runtime, then making a new explicit AlphaSolve solve request; or (3) accept old-generation results only as non-promoted research context.',
        ].join(' '))
      }
      throw new ProblemChangedError()
    }

    const hintExists = await workspaceFileExists(this.store.workspace, 'hint.md')
    const hintDigest = hintExists
      ? (await readWorkspaceInput(this.store.workspace, 'hint.md', { nonEmpty: false })).digest
      : undefined
    const noticeKey = hintDigest ?? '<missing>'
    let notice: string | undefined
    await this.store.updateState(current => {
      if (current.hintDigest === hintDigest) return current
      if (current.notifiedHintDigest !== noticeKey) {
        notice = hintDigest === undefined
          ? 'AlphaSolve notice: hint.md was removed after activation; future workers will use no general hint.'
          : 'AlphaSolve notice: hint.md changed after activation; future workers will use the new contents.'
      }
      if (hintDigest === undefined) {
        const { hintDigest: _oldHint, ...withoutHint } = current
        return { ...withoutHint, notifiedHintDigest: noticeKey }
      }
      return { ...current, hintDigest, notifiedHintDigest: noticeKey }
    })
    if (notice !== undefined) this.onHintChanged(notice)
  }

  /** Atomically claim the one solution winner. */
  private async claimSolvedWinner(workerId: string): Promise<boolean> {
    let claimed = false
    await this.store.updateState(state => {
      if (state.winnerWorkerId !== undefined) return state
      claimed = true
      return { ...state, winnerWorkerId: workerId }
    })
    if (claimed) {
      // The claim is provisional until solution publication and the durable
      // completion commit finish, but it must immediately freeze admissions
      // and stop competing work. Otherwise a blocked publisher leaves a wide
      // window in which unrelated workers can still be dispatched.
      this.finalizingWinnerId = workerId
      this.solutionFound = true
      this.solutionDrainGate = Promise.withResolvers<void>()
      for (const worker of this.active.values()) {
        if (worker.id !== workerId) worker.controller.abort(new Error('another worker is finalizing the solution'))
      }
      this.notifier.notify()
    }
    return claimed
  }

  /** Release only this worker's provisional winner claim after a failed publish. */
  private async releaseSolvedWinner(workerId: string): Promise<void> {
    let released = false
    await this.store.updateState(state => {
      if (state.winnerWorkerId !== workerId || state.status === 'solved') return state
      released = true
      const { winnerWorkerId: _winner, ...withoutWinner } = state
      return withoutWinner
    })
    const current = this.store.currentState()
    if (this.finalizingWinnerId === workerId
      && current.status !== 'solved'
      && (released || current.winnerWorkerId === undefined)) {
      this.finalizingWinnerId = undefined
      this.solutionFound = false
      this.solutionDrainGate?.resolve()
      this.solutionDrainGate = undefined
      this.notifier.notify()
    }
  }

  private async finishSolvedDrain(workerId: string): Promise<void> {
    try {
      await this.onSolution()
    } catch (error) {
      this.onBackgroundError(error)
    } finally {
      if (this.finalizingWinnerId === workerId) this.finalizingWinnerId = undefined
      this.solutionDrainGate?.resolve()
      this.solutionDrainGate = undefined
      this.notifier.notify()
    }
  }

  /** Start a worker immediately or return a non-queuing admission failure. */
  async start(instruction: string): Promise<WorkerStartResult> {
    const base = (): Pick<WorkerStartResult, 'active' | 'capacity' | 'overCapacity'> => ({
      active: this.active.size,
      capacity: this.capacity(),
      overCapacity: this.active.size > this.capacity(),
    })
    if (this.stopping || this.solutionFound) return { accepted: false, reason: 'runtime_stopping', ...base() }
    if (typeof instruction !== 'string' || instruction.trim() === '' || instruction.length > 4_000) {
      return { accepted: false, reason: 'invalid_instruction', ...base() }
    }
    if (this.active.size + this.pendingAdmissions.size >= this.capacity()) {
      return { accepted: false, reason: 'capacity_full', ...base() }
    }

    const admission = Promise.withResolvers<void>()
    this.pendingAdmissions.add(admission.promise)
    try {
      try {
        await this.assertInputsCurrent()
      } catch (error) {
        if (error instanceof ProblemChangedError) return { accepted: false, reason: 'problem_changed', ...base() }
        return { accepted: false, reason: 'internal_error', ...base() }
      }
      if (this.stopping || this.solutionFound) return { accepted: false, reason: 'runtime_stopping', ...base() }
      const otherAdmissions = Math.max(0, this.pendingAdmissions.size - 1)
      if (this.active.size + otherAdmissions >= this.capacity()) {
        return { accepted: false, reason: 'capacity_full', ...base() }
      }

      const id = randomUUID().slice(0, 8)
      const state = this.store.currentState()
      const now = new Date().toISOString()
      const record: WorkerRecord = {
        version: STATE_VERSION,
        id,
        instruction: instruction.trim(),
        phase: 'created',
        createdAt: now,
        updatedAt: now,
        problemDigest: state.problemDigest,
        ...state.hintDigest === undefined ? {} : { hintDigest: state.hintDigest },
        round: 0,
        theoremChecks: 0,
        artifactPaths: [`.alphasolve/workers/${id}.json`],
      }
      try {
        await this.store.writeWorker(record)
      } catch {
        return { accepted: false, reason: 'internal_error', ...base() }
      }
      if (this.stopping || this.solutionFound) return { accepted: false, reason: 'runtime_stopping', ...base() }

      const controller = new AbortController()
      this.activeRecords.set(id, record)
      const settled = this.driveWorker(record, controller)
        .catch((error: unknown) => {
          try {
            this.onBackgroundError(error)
          } catch {
            // Diagnostics must not resurrect a detached rejection.
          }
        })
        .finally(() => {
          this.active.delete(id)
          this.activeRecords.delete(id)
          this.notifier.notify()
        })
      this.active.set(id, { id, controller, settled })
      return {
        accepted: true,
        workerId: id,
        active: this.active.size,
        capacity: this.capacity(),
        overCapacity: this.active.size > this.capacity(),
      }
    } finally {
      this.pendingAdmissions.delete(admission.promise)
      admission.resolve()
    }
  }

  private async driveWorker(initial: WorkerRecord, controller: AbortController): Promise<void> {
    let record = initial
    const progress = async (update: Partial<WorkerRecord>): Promise<void> => {
      record = { ...record, ...update, id: record.id, version: STATE_VERSION, updatedAt: new Date().toISOString() }
      await this.store.writeWorker(record)
      this.activeRecords.set(record.id, record)
    }

    let result: WorkflowResult
    let returnedResult: WorkflowResult | undefined
    try {
      result = await this.executeWorkflow({
        id: record.id,
        instruction: record.instruction ?? '',
        signal: controller.signal,
        problemDigest: record.problemDigest,
        ...record.hintDigest === undefined ? {} : { hintDigest: record.hintDigest },
        progress,
        assertInputsCurrent: () => this.assertInputsCurrent(),
        claimSolvedWinner: () => this.claimSolvedWinner(record.id),
        releaseSolvedWinner: () => this.releaseSolvedWinner(record.id),
      })
      returnedResult = result
      await this.assertInputsCurrent()
      if (result.status === 'solved') {
        this.solutionFound = true
        this.finalizingWinnerId ??= record.id
        this.solutionDrainGate ??= Promise.withResolvers<void>()
        const otherWorkers = [...this.active.values()].filter(worker => worker.id !== record.id)
        for (const worker of otherWorkers) {
          worker.controller.abort(new Error('another worker solved the problem'))
        }
        await Promise.allSettled(otherWorkers.map(worker => worker.settled))
      }
    } catch (error) {
      // The fixed workflow normally releases a provisional solution claim on
      // its own failures. A failure in this manager's post-workflow digest or
      // lock check happens after the workflow has returned, so close that
      // otherwise-stuck winner window here as well.
      try {
        await returnedResult?.rollbackPublishedSolution?.()
        await this.releaseSolvedWinner(record.id)
      } catch (releaseError) {
        this.onBackgroundError(releaseError)
      }
      if (error instanceof ProblemChangedError) {
        result = {
          status: 'stale_problem',
          producedVerifiedProposition: false,
          solved: false,
          failureStage: record.phase,
          reason: error.message,
          artifactPaths: record.artifactPaths,
        }
      } else if (controller.signal.aborted) {
        result = {
          status: this.stopping ? this.stopStatus : 'cancelled',
          producedVerifiedProposition: false,
          solved: false,
          failureStage: record.phase,
          reason: 'worker was cancelled',
          artifactPaths: record.artifactPaths,
        }
      } else {
        result = {
          status: 'failed',
          producedVerifiedProposition: false,
          solved: false,
          failureStage: record.phase,
          reason: error instanceof Error ? error.message : String(error),
          artifactPaths: record.artifactPaths,
        }
      }
    }

    const completedAt = new Date().toISOString()
    const summary = summarizeCompletion(result)
    const tracePaths = await this.store.listWorkerTracePaths(record.id)
    const completionArtifactPaths = [...new Set([...result.artifactPaths, ...tracePaths])]
    let completionPublished = false
    try {
      await progress({
        phase: 'complete',
        terminalStatus: result.status,
        completedAt,
        summary,
        ...result.statement === undefined ? {} : { statement: result.statement },
        ...result.propositionPath === undefined ? {} : { verifiedPath: result.propositionPath },
        ...result.failureStage === undefined ? {} : { failureStage: result.failureStage },
        ...result.reason === undefined ? {} : { reason: result.reason },
        artifactPaths: completionArtifactPaths,
      })
      await this.store.recordCompletion({
        workerId: record.id,
        status: result.status,
        startedAt: record.createdAt,
        completedAt,
        problemDigest: record.problemDigest,
        ...record.hintDigest === undefined ? {} : { hintDigest: record.hintDigest },
        producedVerifiedProposition: result.producedVerifiedProposition,
        solved: result.solved,
        summary,
        artifactPaths: completionArtifactPaths,
        ...result.statement === undefined ? {} : { statement: result.statement },
        ...result.propositionPath === undefined ? {} : { propositionPath: result.propositionPath },
        ...result.failureStage === undefined ? {} : { failureStage: result.failureStage },
        ...result.reason === undefined ? {} : { reason: result.reason },
      })
      completionPublished = true

      // state=solved is deliberately the commit *after* the winner completion.
      // RuntimeStore recovery repairs the narrow completion-before-state crash
      // window, while no crash can expose solved state without a ledger entry.
      if (result.status === 'solved' && result.solved) {
        await this.store.updateState(state => ({
          ...state,
          status: 'solved',
          winnerWorkerId: record.id,
        }))
        await this.finishSolvedDrain(record.id)
      }
    } catch (error) {
      if (!completionPublished) {
        try {
          completionPublished = (await this.store.listCompletions())
            .some(completion => completion.workerId === record.id)
        } catch (inspectionError) {
          // Unknown ledger state is not permission to remove a possibly
          // committed solution or admit a second winner.
          completionPublished = true
          this.onBackgroundError(inspectionError)
        }
      }
      // Before the durable completion exists this is still a provisional
      // claim and can safely be released. After publication, recovery must
      // finish the state commit instead of allowing a second winner.
      if (!completionPublished) {
        try {
          await result.rollbackPublishedSolution?.()
          await this.releaseSolvedWinner(record.id)
        } catch (releaseError) {
          this.onBackgroundError(releaseError)
        }
      } else if (result.status === 'solved' && result.solved) {
        await this.finishSolvedDrain(record.id)
      }
      throw error
    }
  }

  /** Wait for and reserve all completions published since the last committed wait. */
  async wait(callId: string, signal: AbortSignal): Promise<ReservedWaitResult> {
    if (signal.aborted) throw signal.reason ?? new DOMException('wait cancelled', 'AbortError')
    for (;;) {
      const drainGate = this.solutionDrainGate
      if (drainGate !== undefined) await waitWithAbort(drainGate.promise, signal)
      const generation = this.notifier.current()
      const completed = await this.store.reserveUndelivered(callId)
      if (completed.length > 0) {
        if (signal.aborted) {
          await this.store.releaseReservation(callId)
          throw signal.reason ?? new DOMException('wait cancelled', 'AbortError')
        }
        return {
          status: 'completed',
          completed,
          activeWorkerIds: this.activeIds(),
          active: this.active.size,
          capacity: this.capacity(),
        }
      }
      if (this.active.size === 0) {
        return {
          status: 'no_active_workers',
          completed: [],
          activeWorkerIds: [],
          active: 0,
          capacity: this.capacity(),
        }
      }
      await this.notifier.waitAfter(generation, signal)
    }
  }

  /** Change the single hard capacity without cancelling over-capacity workers. */
  async configure(capacity: number): Promise<{
    readonly previousCapacity: number
    readonly capacity: number
    readonly active: number
    readonly overCapacity: boolean
  }> {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive safe integer')
    const previousCapacity = this.capacity()
    await this.store.updateState(state => ({ ...state, capacity }))
    return {
      previousCapacity,
      capacity,
      active: this.active.size,
      overCapacity: this.active.size > capacity,
    }
  }

  /** Abort all workers and wait for every detached promise to settle. */
  async stop(status: 'cancelled' | 'interrupted' = 'interrupted'): Promise<void> {
    if (this.stopping) {
      await Promise.allSettled([...this.pendingAdmissions])
      await Promise.allSettled([...this.active.values()].map(worker => worker.settled))
      return
    }
    this.stopping = true
    this.stopStatus = status
    this.notifier.notify()
    for (const worker of this.active.values()) worker.controller.abort(new Error('AlphaSolve runtime is stopping'))
    await Promise.allSettled([...this.pendingAdmissions])
    for (const worker of this.active.values()) worker.controller.abort(new Error('AlphaSolve runtime is stopping'))
    await Promise.allSettled([...this.active.values()].map(worker => worker.settled))
  }
}
