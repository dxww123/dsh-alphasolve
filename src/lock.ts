/** Cross-session and cross-process ownership lock for one canonical workspace. */

import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicWriteJson } from './atomic.js'
import { canonicalWorkspace, resolveWorkspacePath } from './workspace.js'

const LOCK_VERSION = 1 as const

interface LockRecord {
  readonly version: typeof LOCK_VERSION
  readonly pid: number
  readonly sessionId: string
  readonly token: string
  readonly workspace: string
  readonly acquiredAt: string
}

/** A live session already owns this canonical project directory. */
export class WorkspaceBusyError extends Error {
  constructor(public readonly owner: LockRecord) {
    super(`workspace is already owned by AlphaSolve session ${owner.sessionId} (pid ${owner.pid})`)
    this.name = 'WorkspaceBusyError'
  }
}

/** A lock exists but cannot be trusted or recovered automatically. */
export class WorkspaceLockError extends Error {
  constructor(message: string, public readonly path: string, options?: ErrorOptions) {
    super(`${message}: ${path}`, options)
    this.name = 'WorkspaceLockError'
  }
}

const ownedInProcess = new Map<string, LockRecord>()

/** Validate the untrusted persisted lock document. */
function parseLock(text: string, path: string): LockRecord {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new WorkspaceLockError('lock JSON is malformed; explicit repair is required', path, { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceLockError('lock JSON root is invalid', path)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = ['acquiredAt', 'pid', 'sessionId', 'token', 'version', 'workspace']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new WorkspaceLockError('lock JSON has unknown or missing fields', path)
  }
  if (record.version !== LOCK_VERSION
    || typeof record.pid !== 'number'
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.sessionId !== 'string'
    || record.sessionId === ''
    || typeof record.token !== 'string'
    || record.token === ''
    || typeof record.workspace !== 'string'
    || record.workspace === ''
    || typeof record.acquiredAt !== 'string'
    || Number.isNaN(Date.parse(record.acquiredAt))) {
    throw new WorkspaceLockError('lock JSON fields are invalid', path)
  }
  return record as unknown as LockRecord
}

/** Read an existing lock without following a planted symlink. */
async function readLock(path: string): Promise<LockRecord> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspaceLockError('lock path is not an ordinary non-symlink file', path)
  }
  return parseLock(await readFile(path, 'utf8'), path)
}

/** Conservatively decide whether the recorded process still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}

/** Exact lock ownership returned to one session runtime. */
export interface WorkspaceLock {
  readonly workspace: string
  readonly sessionId: string
  readonly token: string
  readonly path: string
  assertOwned(): Promise<void>
  release(): Promise<void>
}

/** Acquire the one-session-per-canonical-directory lock, recovering dead owners only. */
export async function acquireWorkspaceLock(workspace: string, sessionId: string): Promise<WorkspaceLock> {
  if (sessionId.trim() === '') throw new TypeError('sessionId must not be empty')
  const canonical = await canonicalWorkspace(workspace)
  const lockPath = await resolveWorkspacePath(canonical, '.alphasolve/lock.json', { mustExist: false })
  const inProcess = ownedInProcess.get(canonical)
  if (inProcess !== undefined) throw new WorkspaceBusyError(inProcess)

  const record: LockRecord = {
    version: LOCK_VERSION,
    pid: process.pid,
    sessionId,
    token: randomUUID(),
    workspace: canonical,
    acquiredAt: new Date().toISOString(),
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let created = false
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      created = true
      try {
        await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      ownedInProcess.set(canonical, record)
      let released = false
      return {
        workspace: canonical,
        sessionId,
        token: record.token,
        path: lockPath,
        async assertOwned(): Promise<void> {
          if (released) throw new WorkspaceLockError('workspace lock was already released', lockPath)
          const current = await readLock(lockPath)
          if (current.token !== record.token || current.sessionId !== record.sessionId) {
            throw new WorkspaceLockError('workspace lock is no longer owned by this runtime', lockPath)
          }
        },
        async release(): Promise<void> {
          if (released) return
          released = true
          try {
            const current = await readLock(lockPath)
            if (current.token !== record.token) {
              throw new WorkspaceLockError('refusing to release a lock now owned by another runtime', lockPath)
            }
            await unlink(lockPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          } finally {
            if (ownedInProcess.get(canonical)?.token === record.token) ownedInProcess.delete(canonical)
          }
        },
      }
    } catch (error) {
      if (created) {
        try {
          await unlink(lockPath)
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new WorkspaceLockError('failed to clean up an incomplete lock', lockPath, { cause: cleanupError })
          }
        }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const owner = await readLock(lockPath)
    if (owner.workspace !== canonical) {
      throw new WorkspaceLockError('lock workspace metadata does not match the canonical workspace', lockPath)
    }
    if (isProcessAlive(owner.pid)) throw new WorkspaceBusyError(owner)

    // Re-read immediately before the destructive rename. This does not claim
    // kernel-level compare-and-swap semantics, but prevents a contender which
    // observed an older dead owner from knowingly moving a replacement lock.
    let confirmedOwner: LockRecord
    try {
      confirmedOwner = await readLock(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (confirmedOwner.token !== owner.token) continue
    if (confirmedOwner.workspace !== canonical) {
      throw new WorkspaceLockError('replacement lock workspace metadata does not match the canonical workspace', lockPath)
    }
    if (isProcessAlive(confirmedOwner.pid)) throw new WorkspaceBusyError(confirmedOwner)

    const staleName = `.alphasolve/backups/stale-lock-${Date.now()}-${confirmedOwner.token.slice(0, 8)}.json`
    const stalePath = await resolveWorkspacePath(canonical, staleName, { mustExist: false })
    try {
      await rename(lockPath, stalePath)
      await atomicWriteJson(`${stalePath}.recovery.json`, {
        recoveredAt: new Date().toISOString(),
        recoveredByPid: process.pid,
        previousOwner: confirmedOwner,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new WorkspaceLockError('unable to acquire lock after stale-owner recovery races', lockPath)
}

/** Test helper: expose only whether a canonical workspace is locally owned. */
export function isWorkspaceOwnedInProcess(workspace: string): boolean {
  return ownedInProcess.has(resolve(workspace))
}
