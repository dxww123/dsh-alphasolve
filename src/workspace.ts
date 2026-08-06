/** Canonical workspace validation and AlphaSolve-owned directory initialization. */

import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { atomicWriteText } from './atomic.js'
import type { FileStamp, InputSnapshot, WorkspaceSnapshot } from './types.js'

/** Error whose message is safe to return in an activation/tool diagnostic. */
export class WorkspaceError extends Error {
  constructor(message: string, public readonly path?: string, options?: ErrorOptions) {
    super(path === undefined ? message : `${message}: ${path}`, options)
    this.name = 'WorkspaceError'
  }
}

/** AlphaSolve-owned paths relative to the immutable workspace root. */
export const WORKSPACE_DIRS = [
  'knowledge',
  'knowledge/references',
  'unverified_propositions',
  'verified_propositions',
  '.alphasolve',
  '.alphasolve/workers',
  '.alphasolve/completions',
  '.alphasolve/curator',
  '.alphasolve/traces',
  '.alphasolve/backups',
  '.alphasolve/tmp',
] as const

/** Return a SHA-256 digest for immutable-input and conflict checks. */
export function digestText(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Whether a canonical candidate is the root itself or a descendant. */
export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Normalize an untrusted relative path without accepting either platform's escape syntax. */
export function normalizeRelativePath(input: string): string {
  if (input.length === 0 || input.includes('\0')) throw new WorkspaceError('path must be a non-empty relative path', input)
  if (isAbsolute(input) || win32.isAbsolute(input) || input.startsWith('\\\\')) {
    throw new WorkspaceError('absolute paths are not allowed', input)
  }
  const components = input.replaceAll('\\', '/').split('/')
  if (components.some(component => component === '' || component === '.' || component === '..')) {
    throw new WorkspaceError('path contains an empty, dot, or parent component', input)
  }
  return components.join('/')
}

/** Canonicalize the session's immutable cwd and require an existing directory. */
export async function canonicalWorkspace(cwd: string | undefined): Promise<string> {
  if (cwd === undefined || cwd.trim() === '') throw new WorkspaceError('the session has no workspace cwd')
  let canonical: string
  try {
    canonical = await realpath(cwd)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new WorkspaceError('session cwd is not a directory', cwd)
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('unable to resolve session cwd', cwd, { cause: error })
  }
  return canonical
}

/** Find the nearest existing ancestor without following a missing-path guess. */
async function nearestExisting(path: string): Promise<string> {
  let cursor = path
  for (;;) {
    try {
      await lstat(cursor)
      return cursor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new WorkspaceError('no existing ancestor for path', path)
    cursor = parent
  }
}

/**
 * Resolve a relative workspace path and reject lexical and symlink escapes.
 * Missing final components are allowed only when `mustExist` is false.
 */
export async function resolveWorkspacePath(
  root: string,
  input: string,
  options: { readonly mustExist: boolean },
): Promise<string> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
    if (!(await stat(canonicalRoot)).isDirectory()) throw new WorkspaceError('workspace root is not a directory', root)
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('unable to resolve workspace root', root, { cause: error })
  }
  const normalized = normalizeRelativePath(input)
  const target = resolve(canonicalRoot, ...normalized.split('/'))
  if (!isContained(canonicalRoot, target)) throw new WorkspaceError('path escapes the workspace', input)

  try {
    const canonical = await realpath(target)
    if (!isContained(canonicalRoot, canonical)) throw new WorkspaceError('symlink resolves outside the workspace', input)
    return target
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (options.mustExist) throw new WorkspaceError('required path does not exist', input, { cause: error })
  }

  let ancestor: string
  try {
    ancestor = await realpath(await nearestExisting(target))
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('unable to validate path ancestry', input, { cause: error })
  }
  if (!isContained(canonicalRoot, ancestor)) throw new WorkspaceError('path ancestry resolves outside the workspace', input)
  return target
}

/** Decode bytes as strict UTF-8 instead of silently replacing invalid sequences. */
function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new WorkspaceError('file is not valid UTF-8', path, { cause: error })
  }
}

