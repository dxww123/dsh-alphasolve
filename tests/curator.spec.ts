import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DurableCurator,
  hasRecoverableCuratorTasks,
  type CuratorRunnerContext,
} from '../src/curator.js'
import { CuratorKnowledgeTools } from '../src/curator-tools.js'
import { STATE_VERSION, type CuratorTask } from '../src/types.js'
import { initializeWorkspace } from '../src/workspace.js'

const temporaryRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-curator-'))
  temporaryRoots.push(root)
  await initializeWorkspace(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sequentialIds(): () => string {
  let value = 0
  return () => String(++value)
}

describe('durable curator queue', () => {
  it('runs exactly one FIFO consumer and inserts a health check after each four digests', async () => {
    const root = await workspace()
    const started: string[] = []
    let running = 0
    let maximumRunning = 0
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      idFactory: sequentialIds(),
      runner: async ({ task }) => {
        running += 1
        maximumRunning = Math.max(maximumRunning, running)
        started.push(`${task.kind}:${task.sourceWorkerId ?? '-'}`)
        await Promise.resolve()
        running -= 1
      },
    })

    for (let index = 1; index <= 8; index += 1) {
      await curator.submit({ kind: 'digest', sourceWorkerId: `worker-${index}` })
    }
    await curator.waitForIdle()

    expect(maximumRunning).toBe(1)
    expect(started).toEqual([
      'digest:worker-1',
      'digest:worker-2',
      'digest:worker-3',
      'digest:worker-4',
      'health_check:-',
      'digest:worker-5',
      'digest:worker-6',
      'digest:worker-7',
      'digest:worker-8',
      'health_check:-',
    ])
    expect((await curator.snapshot()).every(task => task.status === 'completed')).toBe(true)
    expect((await curator.stop()).drained).toBe(true)
  })

  it('keeps stable caller ids idempotent and records failures without blocking later work', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'traces', 'a.json'), '{}\n')
    const seen: string[] = []
    const surfaced: string[] = []
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      onTaskFailure: (task, error) => surfaced.push(`${task.id}:${String(error)}`),
      runner: async ({ task }) => {
        seen.push(task.id)
        if (task.id === 'fails') throw new Error('curation rejected this trace')
      },
    })

    const first = await curator.submit({ id: 'fails', kind: 'digest', tracePath: '.alphasolve/traces/a.json' })
    const duplicate = await curator.submit({ id: 'fails', kind: 'digest', tracePath: '.alphasolve/traces/a.json' })
    await curator.submit({ id: 'works', kind: 'verifier_final' })
    await curator.waitForIdle()

    expect(duplicate.id).toBe(first.id)
    expect(seen).toEqual(['fails', 'works'])
    expect(surfaced).toEqual(['fails:Error: curation rejected this trace'])
    expect(await curator.snapshot()).toMatchObject([
      { id: 'fails', status: 'failed', attempts: 1, lastError: 'curation rejected this trace' },
      { id: 'works', status: 'completed', attempts: 1 },
    ])
    await expect(curator.submit({ id: 'fails', kind: 'health_check' })).rejects.toThrow(/conflicts/)
    await curator.stop()
  })

  it('recovers an active task as pending and replays it from the beginning after restart', async () => {
    const root = await workspace()
    const queuePath = path.join(root, '.alphasolve', 'curator', 'queue.json')
    const tasks: CuratorTask[] = [
      {
        version: STATE_VERSION,
        id: 'crashed',
        kind: 'digest',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'active',
        attempts: 1,
      },
      {
        version: STATE_VERSION,
        id: 'next',
        kind: 'verifier_final',
        createdAt: '2026-01-01T00:00:01.000Z',
        status: 'pending',
        attempts: 0,
      },
    ]
    await writeFile(queuePath, `${JSON.stringify({ version: STATE_VERSION, tasks })}\n`)
    const seen: string[] = []
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ task }) => { seen.push(task.id) },
    })
    await curator.waitForIdle()

    expect(seen).toEqual(['crashed', 'next'])
    expect(await curator.snapshot()).toMatchObject([
      { id: 'crashed', status: 'completed', attempts: 2 },
      { id: 'next', status: 'completed', attempts: 1 },
    ])
    const durable = JSON.parse(await readFile(queuePath, 'utf8')) as { tasks: CuratorTask[] }
    expect(durable.tasks.map(task => task.status)).toEqual(['completed', 'completed'])
    await curator.stop()
  })

  it('replays a crash after a knowledge write but before queue settlement exactly once', async () => {
    const root = await workspace()
    const taskId = 'crash-after-write'
    const firstAttempt = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await firstAttempt.write('knowledge/recovered.md', '# Recovered\n')

    const queuePath = path.join(root, '.alphasolve', 'curator', 'queue.json')
    const active: CuratorTask = {
      version: STATE_VERSION,
      id: taskId,
      kind: 'digest',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      attempts: 1,
    }
    await writeFile(queuePath, `${JSON.stringify({ version: STATE_VERSION, tasks: [active] })}\n`)

    const curator = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ tools }) => {
        await tools.write('knowledge/recovered.md', '# Recovered\n')
      },
    })
    await curator.waitForIdle()

    expect(await readFile(path.join(root, 'knowledge', 'recovered.md'), 'utf8')).toBe(
      '---\nmodification_count: 1\n---\n# Recovered\n',
    )
    expect(await curator.snapshot()).toMatchObject([{ id: taskId, status: 'completed', attempts: 2 }])
    const journalFiles = await readdir(path.join(root, '.alphasolve', 'curator', 'mutations'))
    expect(journalFiles).toHaveLength(1)
    const journal = JSON.parse(await readFile(
      path.join(root, '.alphasolve', 'curator', 'mutations', journalFiles[0] as string),
      'utf8',
    )) as { taskId: string; operations: Array<Record<string, unknown>> }
    expect(journal.taskId).toBe(taskId)
    expect(journal.operations).toMatchObject([
      {
        operationKey: `${taskId}:1`,
        kind: 'write',
        status: 'applied',
        result: { path: 'knowledge/recovered.md' },
      },
      {
        operationKey: `${taskId}:2`,
        kind: 'finalize_metadata',
        status: 'applied',
        result: { path: 'knowledge/recovered.md' },
      },
    ])
    for (const operation of journal.operations) {
      expect(operation.beforeDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(operation.afterDigest).toMatch(/^[a-f0-9]{64}$/)
    }
    await curator.stop()
  })

  it('replays a crash after metadata finalization without incrementing metadata again', async () => {
    const root = await workspace()
    const taskId = 'crash-after-finalize'
    const firstAttempt = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await firstAttempt.write('knowledge/finalized.md', '# Finalized\n')
    await firstAttempt.finalizeMetadata()

    const queuePath = path.join(root, '.alphasolve', 'curator', 'queue.json')
    const active: CuratorTask = {
      version: STATE_VERSION,
      id: taskId,
      kind: 'digest',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'active',
      attempts: 1,
    }
    await writeFile(queuePath, `${JSON.stringify({ version: STATE_VERSION, tasks: [active] })}\n`)
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ tools }) => {
        await tools.write('knowledge/finalized.md', '# Finalized\n')
      },
    })
    await curator.waitForIdle()

    expect(await readFile(path.join(root, 'knowledge', 'finalized.md'), 'utf8')).toBe(
      '---\nmodification_count: 1\n---\n# Finalized\n',
    )
    expect(await curator.snapshot()).toMatchObject([{ id: taskId, status: 'completed', attempts: 2 }])
    await curator.stop()
  })

  it('rejects unknown durable queue fields and non-canonical trace paths', async () => {
    const rootWithRootExtra = await workspace()
    await writeFile(
      path.join(rootWithRootExtra, '.alphasolve', 'curator', 'queue.json'),
      `${JSON.stringify({ version: STATE_VERSION, tasks: [], unexpected: true })}\n`,
    )
    await expect(DurableCurator.open({ workspaceRoot: rootWithRootExtra, runner: async () => undefined }))
      .rejects.toThrow(/queue file/)

    const rootWithTaskExtra = await workspace()
    await writeFile(
      path.join(rootWithTaskExtra, '.alphasolve', 'curator', 'queue.json'),
      `${JSON.stringify({
        version: STATE_VERSION,
        tasks: [{
          version: STATE_VERSION,
          id: 'extra',
          kind: 'digest',
          createdAt: '2026-01-01T00:00:00.000Z',
          status: 'pending',
          attempts: 0,
          unexpected: true,
        }],
      })}\n`,
    )
    await expect(DurableCurator.open({ workspaceRoot: rootWithTaskExtra, runner: async () => undefined }))
      .rejects.toThrow(/exact-schema/)

    const rootWithBadTrace = await workspace()
    await writeFile(
      path.join(rootWithBadTrace, '.alphasolve', 'curator', 'queue.json'),
      `${JSON.stringify({
        version: STATE_VERSION,
        tasks: [{
          version: STATE_VERSION,
          id: 'bad-trace',
          kind: 'digest',
          createdAt: '2026-01-01T00:00:00.000Z',
          tracePath: 'verified_propositions/fabricated.json',
          status: 'pending',
          attempts: 0,
        }],
      })}\n`,
    )
    await expect(DurableCurator.open({ workspaceRoot: rootWithBadTrace, runner: async () => undefined }))
      .rejects.toThrow(/invalid curator trace path/)

    const root = await workspace()
    const curator = await DurableCurator.open({ workspaceRoot: root, runner: async () => undefined })
    await expect(curator.submit({ kind: 'digest', tracePath: 'problem.md' })).rejects.toThrow(/canonical JSON/)
    await expect(curator.submit({ kind: 'digest', tracePath: '.alphasolve/traces/nested/a.json' }))
      .rejects.toThrow(/canonical JSON/)
    await expect(curator.submit({ kind: 'digest', tracePath: '.alphasolve/traces/a.txt' }))
      .rejects.toThrow(/canonical JSON/)
    await curator.stop()
  })

  it('fails a task before runner dispatch when its trace is a symlink or invalid JSON', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'problem.md'), '{}\n')
    await symlink(path.join(root, 'problem.md'), path.join(root, '.alphasolve', 'traces', 'alias.json'))
    await writeFile(path.join(root, '.alphasolve', 'traces', 'invalid.json'), 'not json\n')
    const seen: string[] = []
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ task }) => { seen.push(task.id) },
    })
    await curator.submit({ id: 'alias', kind: 'digest', tracePath: '.alphasolve/traces/alias.json' })
    await curator.submit({ id: 'invalid', kind: 'digest', tracePath: '.alphasolve/traces/invalid.json' })
    await curator.waitForIdle()

    expect(seen).toEqual([])
    expect(await curator.snapshot()).toMatchObject([
      { id: 'alias', status: 'failed', lastError: expect.stringMatching(/non-symlink/) },
      { id: 'invalid', status: 'failed', lastError: expect.stringMatching(/malformed durable JSON/) },
    ])
    await curator.stop()

    await rm(path.join(root, '.alphasolve', 'traces'), { recursive: true })
    await writeFile(path.join(root, 'verified_propositions', 'borrowed.json'), '{}\n')
    await symlink(
      path.join(root, 'verified_propositions'),
      path.join(root, '.alphasolve', 'traces'),
      'dir',
    )
    const aliasedDirectory = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ task }) => { seen.push(task.id) },
    })
    await aliasedDirectory.submit({
      id: 'aliased-directory',
      kind: 'digest',
      tracePath: '.alphasolve/traces/borrowed.json',
    })
    await aliasedDirectory.waitForIdle()
    expect(seen).toEqual([])
    expect(await aliasedDirectory.snapshot()).toContainEqual(expect.objectContaining({
      id: 'aliased-directory',
      status: 'failed',
      lastError: expect.stringMatching(/trace directory escapes/),
    }))
    await aliasedDirectory.stop()
  })

  it('inspects recoverable queue state without mutating it', async () => {
    const root = await workspace()
    const queuePath = path.join(root, '.alphasolve', 'curator', 'queue.json')
    const pending: CuratorTask = {
      version: STATE_VERSION,
      id: 'pending',
      kind: 'digest',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      attempts: 0,
    }
    await writeFile(queuePath, `${JSON.stringify({ version: STATE_VERSION, tasks: [pending] })}\n`)
    expect(await hasRecoverableCuratorTasks(root)).toBe(true)
    await writeFile(queuePath, `${JSON.stringify({
      version: STATE_VERSION,
      tasks: [{ ...pending, status: 'completed' }],
    })}\n`)
    expect(await hasRecoverableCuratorTasks(root)).toBe(false)

    await writeFile(path.join(root, 'problem.md'), `${JSON.stringify({ version: STATE_VERSION, tasks: [] })}\n`)
    await rm(queuePath)
    await symlink(path.join(root, 'problem.md'), queuePath)
    await expect(hasRecoverableCuratorTasks(root)).rejects.toThrow(/ordinary non-symlink/)
  })

  it('freezes submissions and durably returns active work to pending when drain times out', async () => {
    const root = await workspace()
    let started: (() => void) | undefined
    const active = new Promise<void>(resolve => { started = resolve })
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      drainTimeoutMs: 10,
      runner: ({ signal }: CuratorRunnerContext) => new Promise<void>((_resolve, reject) => {
        started?.()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    await curator.submit({ id: 'active', kind: 'digest' })
    await curator.submit({ id: 'waiting', kind: 'digest' })
    await active

    const stopped = await curator.stop()
    expect(stopped).toEqual({ drained: false, pending: 2, active: 0, failed: 0 })
    await expect(curator.submit({ kind: 'digest' })).rejects.toThrow(/frozen/)
    expect(await curator.snapshot()).toMatchObject([
      { id: 'active', status: 'pending', attempts: 1 },
      { id: 'waiting', status: 'pending', attempts: 0 },
    ])

    const durable = JSON.parse(await readFile(path.join(root, '.alphasolve', 'curator', 'queue.json'), 'utf8')) as {
      tasks: CuratorTask[]
    }
    expect(durable.tasks.map(task => task.status)).toEqual(['pending', 'pending'])
  })

  it('keeps close pending until the cancelled runner finishes cleanup', async () => {
    const root = await workspace()
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const curator = await DurableCurator.open({
      workspaceRoot: root, drainTimeoutMs: 0,
      runner: async ({ signal }) => {
        const cancelled = new Promise<void>(resolve => {
          signal.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true })
        })
        entered.resolve()
        await cancelled
        await release.promise
        throw signal.reason
      },
    })
    await curator.submit({ id: 'cleanup', kind: 'digest' })
    await entered.promise
    let closed = false
    const closing = curator.close().then(() => { closed = true })
    try {
      await aborted.promise
      expect(closed).toBe(false)
      expect(await curator.stop()).toMatchObject({ drained: false, pending: 1 })
    } finally {
      release.resolve()
      await closing
    }
    expect(closed).toBe(true)
    expect(await curator.snapshot()).toMatchObject([{ id: 'cleanup', status: 'pending' }])
  })

  it('lets shutdown drain queued work before returning when the runner completes in time', async () => {
    const root = await workspace()
    const seen: string[] = []
    const curator = await DurableCurator.open({
      workspaceRoot: root,
      runner: async ({ task }) => { seen.push(task.id) },
    })
    await curator.submit({ id: 'one', kind: 'digest' })
    await curator.submit({ id: 'two', kind: 'digest' })

    expect(await curator.stop({ timeoutMs: 1_000 })).toEqual({
      drained: true,
      pending: 0,
      active: 0,
      failed: 0,
    })
    expect(seen).toEqual(['one', 'two'])
  })
})
