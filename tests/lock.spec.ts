import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireWorkspaceLock,
  isProcessAlive,
  isWorkspaceOwnedInProcess,
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
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace lock', () => {
  it('excludes another session in-process and releases idempotently', async () => {
    const root = await workspace()
    const first = await acquireWorkspaceLock(root, 'session-a')
    expect(isWorkspaceOwnedInProcess(root)).toBe(true)
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
      version: 1,
      pid: deadPid,
      sessionId: 'stale-session',
      token: 'stale-token-1234',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
    })}\n`)

    const lock = await acquireWorkspaceLock(root, 'fresh-session')
    const backups = await readdir(path.join(root, '.alphasolve', 'backups'))
    expect(backups.some(name => name.startsWith('stale-lock-') && name.endsWith('.json'))).toBe(true)
    expect(backups.some(name => name.endsWith('.json.recovery.json'))).toBe(true)
    await lock.release()
  })

  it('admits exactly one contender during concurrent stale-lock recovery', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.alphasolve', 'lock.json'), `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      sessionId: 'stale-session',
      token: 'stale-race-token',
      workspace: root,
      acquiredAt: '2026-01-01T00:00:00.000Z',
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

  it('fails closed on mismatched metadata and a planted lock symlink', async () => {
    const root = await workspace()
    const lockPath = path.join(root, '.alphasolve', 'lock.json')
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      sessionId: 'stale-session',
      token: 'stale-token',
      workspace: '/different/workspace',
      acquiredAt: '2026-01-01T00:00:00.000Z',
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
