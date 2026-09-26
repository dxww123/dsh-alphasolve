import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeStore } from '../src/store.js'
import { STATE_VERSION, type SessionState } from '../src/types.js'
import {
  WorkerManager,
  type WorkerExecutionContext,
  type WorkerExecutor,
  type WorkflowResult,
} from '../src/worker-manager.js'
import { initializeWorkspace, readWorkspaceInput } from '../src/workspace.js'

const roots: string[] = []

interface WorkflowGate {
  readonly promise: Promise<WorkflowResult>
  resolve(value: WorkflowResult): void
  reject(reason?: unknown): void
}

function verifiedResult(id: string): WorkflowResult {
  return {
    status: 'verified',
    producedVerifiedProposition: true,
    solved: false,
    statement: `statement ${id}`,
    propositionPath: `verified_propositions/${id}.md`,
    artifactPaths: [`.alphasolve/workers/${id}.json`],
  }
}

function controlledWorkflow(): {
  readonly execute: WorkerExecutor
  readonly contexts: WorkerExecutionContext[]
  resolve(id: string, result?: WorkflowResult): void
} {
  const gates = new Map<string, WorkflowGate>()
  const contexts: WorkerExecutionContext[] = []
  return {
    contexts,
    execute: async (context) => {
      contexts.push(context)
      const gate = Promise.withResolvers<WorkflowResult>()
      gates.set(context.id, gate)
      return gate.promise
    },
    resolve(id, result = verifiedResult(id)) {
      const gate = gates.get(id)
      if (gate === undefined) throw new Error(`unknown worker ${id}`)
      gate.resolve(result)
    },
  }
}

