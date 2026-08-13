import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  archivePreviousGeneration,
  type ArchiveGenerationPhase,
} from '../src/runtime.js'
import { RuntimeStore } from '../src/store.js'
import { STATE_VERSION, type WorkerRecord } from '../src/types.js'
import { initializeWorkspace } from '../src/workspace.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function existing(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('runtime generation archive', () => {
  it('moves ledgers first and uses state.json as the final commit marker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-archive-'))
    roots.push(root)
    await initializeWorkspace(root)
    const now = new Date().toISOString()
    const store = new RuntimeStore(root)
    await store.open({
      version: STATE_VERSION,
      sessionId: 'old-session',
      workspace: root,
      activatedAt: now,
      updatedAt: now,
      status: 'active',
      problemDigest: 'old-problem-digest',
      capacity: 2,
      detailedTrace: false,
      modelOverrides: {},
      nextCompletionSequence: 1,
    })
    const statePath = path.join(root, '.alphasolve', 'state.json')
    await store.recordCompletion({
      workerId: 'previous',
      status: 'verified',
      startedAt: now,
      completedAt: now,
      problemDigest: 'old-problem-digest',
      producedVerifiedProposition: true,
      solved: false,
      summary: 'previous verified proposition',
      artifactPaths: [],
    })
    const previousWorker: WorkerRecord = {
      version: STATE_VERSION,
      id: 'previous',
      phase: 'complete',
      terminalStatus: 'verified',
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      problemDigest: 'old-problem-digest',
      round: 1,
      theoremChecks: 1,
      summary: 'previous verified proposition',
      artifactPaths: [],
    }
    await store.writeWorker(previousWorker)
    await writeFile(path.join(root, '.alphasolve', 'curator', 'queue.json'), '{"version":1,"tasks":[]}\n')

    let partialBackup = ''
    await expect(archivePreviousGeneration(root, 'new-problem-digest', {
      afterPhase: async (phase, backup) => {
        expect(phase).not.toBe('committed')
        expect(await existing(statePath)).toBe(true)
        if (phase === 'metadata') {
          partialBackup = backup
          throw new Error('simulated crash before archive commit')
        }
      },
    })).rejects.toThrow(/simulated crash/)

    expect(partialBackup).not.toBe('')
    expect(await existing(statePath)).toBe(true)
    expect(await readdir(path.join(root, '.alphasolve', 'completions'))).toEqual([])
    expect(await readdir(path.join(root, '.alphasolve', 'workers'))).toEqual([])
    expect(JSON.parse(await readFile(path.join(partialBackup, 'completions', 'previous.json'), 'utf8')))
      .toMatchObject({ workerId: 'previous', status: 'verified' })
    expect(JSON.parse(await readFile(path.join(partialBackup, 'workers', 'previous.json'), 'utf8')))
      .toMatchObject({ id: 'previous', terminalStatus: 'verified' })
    expect(await existing(path.join(partialBackup, 'state.json'))).toBe(false)
    expect(await existing(path.join(partialBackup, 'generation.json'))).toBe(true)

    let committedBackup = ''
    const phases: ArchiveGenerationPhase[] = []
    expect(await archivePreviousGeneration(root, 'new-problem-digest', {
      afterPhase: async (phase, backup) => {
        phases.push(phase)
        if (phase === 'committed') {
          committedBackup = backup
          expect(await existing(statePath)).toBe(false)
        } else {
          expect(await existing(statePath)).toBe(true)
        }
      },
    })).toBe(true)

    expect(phases).toEqual(['completions', 'workers', 'curator', 'metadata', 'committed'])
    expect(await existing(path.join(committedBackup, 'state.json'))).toBe(true)
    expect(await readdir(path.join(root, '.alphasolve', 'completions'))).toEqual([])
    expect(await readdir(path.join(root, '.alphasolve', 'workers'))).toEqual([])
    expect(JSON.parse(await readFile(path.join(partialBackup, 'completions', 'previous.json'), 'utf8')))
      .toMatchObject({ workerId: 'previous' })
  })

  it.each([
    ['state', '.alphasolve/state.json'],
    ['completion', '.alphasolve/completions/bad.json'],
    ['worker', '.alphasolve/workers/bad.json'],
    ['curator queue', '.alphasolve/curator/queue.json'],
  ])('fails closed before moving a corrupt %s document', async (_label, corruptRelative) => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-corrupt-archive-'))
    roots.push(root)
    await initializeWorkspace(root)
    const now = new Date().toISOString()
    const store = new RuntimeStore(root)
    await store.open({
      version: STATE_VERSION,
      sessionId: 'old-session',
      workspace: root,
      activatedAt: now,
      updatedAt: now,
      status: 'solved',
      problemDigest: 'old-problem-digest',
      capacity: 2,
      detailedTrace: false,
      modelOverrides: {},
      nextCompletionSequence: 1,
    })
    await writeFile(path.join(root, '.alphasolve', 'curator', 'queue.json'), '{"version":1,"tasks":[]}\n')
    await writeFile(path.join(root, corruptRelative), '{"corrupt":true}\n')

    await expect(archivePreviousGeneration(root, 'new-problem-digest')).rejects.toThrow()
    expect(await existing(path.join(root, '.alphasolve', 'state.json'))).toBe(true)
    expect(await existing(path.join(root, '.alphasolve', 'completions'))).toBe(true)
    expect(await existing(path.join(root, '.alphasolve', 'workers'))).toBe(true)
    expect(await readdir(path.join(root, '.alphasolve', 'backups'))).toEqual([])
  })
})
