/** Filesystem primitives exposed to the AlphaSolve curator role. */

import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename as renameFile,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, atomicWriteText, DurableDataError, readJson } from './atomic.js'
import { STATE_VERSION, type CuratorTaskKind } from './types.js'
import {
  canonicalWorkspace,
  digestText,
  isContained,
  normalizeRelativePath,
  WorkspaceError,
} from './workspace.js'

const KNOWLEDGE = 'knowledge'
const REFERENCES = 'knowledge/references'
const PROTECTED_FILE_NAMES = new Set(['index.md', 'common-errors.md'])
const MUTATION_DIRECTORY = '.alphasolve/curator/mutations'
const HEX_DIGEST = /^[a-f0-9]{64}$/u

type MutationKind =
  | 'write'
  | 'edit'
  | 'mkdir'
  | 'rename'
  | 'move'
  | 'split_reference'
  | 'delete'
  | 'finalize_metadata'

interface MutationResource {
  readonly path: string
  readonly beforeDigest: string
  readonly afterDigest: string
}

interface MutationResult {
  readonly path?: string
  readonly paths?: readonly string[]
}

interface MutationRecord {
  readonly operationKey: string
  readonly kind: MutationKind
  readonly fingerprint: string
  readonly beforeDigest: string
  readonly afterDigest: string
  readonly resources: readonly MutationResource[]
  readonly result: MutationResult
  status: 'prepared' | 'applied'
}

interface MutationJournal {
  readonly version: typeof STATE_VERSION
  readonly taskId: string
  readonly operations: MutationRecord[]
}

interface MutationTicket {
  readonly index: number
  readonly operationKey: string
  readonly kind: MutationKind
  readonly fingerprint: string
  readonly existing?: MutationRecord
}

export interface CuratorReadResult {
  readonly path: string
  readonly content: string
  readonly startLine: number
  readonly endLine: number
  readonly totalLines: number
}

export interface CuratorDirectoryEntry {
  readonly path: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
}

export interface CuratorGrepMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface ReferencePart {
  /** New workspace-relative Markdown path below knowledge/references. */
  readonly path: string
  /** Inclusive, one-based line number. */
  readonly startLine: number
  /** Inclusive, one-based line number. */
  readonly endLine: number
}

interface ResolvedKnowledgePath {
  readonly requested: string
  readonly relative: string
  readonly absolute: string
  /** Existing target, or the canonical nearest ancestor for a new target. */
  readonly canonicalAnchor: string
  readonly exists: boolean
  readonly inReferences: boolean
}

/** A curator-tool rejection whose message is safe to show to the role agent. */
export class CuratorToolError extends Error {
  constructor(message: string, public readonly path?: string, options?: ErrorOptions) {
    super(path === undefined ? message : `${message}: ${path}`, options)
    this.name = 'CuratorToolError'
  }
}

function knowledgeDiscoveryRoot(value: string): string {
  return value === '.' || value === './' || value === '.\\' ? KNOWLEDGE : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function expectedFileDigest(content: string | Uint8Array): string {
  return digestText(`file\0${digestText(content)}`)
}

function missingDigest(): string {
  return digestText('missing')
}

function emptyDirectoryDigest(): string {
  return digestText(JSON.stringify(['directory', []]))
}

function resourcesDigest(resources: readonly MutationResource[], field: 'beforeDigest' | 'afterDigest'): string {
  return digestText(JSON.stringify(resources.map(resource => [resource.path, resource[field]])))
}

function parseMutationResult(value: unknown, journalPath: string): MutationResult {
  if (!isRecord(value)) throw new DurableDataError('invalid curator mutation result', journalPath)
  if (hasExactKeys(value, ['path']) && typeof value.path === 'string' && value.path.length > 0) {
    return { path: validateJournalKnowledgePath(value.path, journalPath) }
  }
  if (hasExactKeys(value, ['paths']) && Array.isArray(value.paths) && value.paths.length > 0
    && value.paths.every(item => typeof item === 'string' && item.length > 0)) {
    return { paths: (value.paths as string[]).map(item => validateJournalKnowledgePath(item, journalPath)) }
  }
  throw new DurableDataError('invalid curator mutation result', journalPath)
}

function validateJournalKnowledgePath(value: string, journalPath: string): string {
  let normalized: string
  try {
    normalized = normalizeRelativePath(value)
  } catch (error) {
    throw new DurableDataError('invalid path in curator mutation journal', journalPath, { cause: error })
  }
  if (normalized !== value || !isKnowledgeRelative(normalized)) {
    throw new DurableDataError('invalid path in curator mutation journal', journalPath)
  }
  return normalized
}

function parseMutationRecord(value: unknown, journalPath: string): MutationRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    'operationKey',
    'kind',
    'fingerprint',
    'beforeDigest',
    'afterDigest',
    'resources',
    'result',
    'status',
  ])) {
    throw new DurableDataError('invalid curator mutation record', journalPath)
  }
  const kinds: readonly MutationKind[] = [
    'write',
    'edit',
    'mkdir',
    'rename',
    'move',
    'split_reference',
    'delete',
    'finalize_metadata',
  ]
  if (typeof value.operationKey !== 'string' || value.operationKey.length === 0
    || typeof value.kind !== 'string' || !kinds.includes(value.kind as MutationKind)
    || typeof value.fingerprint !== 'string' || !HEX_DIGEST.test(value.fingerprint)
    || typeof value.beforeDigest !== 'string' || !HEX_DIGEST.test(value.beforeDigest)
    || typeof value.afterDigest !== 'string' || !HEX_DIGEST.test(value.afterDigest)
    || !Array.isArray(value.resources) || value.resources.length === 0
    || (value.status !== 'prepared' && value.status !== 'applied')) {
    throw new DurableDataError('invalid curator mutation record', journalPath)
  }
  const resources = value.resources.map(item => {
    if (!isRecord(item) || !hasExactKeys(item, ['path', 'beforeDigest', 'afterDigest'])
      || typeof item.path !== 'string' || item.path.length === 0
      || typeof item.beforeDigest !== 'string' || !HEX_DIGEST.test(item.beforeDigest)
      || typeof item.afterDigest !== 'string' || !HEX_DIGEST.test(item.afterDigest)) {
      throw new DurableDataError('invalid curator mutation resource', journalPath)
    }
    return {
      path: validateJournalKnowledgePath(item.path, journalPath),
      beforeDigest: item.beforeDigest,
      afterDigest: item.afterDigest,
    }
  })
  if (new Set(resources.map(resource => resource.path)).size !== resources.length) {
    throw new DurableDataError('duplicate curator mutation resource path', journalPath)
  }
  if (resourcesDigest(resources, 'beforeDigest') !== value.beforeDigest
    || resourcesDigest(resources, 'afterDigest') !== value.afterDigest) {
    throw new DurableDataError('curator mutation aggregate digest mismatch', journalPath)
  }
  const result = parseMutationResult(value.result, journalPath)
  if ((value.kind === 'split_reference') !== (result.paths !== undefined)) {
    throw new DurableDataError('curator mutation result does not match its operation kind', journalPath)
  }
  const resultPaths = result.paths ?? (result.path === undefined ? [] : [result.path])
  if (resultPaths.some(resultPath => !resources.some(resource => resource.path === resultPath))) {
    throw new DurableDataError('curator mutation result is not represented by its resources', journalPath)
  }
  return {
    operationKey: value.operationKey,
    kind: value.kind as MutationKind,
    fingerprint: value.fingerprint,
    beforeDigest: value.beforeDigest,
    afterDigest: value.afterDigest,
    resources,
    result,
    status: value.status,
  }
}

