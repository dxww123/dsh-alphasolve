import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireWorkspaceLock,
  isProcessAlive,
  isWorkspaceOwnedInProcess,
  setStaleSourceUnlinkedHookForTest,
  WorkspaceBusyError,
} from '../src/lock.js'
import { initializeWorkspace } from '../src/workspace.js'

const roots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-lock-'))
  roots.push(root)
  await initializeWorkspace(root)
  return root
}

afterEach(async () => {
  setStaleSourceUnlinkedHookForTest(undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace lock', () => {
  it('excludes another session in-process and releases idempotently', async () => {
    const root = await workspace()
    const first = await acquireWorkspaceLock(root, 'session-a')
    const persisted = JSON.parse(await readFile(first.path, 'utf8')) as Record<string, unknown>
    expect(persisted.version).toBe(2)
    if (persisted.processIdentity !== null) {
      expect(persisted.processIdentity).toMatchObject({
        bootId: expect.any(String),
        startTimeTicks: expect.stringMatching(/^\d+$/),
      })
    }
    expect(isWorkspaceOwnedInProcess(root)).toBe(true)
    await expect(acquireWorkspaceLock(root, 'session-a')).rejects.toBeInstanceOf(WorkspaceBusyError)
    await expect(acquireWorkspaceLock(root, 'session-b')).rejects.toBeInstanceOf(WorkspaceBusyError)

    await first.release()
    await first.release()
    expect(isWorkspaceOwnedInProcess(root)).toBe(false)
    const second = await acquireWorkspaceLock(root, 'session-b')
    await second.release()
  })

  it('uses the canonical workspace identity across symlink aliases', async () => {
    const root = await workspace()
    const aliasRoot = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-lock-alias-'))
    roots.push(aliasRoot)
    const alias = path.join(aliasRoot, 'workspace')
    await symlink(root, alias, 'dir')

    const lock = await acquireWorkspaceLock(alias, 'session-a')
    expect(lock.workspace).toBe(root)
    await expect(acquireWorkspaceLock(root, 'session-b')).rejects.toBeInstanceOf(WorkspaceBusyError)
    await lock.release()
  })

  it('recovers a lock whose recorded process is definitely dead', async () => {
    const root = await workspace()
    const deadPid = 2_147_483_647
    expect(isProcessAlive(deadPid)).toBe(false)
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 2,
      pid: deadPid,
      sessionId: 'stale-session',
      token: 'stale-token-1234',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
      processIdentity: null,
    })}\n`)

    const lock = await acquireWorkspaceLock(root, 'fresh-session')
    const backups = await readdir(path.join(root, '.alphasolve', 'backups'))
    expect(backups.some(name => name.startsWith('stale-lock-') && name.endsWith('.json'))).toBe(true)
    expect(backups.some(name => name.endsWith('.json.recovery.json'))).toBe(true)
    await lock.release()
  })

  it('fails closed on an unsupported lock version', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      sessionId: 'unsupported-session',
      token: 'unsupported-token',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
    })}\n`)

    await expect(acquireWorkspaceLock(root, 'fresh-session')).rejects.toThrow(/version is unsupported/)
  })

  it.runIf(process.platform === 'linux')('recovers a v2 lock after exact PID identity reuse', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 2,
      pid: process.pid,
      sessionId: 'stale-session',
      token: 'reused-pid-token',
      workspace: root,
      acquiredAt: new Date().toISOString(),
      processIdentity: {
        bootId: 'different-kernel-boot',
        startTimeTicks: '1',
      },
    })}\n`)

    const lock = await acquireWorkspaceLock(root, 'fresh-session')
    const backups = await readdir(path.join(root, '.alphasolve', 'backups'))
    expect(backups.some(name => name.startsWith('stale-lock-') && name.endsWith('.json'))).toBe(true)
    await lock.release()
  })

  it.runIf(process.platform === 'linux')('does not mistake a reused Linux thread ID for a live owner', async () => {
    const root = await workspace()
    const taskIds = (await readdir('/proc/self/task')).map(Number)
    const threadId = taskIds.find(id => id !== process.pid)
    expect(threadId).toBeDefined()
    if (threadId === undefined) return
    expect(isProcessAlive(threadId)).toBe(true)
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 2,
      pid: threadId,
      sessionId: 'stale-session',
      token: 'previous-reused-tid',
      workspace: root,
      acquiredAt: new Date().toISOString(),
      processIdentity: null,
    })}\n`)

    const lock = await acquireWorkspaceLock(root, 'fresh-session')
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({ version: 2, sessionId: 'fresh-session' })
    await lock.release()
  })

  it.runIf(process.platform === 'linux')('keeps a lock held by the current process', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 2,
      pid: process.pid,
      sessionId: 'live-session',
      token: 'live-token',
      workspace: root,
      acquiredAt: new Date().toISOString(),
      processIdentity: null,
    })}\n`)

    await expect(acquireWorkspaceLock(root, 'contender')).rejects.toMatchObject({
      name: 'WorkspaceBusyError',
      owner: { version: 2, sessionId: 'live-session' },
    })
  })

  it('admits exactly one contender during concurrent stale-lock recovery', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 2,
      pid: 2_147_483_647,
      sessionId: 'stale-session',
      token: 'stale-race-token',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
      processIdentity: null,
    })}\n`)

    const outcomes = await Promise.allSettled([
      acquireWorkspaceLock(root, 'contender-a'),
      acquireWorkspaceLock(root, 'contender-b'),
    ])
    const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWorkspaceLock>>> => outcome.status === 'fulfilled')
    const losers = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    if (losers[0]?.status === 'rejected') expect(losers[0].reason).toBeInstanceOf(WorkspaceBusyError)
    await winners[0]?.value.release()
  })

  it('never removes a replacement lock created while stale recovery is archiving', async () => {
    const root = await workspace()
    const lockPath = path.join(root, '.alphasolve', 'lock.json')
    await writeFile(lockPath, `${JSON.stringify({
      version: 2,
      pid: 2_147_483_647,
      sessionId: 'stale-session',
      token: 'forced-interleaving-token',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
      processIdentity: null,
    })}\n`)

    let reportSourceUnlinked!: () => void
    const sourceUnlinked = new Promise<void>(resolveSourceUnlinked => { reportSourceUnlinked = resolveSourceUnlinked })
    let resumeRecovery!: () => void
    const recoveryMayResume = new Promise<void>(resolveRecovery => { resumeRecovery = resolveRecovery })
    setStaleSourceUnlinkedHookForTest(async () => {
      reportSourceUnlinked()
      await recoveryMayResume
    })

    const recovering = acquireWorkspaceLock(root, 'recoverer-a')
    await sourceUnlinked
    const replacement = await acquireWorkspaceLock(root, 'recoverer-b')
    const replacementRecord = JSON.parse(await readFile(lockPath, 'utf8')) as { token: string }
    expect(replacementRecord.token).toBe(replacement.token)

    resumeRecovery()
    await expect(recovering).rejects.toBeInstanceOf(WorkspaceBusyError)
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
      token: replacement.token,
      sessionId: 'recoverer-b',
    })
    await replacement.release()
  })

  it('fails closed on mismatched metadata and a planted lock symlink', async () => {
    const root = await workspace()
    const lockPath = path.join(root, '.alphasolve', 'lock.json')
    await writeFile(lockPath, `${JSON.stringify({
      version: 2,
      pid: 2_147_483_647,
      sessionId: 'stale-session',
      token: 'stale-token',
      workspace: '/different/workspace',
      acquiredAt: '2026-01-01T00:00:00.000Z',
      processIdentity: null,
    })}\n`)
    await expect(acquireWorkspaceLock(root, 'session-a')).rejects.toThrow(/metadata does not match/)

    await rm(lockPath)
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-lock-outside-'))
    roots.push(outside)
    const outsideLock = path.join(outside, 'lock.json')
    await writeFile(outsideLock, '{}')
    await symlink(outsideLock, lockPath)
    await expect(acquireWorkspaceLock(root, 'session-a')).rejects.toThrow(/symlink resolves outside/)
  })

  it('never removes a lock whose ownership token changed', async () => {
    const root = await workspace()
    const lock = await acquireWorkspaceLock(root, 'session-a')
    const record = JSON.parse(await readFile(lock.path, 'utf8')) as Record<string, unknown>
    await writeFile(lock.path, `${JSON.stringify({ ...record, token: 'replacement-owner-token' })}\n`)

    await expect(lock.release()).rejects.toThrow(/owned by another runtime/)
    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toMatchObject({ token: 'replacement-owner-token' })
    expect(isWorkspaceOwnedInProcess(root)).toBe(false)
  })
})
