/** Cross-session and cross-process ownership lock for one canonical workspace. */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicWriteJson } from './atomic.js'
import { canonicalWorkspace, resolveWorkspacePath } from './workspace.js'

const LOCK_VERSION = 2 as const

interface LockRecordBase {
  readonly pid: number
  readonly sessionId: string
  readonly token: string
  readonly workspace: string
  readonly acquiredAt: string
}

interface LinuxProcessIdentity {
  /** Linux kernel boot identity, so start ticks cannot match across reboots. */
  readonly bootId: string
  /** Field 22 from /proc/<pid>/stat, expressed as a decimal string. */
  readonly startTimeTicks: string
}

interface LockRecord extends LockRecordBase {
  readonly version: typeof LOCK_VERSION
  /** Null only when the host cannot expose an exact process identity. */
  readonly processIdentity: LinuxProcessIdentity | null
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

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(record).sort()
  const sortedExpected = [...expected].sort()
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
}

function commonFieldsAreValid(record: Record<string, unknown>): boolean {
  return typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.sessionId === 'string'
    && record.sessionId !== ''
    && typeof record.token === 'string'
    && record.token !== ''
    && typeof record.workspace === 'string'
    && record.workspace !== ''
    && typeof record.acquiredAt === 'string'
    && !Number.isNaN(Date.parse(record.acquiredAt))
}

function parseProcessIdentity(value: unknown, path: string): LinuxProcessIdentity | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkspaceLockError('lock process identity is invalid', path)
  }
  const identity = value as Record<string, unknown>
  if (!hasExactKeys(identity, ['bootId', 'startTimeTicks'])
    || typeof identity.bootId !== 'string'
    || identity.bootId.trim() === ''
    || typeof identity.startTimeTicks !== 'string'
    || !/^\d+$/.test(identity.startTimeTicks)) {
    throw new WorkspaceLockError('lock process identity is invalid', path)
  }
  return identity as unknown as LinuxProcessIdentity
}

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
  const commonKeys = ['acquiredAt', 'pid', 'sessionId', 'token', 'version', 'workspace']
  if (!commonFieldsAreValid(record)) {
    throw new WorkspaceLockError('lock JSON fields are invalid', path)
  }
  if (record.version === LOCK_VERSION) {
    if (!hasExactKeys(record, [...commonKeys, 'processIdentity'])) {
      throw new WorkspaceLockError('lock JSON has unknown or missing fields', path)
    }
    return {
      ...(record as unknown as LockRecord),
      processIdentity: parseProcessIdentity(record.processIdentity, path),
    }
  }
  throw new WorkspaceLockError('lock JSON version is unsupported', path)
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

interface LinuxProcessSnapshot {
  readonly bootId: string | undefined
  readonly state: string
  readonly startTimeTicks: string
  readonly tgid: number
}

function parseProcStat(text: string, expectedPid: number): { state: string, startTimeTicks: string } | undefined {
  const openParen = text.indexOf('(')
  const closeParen = text.lastIndexOf(')')
  if (openParen <= 0 || closeParen <= openParen) return undefined
  if (Number(text.slice(0, openParen).trim()) !== expectedPid) return undefined
  const fields = text.slice(closeParen + 1).trim().split(/\s+/)
  const state = fields[0]
  const startTimeTicks = fields[19]
  if (state === undefined || state.length !== 1 || startTimeTicks === undefined || !/^\d+$/.test(startTimeTicks)) {
    return undefined
  }
  return { state, startTimeTicks }
}

function parseStatusId(text: string, name: 'Pid' | 'Tgid'): number | undefined {
  const match = new RegExp(`^${name}:\\s+(\\d+)\\s*$`, 'm').exec(text)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Read the exact Linux process identity without accepting a secondary thread ID. */
function readLinuxProcessSnapshot(pid: number): LinuxProcessSnapshot | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid)
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const statusPid = parseStatusId(status, 'Pid')
    const tgid = parseStatusId(status, 'Tgid')
    if (stat === undefined || statusPid !== pid || tgid === undefined) return undefined
    let bootId: string | undefined
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
    } catch (_unreadableBootId) {
      // Tgid/state are still authoritative. An owner without a readable boot ID
      // remains conservatively live.
    }
    return { ...stat, tgid, bootId }
  } catch (_unreadableProcEntry) {
    return undefined
  }
}