function parseMutationJournal(value: unknown, journalPath: string, taskId: string): MutationJournal {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'taskId', 'operations'])
    || value.version !== STATE_VERSION || value.taskId !== taskId || !Array.isArray(value.operations)) {
    throw new DurableDataError('invalid curator mutation journal', journalPath)
  }
  const operations = value.operations.map(item => parseMutationRecord(item, journalPath))
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]?.operationKey !== `${taskId}:${index + 1}`) {
      throw new DurableDataError('invalid curator mutation operation sequence', journalPath)
    }
  }
  const prepared = operations.findIndex(operation => operation.status === 'prepared')
  if (prepared >= 0 && prepared !== operations.length - 1) {
    throw new DurableDataError('prepared curator mutation must be the final journal operation', journalPath)
  }
  return { version: STATE_VERSION, taskId, operations }
}

function decodeUtf8(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new CuratorToolError('file is not valid UTF-8', file, { cause: error })
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

function toPosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function isKnowledgeRelative(relativePath: string): boolean {
  return relativePath === KNOWLEDGE || relativePath.startsWith(`${KNOWLEDGE}/`)
}

function isReferenceRelative(relativePath: string): boolean {
  return relativePath === REFERENCES || relativePath.startsWith(`${REFERENCES}/`)
}

function lineChunks(content: string): string[] {
  if (content === '') return []
  return content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(chunk => chunk.length > 0) ?? []
}

function withIncrementedModificationCount(text: string): string {
  let count = 1
  let body = text
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end >= 0) {
      const frontmatter = text.slice(3, end)
      body = text.slice(end + 4)
      const countLine = frontmatter.split(/\r\n|\n|\r/)
        .find(line => line.startsWith('modification_count:'))
      if (countLine !== undefined) {
        const parsed = Number(countLine.split(':', 2)[1]?.trim() ?? '')
        count = Number.isSafeInteger(parsed) ? parsed + 1 : 1
      }
    }
  }
  if (!body.startsWith('\n')) body = `\n${body}`
  return `---\nmodification_count: ${count}\n---${body}`
}

function globRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === undefined) break
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[\\^$.[\]{}()+|]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

function plainName(value: string, label: string): string {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new CuratorToolError(`${label} must be one plain file or directory name`, value)
  }
  return value
}

/**
 * Dedicated knowledge-only tools for a single curator task.
 *
 * There is deliberately no process/shell primitive. All mutating operations
 * validate both the requested path and its canonical ancestry immediately
 * before touching the filesystem.
 */
export class CuratorKnowledgeTools {
  /** DSH-style per-role observed versions used to reject blind/stale rewrites. */
  private readonly observed = new Map<string, string>()
  /** Successful curator mutations whose ordinary-entry metadata is finalized once. */
  private readonly touchedPaths = new Set<string>()
  private metadataFinalized = false
  private operationCursor = 0

  private constructor(
    public readonly workspaceRoot: string,
    public readonly taskKind: CuratorTaskKind,
    public readonly taskId: string,
    private readonly knowledgeRoot: string,
    private readonly referencesRoot: string,
    private readonly journalPath: string,
    private readonly journal: MutationJournal,
  ) {}

