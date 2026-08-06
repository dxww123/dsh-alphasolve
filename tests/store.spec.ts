import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseCompletion, RuntimeStore } from '../src/store.js'
import {
  STATE_VERSION,
  type SessionState,
  type WorkerCompletion,
  type WorkerRecord,
} from '../src/types.js'
import { initializeWorkspace } from '../src/workspace.js'

const roots: string[] = []

async function createStore(capacity = 2): Promise<{ root: string; store: RuntimeStore; initial: SessionState }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-store-'))
  roots.push(root)
  await initializeWorkspace(root)
  const initial: SessionState = {
    version: STATE_VERSION,
    sessionId: 'session-a',
    workspace: root,
    activatedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    problemDigest: 'problem-digest',
    capacity,
    detailedTrace: true,
    modelOverrides: {},
    nextCompletionSequence: 1,
  }
  const store = new RuntimeStore(root)
  await store.open(initial)
  return { root, store, initial }
}

function completion(workerId: string): Omit<WorkerCompletion, 'version' | 'sequence'> {
  return {
    workerId,
    status: 'verified',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    problemDigest: 'problem-digest',
    producedVerifiedProposition: true,
    solved: false,
    summary: `verified ${workerId}`,
    statement: `statement ${workerId}`,
    propositionPath: `verified_propositions/${workerId}.md`,
    artifactPaths: [`.alphasolve/workers/${workerId}.json`],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('completion delivery ledger', () => {
  it('reserves, releases, and commits each completion exactly once', async () => {
    const { store } = await createStore()
    const first = await store.recordCompletion(completion('worker-a'))
    const second = await store.recordCompletion(completion('worker-b'))
    expect([first.sequence, second.sequence]).toEqual([1, 2])

    const reserved = await store.reserveUndelivered('call-a')
    expect(reserved.map(item => item.workerId)).toEqual(['worker-a', 'worker-b'])
    expect(await store.reserveUndelivered('call-b')).toEqual([])

    await store.releaseReservation('call-a')
    expect((await store.reserveUndelivered('call-b')).map(item => item.workerId)).toEqual(['worker-a', 'worker-b'])
    await store.commitDelivery('call-b')
    expect(await store.reserveUndelivered('call-c')).toEqual([])
    expect((await store.listCompletions()).every(item => item.deliveredByCallId === 'call-b')).toBe(true)
  })

  it('recovers committed reservations and releases uncommitted reservations after a crash', async () => {
    const { root, store, initial } = await createStore()
    await store.recordCompletion(completion('worker-a'))
    await store.reserveUndelivered('committed-call')
    await store.recordCompletion(completion('worker-b'))
    await store.reserveUndelivered('lost-call')

    const resumed = new RuntimeStore(root)
    await resumed.open(initial)
    await resumed.recoverReservations(new Set(['committed-call']))

    const entries = await resumed.listCompletions()
    expect(entries[0]).toMatchObject({ workerId: 'worker-a', deliveredByCallId: 'committed-call' })
    expect(entries[1]?.reservedByCallId).toBeUndefined()
    expect((await resumed.reserveUndelivered('next-call')).map(item => item.workerId)).toEqual(['worker-b'])
  })

  it('rejects duplicate worker completion publication and empty call ids', async () => {
    const { store } = await createStore()
    await store.recordCompletion(completion('worker-a'))
    await expect(store.recordCompletion(completion('worker-a'))).rejects.toThrow(/already exists/)
    await expect(store.reserveUndelivered('')).rejects.toThrow(/callId must not be empty/)
    await expect(store.commitDelivery('  ')).rejects.toThrow(/callId must not be empty/)
    await expect(store.releaseReservation('')).rejects.toThrow(/callId must not be empty/)
  })
})

describe('completion corruption checks', () => {
  it('validates delivery invariants and timestamps', () => {
    const base = {
      version: STATE_VERSION,
      sequence: 1,
      ...completion('worker-a'),
    }
    expect(() => parseCompletion({ ...base, completedAt: 'not-a-date' }, 'completion.json'))
      .toThrow(/completedAt must be an ISO date/)
    expect(() => parseCompletion({ ...base, deliveredByCallId: 'call-a' }, 'completion.json'))
      .toThrow(/present together/)
    expect(() => parseCompletion({
      ...base,
      reservedByCallId: 'call-a',
      deliveredByCallId: 'call-b',
      deliveredAt: '2026-01-01T02:00:00.000Z',
    }, 'completion.json')).toThrow(/matching reservation/)
  })

  it('accepts a failed theorem-check completion that safely promoted a verified proposition', () => {
    expect(parseCompletion({
      version: STATE_VERSION,
      sequence: 1,
      ...completion('worker-a'),
      status: 'failed',
      producedVerifiedProposition: true,
      solved: false,
      failureStage: 'theorem_checker:1',
      reason: 'theorem checker provider unavailable',
    }, 'completion.json')).toMatchObject({
      status: 'failed',
      producedVerifiedProposition: true,
      solved: false,
      propositionPath: 'verified_propositions/worker-a.md',
      failureStage: 'theorem_checker:1',
    })
  })

  it('rejects duplicate sequences, filename mismatches, and symlink ledger entries', async () => {
    const { root, store } = await createStore()
    await store.recordCompletion(completion('worker-a'))
    await store.recordCompletion(completion('worker-b'))
    const secondPath = path.join(root, '.alphasolve', 'completions', 'worker-b.json')
    const second = JSON.parse(await readFile(secondPath, 'utf8')) as Record<string, unknown>
    await writeFile(secondPath, `${JSON.stringify({ ...second, sequence: 1 })}\n`)
    await expect(store.listCompletions()).rejects.toThrow(/duplicate completion sequence/)

    await writeFile(secondPath, `${JSON.stringify({ ...second, workerId: 'different-worker' })}\n`)
    await expect(store.listCompletions()).rejects.toThrow(/filename does not match/)
    await writeFile(secondPath, `${JSON.stringify(second)}\n`)

    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-store-outside-'))
    roots.push(outside)
    const outsideFile = path.join(outside, 'evil.json')
    await writeFile(outsideFile, '{}')
    await symlink(outsideFile, path.join(root, '.alphasolve', 'completions', 'evil.json'))
    await expect(store.listCompletions()).rejects.toThrow()
  })

  it('reconciles the next sequence after an interrupted partial state update', async () => {
    const { root, store, initial } = await createStore()
    await store.recordCompletion(completion('worker-a'))
    const firstPath = path.join(root, '.alphasolve', 'completions', 'worker-a.json')
    const first = JSON.parse(await readFile(firstPath, 'utf8')) as Record<string, unknown>
    await writeFile(firstPath, `${JSON.stringify({ ...first, sequence: 5 })}\n`)

    const resumed = new RuntimeStore(root)
    const opened = await resumed.open(initial)
    expect(opened).toMatchObject({ resumed: true })
    expect(opened.state).toMatchObject({ status: 'interrupted', nextCompletionSequence: 6 })
    expect((await resumed.recordCompletion(completion('worker-b'))).sequence).toBe(6)
  })

  it('does not guess through a corrupted persisted state document', async () => {
    const { root, initial } = await createStore()
    await writeFile(path.join(root, '.alphasolve', 'state.json'), '{"version": 999}\n')
    await expect(new RuntimeStore(root).open(initial)).rejects.toThrow(/unknown fields|unsupported state version/)
  })
})

describe('worker crash recovery', () => {
  function worker(id: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
    return {
      version: STATE_VERSION,
      id,
      instruction: 'try one route',
      phase: 'verifier',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
      problemDigest: 'problem-digest',
      hintDigest: 'hint-digest',
      round: 2,
      verifierProfile: 'citation',
      theoremChecks: 0,
      propositionPath: `unverified_propositions/prop-${id}/proposition.md`,
      artifactPaths: [`.alphasolve/workers/${id}.json`],
      ...overrides,
    }
  }

  it('turns a crash-left active worker into one interrupted, deliverable completion', async () => {
    const { root, store } = await createStore()
    const workerPath = path.join(root, '.alphasolve', 'workers', 'worker-live.json')
    await writeFile(workerPath, `${JSON.stringify(worker('worker-live'))}\n`)
    const tracePath = '.alphasolve/traces/workflow-role-worker-live.json'
    await writeFile(path.join(root, tracePath), '{}\n')
    await store.appendWorkerTracePath('worker-live', tracePath)

    const recovered = await store.recoverInterruptedWorkers()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      workerId: 'worker-live',
      status: 'interrupted',
      problemDigest: 'problem-digest',
      hintDigest: 'hint-digest',
      failureStage: 'verifier',
      startedAt: '2026-01-01T00:00:00.000Z',
      summary: 'worker was active when the prior AlphaSolve runtime ended',
      artifactPaths: expect.arrayContaining([tracePath]),
    })
    expect(JSON.parse(await readFile(workerPath, 'utf8'))).toMatchObject({
      phase: 'complete', terminalStatus: 'interrupted', failureStage: 'verifier',
    })
    expect((await store.reserveUndelivered('recovery-wait')).map(item => item.workerId))
      .toEqual(['worker-live'])
    expect(await store.recoverInterruptedWorkers()).toEqual([])
  })

  it('publishes a terminal worker snapshot whose completion write was interrupted', async () => {
    const { root, store } = await createStore()
    await writeFile(
      path.join(root, '.alphasolve', 'workers', 'worker-terminal.json'),
      `${JSON.stringify(worker('worker-terminal', {
        phase: 'complete',
        terminalStatus: 'verified',
        completedAt: '2026-01-01T00:20:00.000Z',
        verifiedPath: 'verified_propositions/recovered.md',
        statement: 'Recovered statement.',
      }))}\n`,
    )

    await expect(store.recoverInterruptedWorkers()).resolves.toMatchObject([{
      workerId: 'worker-terminal',
      status: 'verified',
      producedVerifiedProposition: true,
      solved: false,
      propositionPath: 'verified_propositions/recovered.md',
      statement: 'Recovered statement.',
    }])
  })

  it('recovers a failed theorem-check worker with its promoted proposition intact', async () => {
    const { root, store } = await createStore()
    await writeFile(
      path.join(root, '.alphasolve', 'workers', 'worker-theorem-infra.json'),
      `${JSON.stringify(worker('worker-theorem-infra', {
        phase: 'complete',
        terminalStatus: 'failed',
        completedAt: '2026-01-01T00:20:00.000Z',
        verifiedPath: 'verified_propositions/approved.md',
        statement: 'Approved statement.',
        failureStage: 'theorem_checker:1',
        reason: 'theorem checker provider unavailable',
      }))}\n`,
    )

    await expect(store.recoverInterruptedWorkers()).resolves.toMatchObject([{
      workerId: 'worker-theorem-infra',
      status: 'failed',
      producedVerifiedProposition: true,
      solved: false,
      propositionPath: 'verified_propositions/approved.md',
      failureStage: 'theorem_checker:1',
    }])
  })

  it('clears a crash-left provisional winner when no durable solved completion exists', async () => {
    const { root, store } = await createStore()
    await store.updateState(state => ({
      ...state,
      status: 'solved',
      winnerWorkerId: 'worker-crashed-winner',
    }))
    await writeFile(
      path.join(root, '.alphasolve', 'workers', 'worker-crashed-winner.json'),
      `${JSON.stringify(worker('worker-crashed-winner', { phase: 'promoting' }))}\n`,
    )

    await store.recoverInterruptedWorkers()
    await expect(store.reconcileSolvedTerminal(false)).resolves.toBeUndefined()
    expect(store.currentState()).toMatchObject({ status: 'interrupted' })
    expect(store.currentState().winnerWorkerId).toBeUndefined()
    expect((await store.listCompletions())[0]).toMatchObject({
      workerId: 'worker-crashed-winner',
      status: 'interrupted',
      solved: false,
    })
  })

  it('repairs the completion-before-state crash window to a terminal solved state', async () => {
    const { store } = await createStore()
    await store.updateState(state => ({ ...state, winnerWorkerId: 'worker-winner' }))
    await store.recordCompletion({
      ...completion('worker-winner'),
      status: 'solved',
      solved: true,
      summary: 'worker produced the accepted solution',
    })

    await expect(store.reconcileSolvedTerminal(true)).resolves.toMatchObject({
      workerId: 'worker-winner',
      status: 'solved',
    })
    expect(store.currentState()).toMatchObject({
      status: 'solved',
      winnerWorkerId: 'worker-winner',
    })
  })

  it('fails closed when a solved completion has no complete solution', async () => {
    const { store } = await createStore()
    await store.recordCompletion({
      ...completion('worker-winner'),
      status: 'solved',
      solved: true,
      summary: 'worker produced the accepted solution',
    })
    await expect(store.reconcileSolvedTerminal(false)).rejects.toThrow(/no complete solution\.md/)
  })
})
