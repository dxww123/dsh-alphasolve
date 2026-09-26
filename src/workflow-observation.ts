/** Atomic, session-owned observations of workers and their real role Sessions. */

import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { atomicWriteJson } from './atomic.js'
import type { RoleRunStopReason } from './role-runner.js'
import type { WorkerRecord } from './types.js'
import { resolveWorkspacePath } from './workspace.js'
import {
  alphaSolveWorkflowPath, parseAlphaSolveWorkflowView,
  type AlphaSolveRoleIdentity, type AlphaSolveRoleRunView, type AlphaSolveWorkflowView,
} from './workflow-view.js'

export type { AlphaSolveWorkflowView, AlphaSolveWorkerView, AlphaSolveRoleRunView } from './workflow-view.js'

/** Lifecycle sink supplied to the low-level role runner. */
export interface RoleRunObservation {
  readonly label: string
  started(child: Agent): Promise<void>
  progress(sessionId: string, steps: number): void
  finished(sessionId: string, status: RoleRunStopReason, steps: number, error?: string): Promise<void>
}

function upsert<T>(rows: readonly T[], value: T, matches: (row: T) => boolean): T[] {
  const index = rows.findIndex(matches)
  if (index < 0) return [...rows, value]
  return rows.map((row, position) => position === index ? value : row)
}

/** Serialize complete index snapshots so concurrent workers cannot overwrite each other. */
export class AlphaSolveWorkflowObserver {
  private pending = Promise.resolve()

  private constructor(
    private readonly file: string,
    private view: AlphaSolveWorkflowView,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Load an index, preserving completed history and interrupting crash-left active work. */
  static async open(workspace: string, sessionId: string, onError: (error: unknown) => void): Promise<AlphaSolveWorkflowObserver> {
    const file = await resolveWorkspacePath(workspace, alphaSolveWorkflowPath(sessionId), { mustExist: false })
    let view: AlphaSolveWorkflowView
    try {
      view = parseAlphaSolveWorkflowView(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      view = { version: 1, sessionId, workers: [], runs: [] }
    }
    if (view.sessionId !== sessionId) throw new Error('AlphaSolve workflow index belongs to another Session')
    const now = new Date().toISOString()
    const observer = new AlphaSolveWorkflowObserver(file, {
      ...view,
      workers: view.workers.map(worker => worker.terminalStatus === undefined
        ? { ...worker, phase: 'complete', terminalStatus: 'interrupted', updatedAt: now,
            reason: 'worker was active when the prior AlphaSolve runtime ended' }
        : worker),
      runs: view.runs.map(run => run.status === 'running' ? { ...run, status: 'interrupted', finishedAt: now } : run),
    }, onError)
    await atomicWriteJson(file, observer.view)
    return observer
  }

  /** Record a snapshot only after its worker ledger write succeeds. */
  async worker(record: WorkerRecord): Promise<void> {
    const { id, instruction, phase, round, verifierProfile, theoremChecks, terminalStatus, updatedAt, reason } = record
    const worker = {
      id, phase, round, theoremChecks, updatedAt,
      ...(instruction === undefined ? {} : { instruction }),
      ...(verifierProfile === undefined ? {} : { verifierProfile }),
      ...(terminalStatus === undefined ? {} : { terminalStatus }),
      ...(reason === undefined ? {} : { reason }),
    }
    this.view = { ...this.view, workers: upsert(this.view.workers, worker, row => row.id === id) }
    await this.persist()
  }

  /** Create a per-invocation recorder; helpers retain their actual parent Session. */
  role(identity: AlphaSolveRoleIdentity): RoleRunObservation {
    const label = ['AlphaSolve', identity.workerId, identity.role,
      identity.workflowRound === undefined ? undefined : `round ${identity.workflowRound}`,
      identity.theoremAttempt === undefined ? undefined : `attempt ${identity.theoremAttempt}`,
    ].filter(value => value !== undefined).join(' · ')
    return {
      label,
      started: async child => {
        const parentSession = child.session.header.parentSession
        if (parentSession === undefined) throw new Error('AlphaSolve role Session has no parent')
        await this.writeRun({ ...identity, sessionId: String(child.id), parentSessionId: String(parentSession),
          startedAt: new Date().toISOString(), status: 'running', steps: 0 })
      },
      progress: (sessionId, steps) => {
        const run = this.view.runs.find(row => row.sessionId === sessionId)
        if (run !== undefined && run.steps !== steps) {
          void this.writeRun({ ...run, steps })
        }
      },
      finished: async (sessionId, status, steps, error) => {
        const run = this.view.runs.find(row => row.sessionId === sessionId)
        if (run === undefined) return
        await this.writeRun({ ...run, status, steps, finishedAt: new Date().toISOString(),
          ...(error === undefined ? {} : { error }) })
      },
    }
  }

  private async writeRun(run: AlphaSolveRoleRunView): Promise<void> {
    this.view = { ...this.view, runs: upsert(this.view.runs, run, row => row.sessionId === run.sessionId) }
    await this.persist()
  }

  private persist(): Promise<void> {
    const snapshot = this.view
    const written = this.pending.then(() => atomicWriteJson(this.file, snapshot))
    this.pending = written.catch(error => {
      try {
        this.onError(error)
      } catch (_diagnosticError) {
        // A diagnostic listener cannot reject detached progress persistence.
      }
    })
    return this.pending
  }
}