async function fixture(
  capacity: number,
  executeWorkflow: WorkerExecutor,
  hint = 'initial hint',
): Promise<{ root: string; store: RuntimeStore; manager: WorkerManager; notices: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-worker-manager-'))
  roots.push(root)
  await initializeWorkspace(root)
  await writeFile(path.join(root, 'problem.md'), 'original problem')
  await writeFile(path.join(root, 'hint.md'), hint)
  const problem = await readWorkspaceInput(root, 'problem.md', { nonEmpty: true })
  const hintInput = await readWorkspaceInput(root, 'hint.md', { nonEmpty: false })
  const state: SessionState = {
    version: STATE_VERSION,
    sessionId: 'session-a',
    workspace: root,
    activatedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    problemDigest: problem.digest,
    hintDigest: hintInput.digest,
    capacity,
    detailedTrace: true,
    modelOverrides: {},
    nextCompletionSequence: 1,
  }
  const store = new RuntimeStore(root)
  await store.open(state)
  const notices: string[] = []
  return {
    root,
    store,
    notices,
    manager: new WorkerManager(store, executeWorkflow, message => notices.push(message)),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('worker admission and capacity', () => {
  it('does not oversubscribe capacity under concurrent starts', async () => {
    const workflow = controlledWorkflow()
    const { manager } = await fixture(1, workflow.execute)
    const results = await Promise.all([manager.start('route a'), manager.start('route b')])

    expect(results.filter(result => result.accepted)).toHaveLength(1)
    expect(results.filter(result => result.reason === 'capacity_full')).toHaveLength(1)
    expect(manager.activeIds()).toHaveLength(1)
    const id = manager.activeIds()[0]
    if (id === undefined) throw new Error('missing admitted worker')
    workflow.resolve(id)
    await manager.stop()
  })

  it('exposes the current durable phase, verifier profile, round, and theorem progress', async () => {
    const workflow = controlledWorkflow()
    const { manager } = await fixture(1, workflow.execute)
    const started = await manager.start('observe this route')
    if (started.workerId === undefined) throw new Error('worker was not admitted')
    const context = workflow.contexts[0]
    if (context === undefined) throw new Error('workflow context was not created')
    await context.progress({ phase: 'verifier', round: 3, verifierProfile: 'stepwise', theoremChecks: 0 })

    expect(manager.activeProgress()).toEqual([{
      workerId: started.workerId,
      phase: 'verifier',
      round: 3,
      verifierProfile: 'stepwise',
      theoremChecks: 0,
    }])
    workflow.resolve(started.workerId)
    await manager.stop()
    expect(manager.activeProgress()).toEqual([])
  })

  it('reports overview failures after ledger writes without rejecting or orphaning admitted work', async () => {
    const workflow = controlledWorkflow()
    const { root, store } = await fixture(1, workflow.execute)
    const errors: unknown[] = []
    const observedPhases: string[] = []
    const manager = new WorkerManager(store, workflow.execute, () => undefined,
      error => errors.push(error), undefined, undefined, async record => {
        const saved = JSON.parse(await readFile(path.join(root, '.alphasolve', 'workers', `${record.id}.json`), 'utf8'))
        expect(saved).toMatchObject({ id: record.id, phase: record.phase })
        observedPhases.push(record.phase)
        throw new Error('overview storage unavailable')
      })
    const started = await manager.start('observe this route')
    expect(started.accepted).toBe(true)
    if (started.workerId === undefined) throw new Error('missing admitted worker')
    const context = workflow.contexts[0]
    if (context === undefined) throw new Error('missing workflow context')
    await context.progress({ phase: 'verifier', round: 1, verifierProfile: 'citation' })
    workflow.resolve(started.workerId)
    const waited = await manager.wait('overview-failure-wait', new AbortController().signal)
    expect(waited.completed).toMatchObject([{ workerId: started.workerId, status: 'verified' }])
    await manager.stop()
    expect(observedPhases).toEqual(['created', 'verifier', 'complete'])
    expect(errors).toHaveLength(3)
  })

  it('lowers capacity without cancelling active workers and blocks new admission', async () => {
    const workflow = controlledWorkflow()
    const { manager } = await fixture(2, workflow.execute)
    expect((await manager.start('route a')).accepted).toBe(true)
    expect((await manager.start('route b')).accepted).toBe(true)

    await expect(manager.configure(1)).resolves.toMatchObject({
      previousCapacity: 2,
      capacity: 1,
      active: 2,
      overCapacity: true,
    })
    await expect(manager.start('route c')).resolves.toMatchObject({ accepted: false, reason: 'capacity_full' })
    expect(manager.activeIds()).toHaveLength(2)
    for (const id of manager.activeIds()) workflow.resolve(id)
    await manager.stop()
  })

  it('makes a pending admission observe stop before launching a workflow', async () => {
    const workflow = controlledWorkflow()
    const { manager } = await fixture(1, workflow.execute)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    manager.assertInputsCurrent = async () => {
      entered.resolve()
      await release.promise
    }

    const starting = manager.start('route a')
    await entered.promise
    const stopping = manager.stop()
    release.resolve()
    await expect(starting).resolves.toMatchObject({ accepted: false, reason: 'runtime_stopping' })
    await stopping
    expect(workflow.contexts).toHaveLength(0)
  })

  it('freezes admissions as soon as a winner claim enters a blocked publisher', async () => {
    const publishing = Promise.withResolvers<void>()
    const finishPublishing = Promise.withResolvers<void>()
    const execute: WorkerExecutor = async context => {
      expect(await context.claimSolvedWinner()).toBe(true)
      publishing.resolve()
      await finishPublishing.promise
      return {
        status: 'solved',
        producedVerifiedProposition: true,
        solved: true,
        statement: 'The final statement.',
        propositionPath: 'verified_propositions/final.md',
        artifactPaths: [],
      }
    }
    const { manager } = await fixture(2, execute)
    const winner = await manager.start('finalize this route')
    await publishing.promise

    await expect(manager.start('late competing route')).resolves.toMatchObject({
      accepted: false,
      reason: 'runtime_stopping',
    })
    expect(manager.activeIds()).toEqual([winner.workerId])

    finishPublishing.resolve()
    await expect(manager.wait('winner-wait', new AbortController().signal)).resolves.toMatchObject({
      completed: [expect.objectContaining({ workerId: winner.workerId, status: 'solved' })],
    })
    await manager.stop()
  })

  it('unfreezes admissions when a provisional winner fails before completion publication', async () => {
    let attempt = 0
    const execute: WorkerExecutor = async context => {
      attempt += 1
      if (attempt === 1) {
        expect(await context.claimSolvedWinner()).toBe(true)
        throw new Error('publisher failed before committing')
      }
      return verifiedResult(context.id)
    }
    const { manager, store } = await fixture(1, execute)
    const first = await manager.start('failing finalizer')
    await expect(manager.wait('failed-finalizer', new AbortController().signal)).resolves.toMatchObject({
      completed: [expect.objectContaining({ workerId: first.workerId, status: 'failed' })],
    })
    expect(store.currentState().winnerWorkerId).toBeUndefined()

    const retry = await manager.start('replacement route')
    expect(retry.accepted).toBe(true)
    await manager.stop()
  })
})

describe('worker completion waiting', () => {
  it('preserves a promoted proposition while reporting theorem infrastructure failure', async () => {
    const execute: WorkerExecutor = async context => ({
      status: 'failed',
      producedVerifiedProposition: true,
      solved: false,
      statement: 'A verifier-approved lemma.',
      propositionPath: 'verified_propositions/approved-lemma.md',
      failureStage: 'theorem_checker:2',
      reason: 'theorem_checker:2 infrastructure failure: provider unavailable',
      artifactPaths: [`.alphasolve/workers/${context.id}.json`],
    })
    const { manager } = await fixture(1, execute)
    const started = await manager.start('check completion failure typing')
    const waited = await manager.wait('failed-theorem-check', new AbortController().signal)

    expect(waited.completed).toEqual([
      expect.objectContaining({
        workerId: started.workerId,
        status: 'failed',
        producedVerifiedProposition: true,
        solved: false,
        propositionPath: 'verified_propositions/approved-lemma.md',
        failureStage: 'theorem_checker:2',
        reason: expect.stringContaining('provider unavailable'),
        summary: expect.stringMatching(/verified proposition.*workflow failed.*theorem_checker:2/i),
      }),
    ])
    await manager.stop()
  })

  it('waits for the first completion without waiting for every active worker', async () => {
    const workflow = controlledWorkflow()
    const { manager, store } = await fixture(2, workflow.execute)
    const first = await manager.start('route a')
    const second = await manager.start('route b')
    if (first.workerId === undefined || second.workerId === undefined) throw new Error('workers were not admitted')

    const waiting = manager.wait('wait-a', new AbortController().signal)
    workflow.resolve(first.workerId)
    const result = await waiting
    expect(result.status).toBe('completed')
    expect(result.completed.map(item => item.workerId)).toEqual([first.workerId])
    expect(result.activeWorkerIds).toEqual([second.workerId])
    await store.commitDelivery('wait-a')

    workflow.resolve(second.workerId)
    const next = await manager.wait('wait-b', new AbortController().signal)
    expect(next.completed.map(item => item.workerId)).toEqual([second.workerId])
    await store.commitDelivery('wait-b')
    await manager.stop()
  })

  it('merges durable role and helper trace paths into the normal completion', async () => {
    const workflow = controlledWorkflow()
    const { root, manager, store } = await fixture(1, workflow.execute)
    const started = await manager.start('trace this route')
    if (started.workerId === undefined) throw new Error('worker was not admitted')
    const roleTrace = `.alphasolve/traces/workflow-role-${started.workerId}.json`
    const helperTrace = `.alphasolve/traces/subagent-${started.workerId}.json`
    await writeFile(path.join(root, roleTrace), '{}\n')
    await writeFile(path.join(root, helperTrace), '{}\n')
    await store.appendWorkerTracePath(started.workerId, roleTrace)
    await store.appendWorkerTracePath(started.workerId, helperTrace)

    workflow.resolve(started.workerId)
    const result = await manager.wait('trace-wait', new AbortController().signal)
    expect(result.completed[0]?.artifactPaths).toEqual(expect.arrayContaining([roleTrace, helperTrace]))
    expect(new Set(result.completed[0]?.artifactPaths).size).toBe(result.completed[0]?.artifactPaths.length)
    await manager.stop()
  })

  it('cancels only the wait call, never the worker', async () => {
    const workflow = controlledWorkflow()
    const { manager } = await fixture(1, workflow.execute)
    const started = await manager.start('route a')
    if (started.workerId === undefined) throw new Error('worker was not admitted')

    const controller = new AbortController()
    const waiting = manager.wait('cancelled-wait', controller.signal)
    controller.abort(new Error('caller cancelled wait'))
    await expect(waiting).rejects.toThrow(/caller cancelled wait/)
    expect(manager.activeIds()).toEqual([started.workerId])

    workflow.resolve(started.workerId)
    const completion = await manager.wait('later-wait', new AbortController().signal)
    expect(completion.completed.map(item => item.workerId)).toEqual([started.workerId])
    await manager.stop()
  })

  it('rejects a pre-cancelled wait without reserving backlog', async () => {
    const workflow = controlledWorkflow()
    const { manager, store } = await fixture(1, workflow.execute)
    const started = await manager.start('route a')
    if (started.workerId === undefined) throw new Error('worker was not admitted')
    workflow.resolve(started.workerId)
    await manager.stop()

    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(manager.wait('cancelled', controller.signal)).rejects.toThrow(/already cancelled/)
    expect((await store.reserveUndelivered('uncancelled')).map(item => item.workerId)).toEqual([started.workerId])
  })
})

describe('input digest changes', () => {
  it('rejects a new worker after problem.md changes', async () => {
    const workflow = controlledWorkflow()
    const { root, manager, notices } = await fixture(1, workflow.execute)
    await writeFile(path.join(root, 'problem.md'), 'changed problem')

    await expect(manager.start('route a')).resolves.toMatchObject({ accepted: false, reason: 'problem_changed' })
    await expect(manager.start('route b')).resolves.toMatchObject({ accepted: false, reason: 'problem_changed' })
    expect(workflow.contexts).toHaveLength(0)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('restore the activation-time problem')
    expect(notices[0]).toContain('new problem generation')
    expect(notices[0]).toContain('non-promoted research context')
  })

  it('marks an active result stale when problem.md changes before completion', async () => {
    const workflow = controlledWorkflow()
    const { root, manager } = await fixture(1, workflow.execute)
    const started = await manager.start('route a')
    if (started.workerId === undefined) throw new Error('worker was not admitted')
    await writeFile(path.join(root, 'problem.md'), 'changed problem')
    workflow.resolve(started.workerId)

    const result = await manager.wait('stale-wait', new AbortController().signal)
    expect(result.completed[0]).toMatchObject({ workerId: started.workerId, status: 'stale_problem' })
    await manager.stop()
  })

  it('releases a provisional winner when the post-workflow problem check fails', async () => {
    let workspace = ''
    const execute: WorkerExecutor = async context => {
      expect(await context.claimSolvedWinner()).toBe(true)
      await writeFile(path.join(workspace, 'problem.md'), 'changed after the provisional claim')
      return {
        status: 'solved',
        producedVerifiedProposition: true,
        solved: true,
        statement: 'A stale proposed solution.',
        propositionPath: 'verified_propositions/stale.md',
        artifactPaths: [],
      }
    }
    const fixtureValue = await fixture(1, execute)
    workspace = fixtureValue.root
    const started = await fixtureValue.manager.start('route a')

    const result = await fixtureValue.manager.wait('stale-winner-wait', new AbortController().signal)
    expect(result.completed[0]).toMatchObject({ workerId: started.workerId, status: 'stale_problem' })
    expect(fixtureValue.store.currentState().winnerWorkerId).toBeUndefined()
    expect(fixtureValue.store.currentState().status).not.toBe('solved')
    await fixtureValue.manager.stop()
  })

  it('updates the hint snapshot and emits one notification under concurrent starts', async () => {
    const workflow = controlledWorkflow()
    const { root, manager, notices } = await fixture(2, workflow.execute)
    await writeFile(path.join(root, 'hint.md'), 'new hint')

    const starts = await Promise.all([manager.start('route a'), manager.start('route b')])
    expect(starts.every(result => result.accepted)).toBe(true)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/hint\.md changed/)
    const digests = new Set(workflow.contexts.map(context => context.hintDigest))
    expect(digests.size).toBe(1)
    expect(digests.has(undefined)).toBe(false)

    for (const id of manager.activeIds()) workflow.resolve(id)
    await manager.stop()
  })

  it('aborts active workflows and records interrupted completions on stop', async () => {
    const execute: WorkerExecutor = async context => new Promise((_resolve, reject) => {
      const abort = () => reject(context.signal.reason ?? new Error('aborted'))
      context.signal.addEventListener('abort', abort, { once: true })
    })
    const { manager, store } = await fixture(1, execute)
    const started = await manager.start('route a')
    await manager.stop()

    expect(await store.listCompletions()).toEqual([
      expect.objectContaining({ workerId: started.workerId, status: 'interrupted' }),
    ])
  })
})