function currentProcessIdentity(): LinuxProcessIdentity | null {
  const snapshot = readLinuxProcessSnapshot(process.pid)
  if (snapshot === undefined || snapshot.tgid !== process.pid || snapshot.bootId === undefined) return null
  return { bootId: snapshot.bootId, startTimeTicks: snapshot.startTimeTicks }
}

/** Match the persisted owner to the exact process, not merely a live PID/TID. */
function isLockOwnerAlive(owner: LockRecord): boolean {
  if (!isProcessAlive(owner.pid)) return false
  if (process.platform !== 'linux') return true
  const snapshot = readLinuxProcessSnapshot(owner.pid)
  // /proc can be hidden or transiently unreadable. Failing closed here avoids
  // stealing a potentially live lock when exact identity cannot be checked.
  if (snapshot === undefined) return true
  if (snapshot.tgid !== owner.pid || snapshot.state === 'Z' || snapshot.state === 'X') return false
  if (owner.processIdentity === null || snapshot.bootId === undefined) return true
  return owner.processIdentity.bootId === snapshot.bootId
    && owner.processIdentity.startTimeTicks === snapshot.startTimeTicks
}

let staleSourceUnlinkedHookForTest: (() => Promise<void> | void) | undefined

/** Test helper: pause stale recovery after unlinking the old source inode. */
export function setStaleSourceUnlinkedHookForTest(hook: (() => Promise<void> | void) | undefined): void {
  staleSourceUnlinkedHookForTest = hook
}

function staleOwnerLabel(owner: LockRecord): string {
  return createHash('sha256').update(owner.token).digest('hex').slice(0, 16)
}

async function sameInode(firstPath: string, secondPath: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      lstat(firstPath, { bigint: true }),
      lstat(secondPath, { bigint: true }),
    ])
    return first.isFile() && second.isFile() && first.dev === second.dev && first.ino === second.ino
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Elect exactly one stale-lock recoverer with a deterministic hard-link claim.
 * The source remains present until the winner has pinned and revalidated its
 * inode. Losers never unlink or rename the source path.
 */
async function recoverStaleOwner(
  canonical: string,
  lockPath: string,
  observedOwner: LockRecord,
): Promise<boolean> {
  const label = staleOwnerLabel(observedOwner)
  const claimPath = await resolveWorkspacePath(
    canonical,
    `.alphasolve/backups/.stale-lock-recovery-${label}.claim`,
    { mustExist: false },
  )
  try {
    await link(lockPath, claimPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOENT') return false
    throw error
  }

  let sourceUnlinked = false
  try {
    const claimedOwner = await readLock(claimPath)
    if (claimedOwner.token !== observedOwner.token || claimedOwner.workspace !== canonical) return false
    if (!await sameInode(claimPath, lockPath)) return false

    let currentOwner: LockRecord
    try {
      currentOwner = await readLock(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (currentOwner.token !== claimedOwner.token || currentOwner.workspace !== canonical) return false
    if (isLockOwnerAlive(currentOwner)) throw new WorkspaceBusyError(currentOwner)
    if (!await sameInode(claimPath, lockPath)) return false

    await unlink(lockPath)
    sourceUnlinked = true
    await staleSourceUnlinkedHookForTest?.()

    const staleName = `.alphasolve/backups/stale-lock-${Date.now()}-${label}-${randomUUID().slice(0, 8)}.json`
    const stalePath = await resolveWorkspacePath(canonical, staleName, { mustExist: false })
    await rename(claimPath, stalePath)
    await atomicWriteJson(`${stalePath}.recovery.json`, {
      recoveredAt: new Date().toISOString(),
      recoveredByPid: process.pid,
      previousOwner: claimedOwner,
    })
    return true
  } finally {
    if (!sourceUnlinked) {
      try {
        await unlink(claimPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
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
    processIdentity: currentProcessIdentity(),
  }

  for (let attempt = 0; attempt < 16; attempt += 1) {
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

    let owner: LockRecord
    try {
      owner = await readLock(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (owner.workspace !== canonical) {
      throw new WorkspaceLockError('lock workspace metadata does not match the canonical workspace', lockPath)
    }
    if (isLockOwnerAlive(owner)) throw new WorkspaceBusyError(owner)

    const recovered = await recoverStaleOwner(canonical, lockPath, owner)
    if (!recovered) await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 1))
  }
  throw new WorkspaceLockError('unable to acquire lock after stale-owner recovery races', lockPath)
}

/** Test helper: expose only whether a canonical workspace is locally owned. */
export function isWorkspaceOwnedInProcess(workspace: string): boolean {
  return ownedInProcess.has(resolve(workspace))
}