  static async create(
    workspaceRoot: string,
    taskKind: CuratorTaskKind,
    taskId = `standalone-${randomUUID()}`,
  ): Promise<CuratorKnowledgeTools> {
    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new TypeError('curator task id must be a non-empty string')
    }
    const root = await canonicalWorkspace(workspaceRoot)
    const knowledgeRoot = path.join(root, KNOWLEDGE)
    const referencesRoot = path.join(root, REFERENCES)
    try {
      const [canonicalKnowledge, canonicalReferences] = await Promise.all([
        realpath(knowledgeRoot),
        realpath(referencesRoot),
      ])
      const [knowledgeInfo, referenceInfo] = await Promise.all([
        stat(canonicalKnowledge),
        stat(canonicalReferences),
      ])
      if (!knowledgeInfo.isDirectory() || !referenceInfo.isDirectory()) {
        throw new CuratorToolError('knowledge and references must be directories')
      }
      if (!isContained(root, canonicalKnowledge) || !isContained(canonicalKnowledge, canonicalReferences)) {
        throw new CuratorToolError('knowledge directory escapes the workspace')
      }
      const mutationDirectory = path.join(root, ...MUTATION_DIRECTORY.split('/'))
      await mkdir(mutationDirectory, { recursive: true, mode: 0o700 })
      const canonicalMutationDirectory = await realpath(mutationDirectory)
      if (canonicalMutationDirectory !== mutationDirectory || !isContained(root, canonicalMutationDirectory)) {
        throw new CuratorToolError('curator mutation directory escapes the workspace', MUTATION_DIRECTORY)
      }
      const journalPath = path.join(canonicalMutationDirectory, `${digestText(taskId)}.json`)
      let journal: MutationJournal
      try {
        const info = await lstat(journalPath)
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new DurableDataError('curator mutation journal must be an ordinary file', journalPath)
        }
        journal = parseMutationJournal(await readJson(journalPath), journalPath, taskId)
      } catch (error) {
        if (!isMissing(error)) throw error
        journal = { version: STATE_VERSION, taskId, operations: [] }
        await atomicWriteJson(journalPath, journal)
      }
      return new CuratorKnowledgeTools(
        root,
        taskKind,
        taskId,
        canonicalKnowledge,
        canonicalReferences,
        journalPath,
        journal,
      )
    } catch (error) {
      if (error instanceof CuratorToolError || error instanceof DurableDataError) throw error
      throw new CuratorToolError('unable to initialize curator knowledge tools', KNOWLEDGE, { cause: error })
    }
  }

  private async nearestExisting(target: string): Promise<string> {
    let cursor = target
    for (;;) {
      try {
        await lstat(cursor)
        return cursor
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw new CuratorToolError('path has no existing ancestor', target)
      cursor = parent
    }
  }

  private async resolve(input: string, mustExist: boolean): Promise<ResolvedKnowledgePath> {
    let relativePath: string
    try {
      relativePath = normalizeRelativePath(input)
    } catch (error) {
      if (error instanceof WorkspaceError) throw new CuratorToolError(error.message, undefined, { cause: error })
      throw error
    }
    if (!isKnowledgeRelative(relativePath)) {
      throw new CuratorToolError('use a workspace-relative path beginning with knowledge/, e.g. knowledge/index.md', input)
    }
    const absolute = path.resolve(this.workspaceRoot, ...relativePath.split('/'))
    if (!isContained(this.knowledgeRoot, absolute)) {
      throw new CuratorToolError('path escapes knowledge/', input)
    }

    let exists = true
    let canonicalAnchor: string
    try {
      canonicalAnchor = await realpath(absolute)
    } catch (error) {
      if (!isMissing(error)) throw new CuratorToolError('unable to resolve path', input, { cause: error })
      exists = false
      if (mustExist) throw new CuratorToolError('path does not exist', input, { cause: error })
      try {
        canonicalAnchor = await realpath(await this.nearestExisting(absolute))
      } catch (ancestorError) {
        if (ancestorError instanceof CuratorToolError) throw ancestorError
        throw new CuratorToolError('unable to validate path ancestry', input, { cause: ancestorError })
      }
    }
    if (!isContained(this.knowledgeRoot, canonicalAnchor)) {
      throw new CuratorToolError('symlink resolves outside knowledge/', input)
    }
    const inReferences = isReferenceRelative(relativePath)
      || isContained(this.referencesRoot, canonicalAnchor)
    return { requested: input, relative: relativePath, absolute, canonicalAnchor, exists, inReferences }
  }

  private async rejectFinalSymlink(target: ResolvedKnowledgePath): Promise<void> {
    if (!target.exists) return
    const info = await lstat(target.absolute)
    if (info.isSymbolicLink()) throw new CuratorToolError('mutating a symbolic link is not allowed', target.requested)
  }

  private rejectReferenceMutation(target: ResolvedKnowledgePath): void {
    if (target.inReferences) {
      throw new CuratorToolError('knowledge/references is read-only except for exact reference splitting', target.requested)
    }
  }

  private rejectProtectedMutation(target: ResolvedKnowledgePath, operation: 'write' | 'destructive'): void {
    const name = path.basename(target.absolute)
    if (name === 'common-errors.md' && operation === 'write'
      && this.taskKind !== 'verifier_final' && this.taskKind !== 'health_check') {
      throw new CuratorToolError('only verifier-final and health-check tasks may update common-errors.md', target.requested)
    }
    if (operation === 'destructive' && PROTECTED_FILE_NAMES.has(name)) {
      throw new CuratorToolError('protected index/common-errors files cannot be renamed, moved, or deleted', target.requested)
    }
  }

  private async requireOrdinaryFile(target: ResolvedKnowledgePath): Promise<void> {
    const info = await lstat(target.absolute)
    if (!info.isFile()) throw new CuratorToolError('path is not an ordinary file', target.requested)
  }

  private requireMarkdown(target: ResolvedKnowledgePath): void {
    if (path.extname(target.absolute).toLowerCase() !== '.md') {
      throw new CuratorToolError('curator text mutations are restricted to Markdown files', target.requested)
    }
  }

  private observe(target: ResolvedKnowledgePath, content: Uint8Array | string): void {
    this.observed.set(target.canonicalAnchor, digestText(content))
  }

  private assertObserved(target: ResolvedKnowledgePath, content: Uint8Array): void {
    const expected = this.observed.get(target.canonicalAnchor)
    if (expected === undefined) {
      throw new CuratorToolError('existing file must be read before it is written or edited', target.requested)
    }
    if (expected !== digestText(content)) {
      throw new CuratorToolError('file changed since it was read; read it again before writing', target.requested)
    }
  }

  private recordTouch(absolutePath: string): void {
    this.touchedPaths.add(path.resolve(absolutePath))
  }

  private persistJournal(): Promise<void> {
    return atomicWriteJson(this.journalPath, this.journal)
  }

  private async stateDigestAbsolute(absolute: string): Promise<string> {
    let info
    try {
      info = await lstat(absolute)
    } catch (error) {
      if (isMissing(error)) return missingDigest()
      throw error
    }
    if (info.isFile()) return expectedFileDigest(await readFile(absolute))
    // A directory mutation concerns the directory node, not all descendants:
    // later journaled child-file operations may legitimately change its tree.
    if (info.isDirectory()) return emptyDirectoryDigest()
    if (info.isSymbolicLink()) return digestText(JSON.stringify(['symlink', await readlink(absolute)]))
    return digestText(JSON.stringify(['other', info.mode, info.size]))
  }

  private async stateDigest(relativePath: string): Promise<string> {
    const normalized = normalizeRelativePath(relativePath)
    const absolute = path.resolve(this.workspaceRoot, ...normalized.split('/'))
    if (!isContained(this.workspaceRoot, absolute)) {
      throw new CuratorToolError('mutation journal path escapes the workspace', relativePath)
    }
    // Re-run the same canonical ancestry validation used by every public tool
    // before a durable replay is allowed to inspect any journal resource.
    const resolved = await this.resolve(normalized, false)
    return this.stateDigestAbsolute(resolved.absolute)
  }

  private beginMutation(kind: MutationKind, args: unknown): MutationTicket {
    const index = this.operationCursor
    if (this.journal.operations.slice(0, index).some(operation => operation.status === 'prepared')) {
      throw new CuratorToolError('a previous curator mutation remains unresolved', this.taskId)
    }
    const operationKey = `${this.taskId}:${index + 1}`
    const fingerprint = digestText(JSON.stringify({ kind, args }))
    const existing = this.journal.operations[index]
    if (existing !== undefined && (existing.operationKey !== operationKey
      || existing.kind !== kind || existing.fingerprint !== fingerprint)) {
      throw new CuratorToolError('curator mutation replay diverged from the durable operation', operationKey)
    }
    if (existing !== undefined) this.operationCursor += 1
    return {
      index,
      operationKey,
      kind,
      fingerprint,
      ...(existing === undefined ? {} : { existing }),
    }
  }

  private async currentDigest(resources: readonly MutationResource[]): Promise<string> {
    const current = await Promise.all(resources.map(async resource => ({
      ...resource,
      currentDigest: await this.stateDigest(resource.path),
    })))
    return digestText(JSON.stringify(current.map(resource => [resource.path, resource.currentDigest])))
  }

  private async validateAppliedReplay(index: number, record: MutationRecord): Promise<void> {
    for (const resource of record.resources) {
      const current = await this.stateDigest(resource.path)
      if (current === resource.afterDigest) continue
      let latest: { readonly record: MutationRecord; readonly resource: MutationResource } | undefined
      for (let laterIndex = index + 1; laterIndex < this.journal.operations.length; laterIndex += 1) {
        const laterRecord = this.journal.operations[laterIndex]
        const laterResource = laterRecord?.resources.find(item => item.path === resource.path)
        if (laterRecord !== undefined && laterResource !== undefined) {
          latest = { record: laterRecord, resource: laterResource }
        }
      }
      const represented = latest !== undefined && (latest.record.status === 'applied'
        ? current === latest.resource.afterDigest
        : current === latest.resource.beforeDigest || current === latest.resource.afterDigest)
      if (!represented) {
        throw new CuratorToolError('curator mutation replay conflicts with the current file state', record.operationKey)
      }
    }
  }

  private async resumeMutation<T extends MutationResult>(
    ticket: MutationTicket,
    apply: () => Promise<void>,
    onSuccess: () => void | Promise<void> = () => undefined,
  ): Promise<{ readonly handled: false } | { readonly handled: true; readonly result: T }> {
    const record = ticket.existing
    if (record === undefined) return { handled: false }
    if (record.status === 'applied') {
      await this.validateAppliedReplay(ticket.index, record)
      await onSuccess()
      return { handled: true, result: record.result as T }
    }
    const current = await this.currentDigest(record.resources)
    if (current === record.afterDigest) {
      record.status = 'applied'
      await this.persistJournal()
      await onSuccess()
      return { handled: true, result: record.result as T }
    }
    if (current !== record.beforeDigest) {
      throw new CuratorToolError('curator mutation replay conflicts with the current file state', record.operationKey)
    }
    await apply()
    if (await this.currentDigest(record.resources) !== record.afterDigest) {
      throw new CuratorToolError('curator mutation did not produce its durable after state', record.operationKey)
    }
    record.status = 'applied'
    await this.persistJournal()
    await onSuccess()
    return { handled: true, result: record.result as T }
  }

  private async prepareMutation<T extends MutationResult>(
    ticket: MutationTicket,
    resources: readonly MutationResource[],
    result: T,
    apply: () => Promise<void>,
    onSuccess: () => void | Promise<void> = () => undefined,
  ): Promise<T> {
    if (ticket.existing !== undefined || ticket.index !== this.journal.operations.length) {
      throw new CuratorToolError('curator mutation journal sequence is inconsistent', ticket.operationKey)
    }
    const record: MutationRecord = {
      operationKey: ticket.operationKey,
      kind: ticket.kind,
      fingerprint: ticket.fingerprint,
      beforeDigest: resourcesDigest(resources, 'beforeDigest'),
      afterDigest: resourcesDigest(resources, 'afterDigest'),
      resources: resources.map(resource => ({ ...resource })),
      result,
      status: 'prepared',
    }
    this.journal.operations.push(record)
    this.operationCursor += 1
    await this.persistJournal()
    await apply()
    if (await this.currentDigest(resources) !== record.afterDigest) {
      throw new CuratorToolError('curator mutation did not produce its durable after state', ticket.operationKey)
    }
    record.status = 'applied'
    await this.persistJournal()
    await onSuccess()
    return result
  }

  private async observeMutationFile(relativePath: string, touch: boolean): Promise<void> {
    const target = await this.resolve(relativePath, false)
    if (touch) this.recordTouch(target.absolute)
    if (!target.exists || !(await lstat(target.absolute)).isFile()) return
    const bytes = await readFile(target.absolute)
    this.observe(target, bytes)
  }

  /**
   * Apply AlphaSolve main's system-owned modification counter after one
   * curator task succeeds. Human references and routing/protected files keep
   * their exact text and never receive this frontmatter.
   */
  async finalizeMetadata(): Promise<void> {
    if (this.metadataFinalized) return
    for (const touched of [...this.touchedPaths].sort()) {
      let canonical: string
      let info
      try {
        canonical = await realpath(touched)
        info = await lstat(touched)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      if (info.isSymbolicLink() || !info.isFile()
        || path.extname(canonical).toLowerCase() !== '.md'
        || PROTECTED_FILE_NAMES.has(path.basename(canonical))
        || !isContained(this.knowledgeRoot, canonical)
        || isContained(this.referencesRoot, canonical)) {
        continue
      }
      const relative = toPosix(this.workspaceRoot, canonical)
      const ticket = this.beginMutation('finalize_metadata', { path: relative })
      const apply = async (): Promise<void> => {
        const current = await this.resolve(relative, true)
        await this.requireOrdinaryFile(current)
        const text = decodeUtf8(await readFile(current.absolute), relative)
        await atomicWriteText(current.absolute, withIncrementedModificationCount(text))
      }
      const resumed = await this.resumeMutation<{ readonly path: string }>(
        ticket,
        apply,
        () => this.observeMutationFile(relative, false),
      )
      if (resumed.handled) continue
      const text = decodeUtf8(await readFile(canonical), relative)
      const next = withIncrementedModificationCount(text)
      await this.prepareMutation(
        ticket,
        [{ path: relative, beforeDigest: expectedFileDigest(text), afterDigest: expectedFileDigest(next) }],
        { path: relative },
        apply,
        () => this.observeMutationFile(relative, false),
      )
    }
    if (this.journal.operations.some(operation => operation.status === 'prepared')) {
      throw new CuratorToolError('a curator mutation remains unresolved', this.taskId)
    }
    if (this.operationCursor !== this.journal.operations.length) {
      throw new CuratorToolError('curator mutation replay ended before all durable operations were replayed', this.taskId)
    }
    this.metadataFinalized = true
  }

  private async ensureDirectory(relativePath: string): Promise<ResolvedKnowledgePath> {
    const normalized = normalizeRelativePath(relativePath)
    if (!isKnowledgeRelative(normalized)) throw new CuratorToolError('directory is outside knowledge/', relativePath)
    const components = normalized.split('/')
    let current = components[0]
    if (current === undefined) throw new CuratorToolError('invalid directory path', relativePath)
    let resolved = await this.resolve(current, true)
    for (const component of components.slice(1)) {
      current = `${current}/${component}`
      resolved = await this.resolve(current, false)
      this.rejectReferenceMutation(resolved)
      if (resolved.exists) {
        if (!(await stat(resolved.absolute)).isDirectory()) {
          throw new CuratorToolError('path component is not a directory', current)
        }
        continue
      }
      try {
        await mkdir(resolved.absolute, { mode: 0o700 })
      } catch (error) {
        if (!isConflict(error)) throw error
      }
      resolved = await this.resolve(current, true)
      if (!(await stat(resolved.absolute)).isDirectory()) {
        throw new CuratorToolError('path component is not a directory', current)
      }
    }
    return resolved
  }

  /** Read inclusive one-based lines, capping endLine at the file's final line. */
  async read(
    relativePath: string,
    options: { readonly startLine?: number; readonly endLine?: number } = {},
  ): Promise<CuratorReadResult> {
    const target = await this.resolve(relativePath, true)
    await this.requireOrdinaryFile(target)
    const bytes = await readFile(target.absolute)
    const content = decodeUtf8(bytes, relativePath)
    this.observe(target, bytes)
    const lines = lineChunks(content)
    if (lines.length === 0 && options.startLine === undefined && options.endLine === undefined) {
      return { path: target.relative, content: '', startLine: 0, endLine: 0, totalLines: 0 }
    }
    const startLine = options.startLine ?? 1
    const requestedEndLine = options.endLine ?? lines.length
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(requestedEndLine)
      || startLine < 1 || startLine > lines.length || requestedEndLine < startLine) {
      throw new CuratorToolError(`invalid inclusive line range; file has ${lines.length} lines, startLine must select an existing line, and endLine must be at least startLine`, relativePath)
    }
    const endLine = Math.min(requestedEndLine, lines.length)
    return {
      path: target.relative,
      content: lines.slice(startLine - 1, endLine).join(''),
      startLine,
      endLine,
      totalLines: lines.length,
    }
  }

  async write(
    relativePath: string,
    content: string,
    options: { readonly mode?: 'overwrite' | 'append' } = {},
  ): Promise<{ readonly path: string }> {
    let target = await this.resolve(relativePath, false)
    this.rejectReferenceMutation(target)
    this.rejectProtectedMutation(target, 'write')
    this.requireMarkdown(target)
    await this.rejectFinalSymlink(target)
    const mode = options.mode ?? 'overwrite'
    if (mode !== 'overwrite' && mode !== 'append') throw new CuratorToolError('invalid write mode', relativePath)
    const ticket = this.beginMutation('write', { path: target.relative, content, mode })
    const apply = async (): Promise<void> => {
      let current = await this.resolve(relativePath, false)
      this.rejectReferenceMutation(current)
      this.rejectProtectedMutation(current, 'write')
      this.requireMarkdown(current)
      await this.rejectFinalSymlink(current)
      if (!current.exists) {
        await this.ensureDirectory(toPosix(this.workspaceRoot, path.dirname(current.absolute)))
        current = await this.resolve(relativePath, false)
        if (current.exists) throw new CuratorToolError('target appeared before creation', relativePath)
        const handle = await open(current.absolute, 'wx', 0o600)
        try {
          await handle.writeFile(content, 'utf8')
        } finally {
          await handle.close()
        }
        return
      }
      await this.requireOrdinaryFile(current)
      const currentBytes = await readFile(current.absolute)
      const nextContent = mode === 'append'
        ? `${decodeUtf8(currentBytes, relativePath)}${content}`
        : content
      await atomicWriteText(current.absolute, nextContent)
    }
    const resumed = await this.resumeMutation<{ readonly path: string }>(
      ticket,
      apply,
      () => this.observeMutationFile(target.relative, true),
    )
    if (resumed.handled) return resumed.result
    let next = content
    let beforeDigest = missingDigest()
    if (!target.exists) {
      // Creation needs no read observation, but its missing state is journaled
      // before any parent directories or file bytes are changed.
    } else {
      await this.requireOrdinaryFile(target)
      const currentBytes = await readFile(target.absolute)
      this.assertObserved(target, currentBytes)
      beforeDigest = expectedFileDigest(currentBytes)
      if (mode === 'append') next = `${decodeUtf8(currentBytes, relativePath)}${content}`
    }
    return this.prepareMutation(
      ticket,
      [{ path: target.relative, beforeDigest, afterDigest: expectedFileDigest(next) }],
      { path: target.relative },
      apply,
      () => this.observeMutationFile(target.relative, true),
    )
  }

  async edit(relativePath: string, oldText: string, newText: string): Promise<{ readonly path: string }> {
    if (oldText.length === 0) throw new CuratorToolError('edit match must not be empty', relativePath)
    if (oldText === newText) throw new CuratorToolError('edit replacement must differ from its match', relativePath)
    const target = await this.resolve(relativePath, true)
    this.rejectReferenceMutation(target)
    this.rejectProtectedMutation(target, 'write')
    this.requireMarkdown(target)
    await this.rejectFinalSymlink(target)
    await this.requireOrdinaryFile(target)
    const ticket = this.beginMutation('edit', {
      path: target.relative,
      oldText,
      newText,
    })
    const apply = async (): Promise<void> => {
      const current = await this.resolve(relativePath, true)
      this.rejectReferenceMutation(current)
      this.rejectProtectedMutation(current, 'write')
      this.requireMarkdown(current)
      await this.rejectFinalSymlink(current)
      await this.requireOrdinaryFile(current)
      const currentText = decodeUtf8(await readFile(current.absolute), relativePath)
      const match = currentText.indexOf(oldText)
      if (match < 0) throw new CuratorToolError('edit match was not found', relativePath)
      if (currentText.indexOf(oldText, match + oldText.length) >= 0) {
        throw new CuratorToolError('edit match is not unique', relativePath)
      }
      await atomicWriteText(
        current.absolute,
        `${currentText.slice(0, match)}${newText}${currentText.slice(match + oldText.length)}`,
      )
    }
    const resumed = await this.resumeMutation<{ readonly path: string }>(
      ticket,
      apply,
      () => this.observeMutationFile(target.relative, true),
    )
    if (resumed.handled) return resumed.result
    const currentBytes = await readFile(target.absolute)
    this.assertObserved(target, currentBytes)
    const content = decodeUtf8(currentBytes, relativePath)
    const first = content.indexOf(oldText)
    if (first < 0) throw new CuratorToolError('edit match was not found', relativePath)
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new CuratorToolError('edit match is not unique', relativePath)
    }
    const next = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`
    return this.prepareMutation(
      ticket,
      [{
        path: target.relative,
        beforeDigest: expectedFileDigest(currentBytes),
        afterDigest: expectedFileDigest(next),
      }],
      { path: target.relative },
      apply,
      () => this.observeMutationFile(target.relative, true),
    )
  }

  async mkdir(relativePath: string): Promise<{ readonly path: string }> {
    const target = await this.resolve(relativePath, false)
    if (target.relative === KNOWLEDGE) throw new CuratorToolError('knowledge directory already exists', relativePath)
    this.rejectReferenceMutation(target)
    if (target.exists && !(await stat(target.absolute)).isDirectory()) {
      throw new CuratorToolError('path component is not a directory', relativePath)
    }
    const ticket = this.beginMutation('mkdir', { path: target.relative })
    const apply = async (): Promise<void> => { await this.ensureDirectory(target.relative) }
    const resumed = await this.resumeMutation<{ readonly path: string }>(ticket, apply)
    if (resumed.handled) return resumed.result
    const beforeDigest = target.exists ? await this.stateDigest(target.relative) : missingDigest()
    return this.prepareMutation(
      ticket,
      [{
        path: target.relative,
        beforeDigest,
        afterDigest: target.exists ? beforeDigest : emptyDirectoryDigest(),
      }],
      { path: target.relative },
      apply,
    )
  }

  async rename(directory: string, oldName: string, newName: string): Promise<{ readonly path: string }> {
    const oldPlain = plainName(oldName, 'oldName')
    const newPlain = plainName(newName, 'newName')
    if (PROTECTED_FILE_NAMES.has(oldPlain) || PROTECTED_FILE_NAMES.has(newPlain)) {
      throw new CuratorToolError('protected index/common-errors files cannot be renamed, moved, or deleted')
    }
    const source = await this.resolve(`${normalizeRelativePath(directory)}/${oldPlain}`, false)
    const target = await this.resolve(`${normalizeRelativePath(directory)}/${newPlain}`, false)
    this.rejectReferenceMutation(source)
    this.rejectReferenceMutation(target)
    this.rejectProtectedMutation(source, 'destructive')
    this.rejectProtectedMutation(target, 'destructive')
    await this.rejectFinalSymlink(source)
    const ticket = this.beginMutation('rename', {
      directory: normalizeRelativePath(directory),
      oldName: oldPlain,
      newName: newPlain,
    })
    const apply = async (): Promise<void> => {
      const currentSource = await this.resolve(source.relative, true)
      const currentTarget = await this.resolve(target.relative, false)
      this.rejectReferenceMutation(currentSource)
      this.rejectReferenceMutation(currentTarget)
      this.rejectProtectedMutation(currentSource, 'destructive')
      this.rejectProtectedMutation(currentTarget, 'destructive')
      await this.rejectFinalSymlink(currentSource)
      if (currentTarget.exists) throw new CuratorToolError('target already exists', currentTarget.relative)
      try {
        await renameFile(currentSource.absolute, currentTarget.absolute)
      } catch (error) {
        if (isConflict(error)) throw new CuratorToolError('target already exists', currentTarget.relative, { cause: error })
        throw error
      }
    }
    const resumed = await this.resumeMutation<{ readonly path: string }>(
      ticket,
      apply,
      () => this.recordTouch(target.absolute),
    )
    if (resumed.handled) return resumed.result
    if (!source.exists) throw new CuratorToolError('path does not exist', source.relative)
    if (target.exists) throw new CuratorToolError('target already exists', target.relative)
    const sourceDigest = await this.stateDigest(source.relative)
    return this.prepareMutation(
      ticket,
      [
        { path: source.relative, beforeDigest: sourceDigest, afterDigest: missingDigest() },
        { path: target.relative, beforeDigest: missingDigest(), afterDigest: sourceDigest },
      ],
      { path: target.relative },
      apply,
      () => this.recordTouch(target.absolute),
    )
  }

  async move(relativePath: string, destinationDirectory: string): Promise<{ readonly path: string }> {
    const source = await this.resolve(relativePath, false)
    const destination = await this.resolve(destinationDirectory, true)
    this.rejectReferenceMutation(source)
    this.rejectReferenceMutation(destination)
    this.rejectProtectedMutation(source, 'destructive')
    await this.rejectFinalSymlink(source)
    if (!(await stat(destination.absolute)).isDirectory()) {
      throw new CuratorToolError('move destination is not a directory', destinationDirectory)
    }
    const target = await this.resolve(`${destination.relative}/${path.basename(source.absolute)}`, false)
    this.rejectReferenceMutation(target)
    this.rejectProtectedMutation(target, 'destructive')
    const ticket = this.beginMutation('move', {
      path: source.relative,
      destinationDirectory: destination.relative,
    })
    const apply = async (): Promise<void> => {
      const currentSource = await this.resolve(source.relative, true)
      const currentDestination = await this.resolve(destination.relative, true)
      this.rejectReferenceMutation(currentSource)
      this.rejectReferenceMutation(currentDestination)
      this.rejectProtectedMutation(currentSource, 'destructive')
      await this.rejectFinalSymlink(currentSource)
      await this.requireOrdinaryFile(currentSource)
      if (!(await stat(currentDestination.absolute)).isDirectory()) {
        throw new CuratorToolError('move destination is not a directory', destinationDirectory)
      }
      const currentTarget = await this.resolve(
        `${currentDestination.relative}/${path.basename(currentSource.absolute)}`,
        false,
      )
      this.rejectReferenceMutation(currentTarget)
      this.rejectProtectedMutation(currentTarget, 'destructive')
      if (currentTarget.exists) throw new CuratorToolError('target already exists', currentTarget.relative)
      try {
        await renameFile(currentSource.absolute, currentTarget.absolute)
      } catch (error) {
        if (isConflict(error)) throw new CuratorToolError('target already exists', currentTarget.relative, { cause: error })
        throw error
      }
    }
    const resumed = await this.resumeMutation<{ readonly path: string }>(
      ticket,
      apply,
      () => this.recordTouch(target.absolute),
    )
    if (resumed.handled) return resumed.result
    if (!source.exists) throw new CuratorToolError('path does not exist', source.relative)
    await this.requireOrdinaryFile(source)
    if (target.exists) throw new CuratorToolError('target already exists', target.relative)
    const sourceDigest = await this.stateDigest(source.relative)
    return this.prepareMutation(
      ticket,
      [
        { path: source.relative, beforeDigest: sourceDigest, afterDigest: missingDigest() },
        { path: target.relative, beforeDigest: missingDigest(), afterDigest: sourceDigest },
      ],
      { path: target.relative },
      apply,
      () => this.recordTouch(target.absolute),
    )
  }

  async splitReference(sourcePath: string, parts: readonly ReferencePart[]): Promise<{ readonly paths: readonly string[] }> {
    if (parts.length === 0) throw new CuratorToolError('at least one reference part is required', sourcePath)
    const source = await this.resolve(sourcePath, true)
    if (!source.inReferences) throw new CuratorToolError('reference source must be below knowledge/references', sourcePath)
    if (path.extname(source.absolute).toLowerCase() !== '.md') {
      throw new CuratorToolError('reference source must be Markdown', sourcePath)
    }
    await this.requireOrdinaryFile(source)
    const content = decodeUtf8(await readFile(source.absolute), sourcePath)
    const lines = lineChunks(content)
    const targets: ResolvedKnowledgePath[] = []
    const partContents: string[] = []
    const seen = new Set<string>()

    for (const part of parts) {
      if (!Number.isSafeInteger(part.startLine) || !Number.isSafeInteger(part.endLine)
        || part.startLine < 1 || part.endLine < part.startLine || part.endLine > lines.length) {
        throw new CuratorToolError('invalid inclusive reference split range', part.path)
      }
      const target = await this.resolve(part.path, false)
      if (!target.inReferences) throw new CuratorToolError('reference split target must stay below knowledge/references', part.path)
      if (path.extname(target.absolute).toLowerCase() !== '.md') {
        throw new CuratorToolError('reference split target must be Markdown', part.path)
      }
      if (path.basename(target.absolute) === 'index.md') {
        throw new CuratorToolError('reference split cannot create a protected index.md', part.path)
      }
      if (seen.has(target.absolute)) throw new CuratorToolError('reference split target already exists', part.path)
      const parent = await this.resolve(toPosix(this.workspaceRoot, path.dirname(target.absolute)), true)
      if (!parent.inReferences || !(await stat(parent.absolute)).isDirectory()) {
        throw new CuratorToolError('reference split target parent must be an existing reference directory', part.path)
      }
      seen.add(target.absolute)
      targets.push(target)
      partContents.push(lines.slice(part.startLine - 1, part.endLine).join(''))
    }

    const ticket = this.beginMutation('split_reference', {
      sourcePath: source.relative,
      parts: parts.map(part => ({ ...part })),
    })
    const apply = async (): Promise<void> => {
      const created: string[] = []
      try {
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index]
          const partContent = partContents[index]
          if (target === undefined || partContent === undefined) throw new Error('reference split validation mismatch')
          const current = await this.resolve(target.relative, false)
          if (!current.inReferences) {
            throw new CuratorToolError('reference split target must stay below knowledge/references', current.relative)
          }
          if (current.exists) throw new CuratorToolError('reference split target already exists', current.relative)
          const handle = await open(current.absolute, 'wx', 0o600)
          try {
            await handle.writeFile(partContent, 'utf8')
          } finally {
            await handle.close()
          }
          created.push(current.absolute)
        }
      } catch (error) {
        await Promise.all(created.map(async createdPath => {
          try { await unlink(createdPath) } catch { /* best-effort rollback */ }
        }))
        if (isConflict(error)) throw new CuratorToolError('reference split target already exists', sourcePath, { cause: error })
        throw error
      }
    }
    const onSuccess = (): void => {
      for (const target of targets) this.recordTouch(target.absolute)
    }
    const resumed = await this.resumeMutation<{ readonly paths: readonly string[] }>(ticket, apply, onSuccess)
    if (resumed.handled) return resumed.result
    for (const target of targets) {
      if (target.exists) throw new CuratorToolError('reference split target already exists', target.relative)
    }
    const sourceDigest = await this.stateDigest(source.relative)
    return this.prepareMutation(
      ticket,
      [
        { path: source.relative, beforeDigest: sourceDigest, afterDigest: sourceDigest },
        ...targets.map((target, index) => ({
          path: target.relative,
          beforeDigest: missingDigest(),
          afterDigest: expectedFileDigest(partContents[index] ?? ''),
        })),
      ],
      { paths: targets.map(target => target.relative) },
      apply,
      onSuccess,
    )
  }

  async delete(relativePath: string): Promise<{ readonly path: string }> {
    const target = await this.resolve(relativePath, false)
    if (target.relative === KNOWLEDGE) throw new CuratorToolError('knowledge root cannot be deleted', relativePath)
    this.rejectReferenceMutation(target)
    this.rejectProtectedMutation(target, 'destructive')
    await this.rejectFinalSymlink(target)
    const ticket = this.beginMutation('delete', { path: target.relative })
    const apply = async (): Promise<void> => {
      const current = await this.resolve(target.relative, true)
      this.rejectReferenceMutation(current)
      this.rejectProtectedMutation(current, 'destructive')
      await this.rejectFinalSymlink(current)
      const info = await lstat(current.absolute)
      if (info.isDirectory()) {
        try {
          await rmdir(current.absolute)
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOTEMPTY') {
            throw new CuratorToolError('directory must be empty before deletion', relativePath, { cause: error })
          }
          throw error
        }
      } else if (info.isFile()) {
        await unlink(current.absolute)
      } else {
        throw new CuratorToolError('only ordinary files and empty directories may be deleted', relativePath)
      }
    }
    const resumed = await this.resumeMutation<{ readonly path: string }>(ticket, apply)
    if (resumed.handled) return resumed.result
    if (!target.exists) throw new CuratorToolError('path does not exist', relativePath)
    const info = await lstat(target.absolute)
    if (!info.isFile() && !info.isDirectory()) {
      throw new CuratorToolError('only ordinary files and empty directories may be deleted', relativePath)
    }
    if (info.isDirectory() && (await readdir(target.absolute)).length > 0) {
      throw new CuratorToolError('directory must be empty before deletion', relativePath)
    }
    return this.prepareMutation(
      ticket,
      [{
        path: target.relative,
        beforeDigest: await this.stateDigest(target.relative),
        afterDigest: missingDigest(),
      }],
      { path: target.relative },
      apply,
    )
  }

  /** List immediate entries; an omitted path or dot selects knowledge/. */
  async list(relativePath = KNOWLEDGE): Promise<readonly CuratorDirectoryEntry[]> {
    const target = await this.resolve(knowledgeDiscoveryRoot(relativePath), true)
    if (!(await stat(target.absolute)).isDirectory()) throw new CuratorToolError('path is not a directory', relativePath)
    const entries = await readdir(target.absolute, { withFileTypes: true })
    return entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => ({
        path: `${target.relative}/${entry.name}`,
        type: entry.isFile() ? 'file'
          : entry.isDirectory() ? 'directory'
            : entry.isSymbolicLink() ? 'symlink' : 'other',
      }))
  }

  private async walk(relativePath = KNOWLEDGE): Promise<readonly string[]> {
    const found: string[] = []
    const pending = [relativePath]
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) break
      for (const entry of await this.list(current)) {
        if (entry.type === 'directory') pending.push(entry.path)
        else if (entry.type === 'file') found.push(entry.path)
      }
    }
    return found.sort()
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const normalized = normalizeRelativePath(pattern)
    if (!isKnowledgeRelative(normalized)) throw new CuratorToolError('use a workspace-relative glob beginning with knowledge/, e.g. knowledge/**/*.md', pattern)
    const matcher = globRegex(normalized)
    return (await this.walk()).filter(file => matcher.test(file))
  }

  async grep(
    query: string,
    options: { readonly path?: string; readonly caseSensitive?: boolean; readonly maxResults?: number } = {},
  ): Promise<readonly CuratorGrepMatch[]> {
    if (query.length === 0) throw new CuratorToolError('grep query must not be empty')
    const root = knowledgeDiscoveryRoot(options.path ?? KNOWLEDGE)
    const target = await this.resolve(root, true)
    const files = (await stat(target.absolute)).isFile() ? [target.relative] : await this.walk(target.relative)
    const needle = options.caseSensitive === false ? query.toLocaleLowerCase() : query
    const maxResults = options.maxResults ?? 200
    if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new CuratorToolError('maxResults must be a positive integer')
    const matches: CuratorGrepMatch[] = []
    for (const file of files) {
      const content = decodeUtf8(await readFile((await this.resolve(file, true)).absolute), file)
      const lines = content.split(/\r\n|\n|\r/)
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]
        if (text === undefined) continue
        const haystack = options.caseSensitive === false ? text.toLocaleLowerCase() : text
        if (haystack.includes(needle)) matches.push({ path: file, line: index + 1, text })
        if (matches.length >= maxResults) return matches
      }
    }
    return matches
  }
}

export async function createCuratorKnowledgeTools(
  workspaceRoot: string,
  taskKind: CuratorTaskKind,
  taskId?: string,
): Promise<CuratorKnowledgeTools> {
  return CuratorKnowledgeTools.create(workspaceRoot, taskKind, taskId)
}