/** Read one safe ordinary UTF-8 file and compute its digest. */
export async function readWorkspaceInput(
  root: string,
  relativePath: string,
  options: { readonly nonEmpty: boolean },
): Promise<InputSnapshot> {
  const path = await resolveWorkspacePath(root, relativePath, { mustExist: true })
  let bytes: Uint8Array
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new WorkspaceError('input is not an ordinary file', relativePath)
    bytes = await readFile(path)
  } catch (error) {
    if (error instanceof WorkspaceError) throw error
    throw new WorkspaceError('unable to read input file', relativePath, { cause: error })
  }
  const content = decodeUtf8(bytes, relativePath)
  if (options.nonEmpty && content.trim() === '') throw new WorkspaceError('input file is empty', relativePath)
  return { path, content, digest: digestText(bytes) }
}

/** Test for a safe existing workspace file; missing is false and all other failures are loud. */
export async function workspaceFileExists(root: string, relativePath: string): Promise<boolean> {
  try {
    const path = await resolveWorkspacePath(root, relativePath, { mustExist: true })
    const info = await stat(path)
    if (!info.isFile()) throw new WorkspaceError('path exists but is not an ordinary file', relativePath)
    return true
  } catch (error) {
    if (error instanceof WorkspaceError && error.message.startsWith('required path does not exist')) return false
    throw error
  }
}

/** Validate the three activation-time inputs without changing the workspace. */
export async function snapshotWorkspace(cwd: string | undefined): Promise<WorkspaceSnapshot> {
  const root = await canonicalWorkspace(cwd)
  const problem = await readWorkspaceInput(root, 'problem.md', { nonEmpty: true })
  let hint: InputSnapshot | undefined
  if (await workspaceFileExists(root, 'hint.md')) {
    hint = await readWorkspaceInput(root, 'hint.md', { nonEmpty: false })
  }
  const solutionExists = await workspaceFileExists(root, 'solution.md')
  return {
    root,
    problem,
    ...hint === undefined ? {} : { hint },
    solutionExists,
  }
}

/** Create all AlphaSolve-owned directories and non-destructive knowledge skeleton files. */
export async function initializeWorkspace(root: string): Promise<void> {
  const canonicalRoot = await canonicalWorkspace(root)
  for (const relativePath of WORKSPACE_DIRS) {
    const path = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: false })
    try {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const canonical = await realpath(path)
      if (!isContained(canonicalRoot, canonical)) throw new WorkspaceError('created directory escaped the workspace', relativePath)
      if (!(await stat(canonical)).isDirectory()) {
        throw new WorkspaceError('workspace path conflicts with a non-directory', relativePath)
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError('unable to initialize workspace directory', relativePath, { cause: error })
    }
  }
  const skeletons: Readonly<Record<string, string>> = {
    'knowledge/index.md': '# Knowledge Index\n',
    'knowledge/common-errors.md': '# Common Errors\n',
    'knowledge/references/index.md': '# Reference Index\n',
  }
  for (const [relativePath, content] of Object.entries(skeletons)) {
    const path = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: false })
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await resolveWorkspacePath(canonicalRoot, relativePath, { mustExist: true })
      if (!(await stat(existing)).isFile()) {
        throw new WorkspaceError('knowledge skeleton conflicts with a non-file', relativePath)
      }
    }
  }
}

/** Atomically preserve an existing solution before an explicitly authorized overwrite. */
export async function backupSolution(root: string, now = new Date()): Promise<string | undefined> {
  if (!await workspaceFileExists(root, 'solution.md')) return undefined
  const source = await readWorkspaceInput(root, 'solution.md', { nonEmpty: false })
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const relativePath = `.alphasolve/backups/solution-${stamp}-${randomUUID().slice(0, 8)}.md`
  const target = await resolveWorkspacePath(root, relativePath, { mustExist: false })
  await atomicWriteText(target, source.content)
  return relativePath
}

/** Capture an active proposition's identity for fail-closed external-edit detection. */
export async function captureFileStamp(root: string, relativePath: string): Promise<FileStamp> {
  const path = await resolveWorkspacePath(root, relativePath, { mustExist: true })
  const [bytes, info] = await Promise.all([readFile(path), stat(path)])
  if (!info.isFile()) throw new WorkspaceError('active proposition is not an ordinary file', relativePath)
  return { digest: digestText(bytes), size: info.size, mtimeMs: info.mtimeMs }
}

/** Reject an active proposition that changed outside the role which owned it. */
export async function assertFileStamp(root: string, relativePath: string, expected: FileStamp): Promise<void> {
  const actual = await captureFileStamp(root, relativePath)
  if (actual.digest !== expected.digest || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new WorkspaceError('active proposition changed outside its owning role', relativePath)
  }
}
