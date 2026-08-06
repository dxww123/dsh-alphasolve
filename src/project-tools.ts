/** Safe project-organization tools temporarily exposed to the AlphaSolve orchestrator. */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename as renamePath,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { atomicWriteText } from './atomic.js'
import {
  canonicalWorkspace,
  isContained,
  normalizeRelativePath,
  WorkspaceError,
} from './workspace.js'

const KNOWLEDGE = 'knowledge'
const REFERENCES = 'knowledge/references'
const VERIFIED = 'verified_propositions'
const PROTECTED_NAMES = new Set(['index.md'])

const PATH_SEGMENT = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*`
export const VERIFIED_DIRECTORY_PATH_PATTERN = String.raw`^verified_propositions(?:/${PATH_SEGMENT})*/?$`
export const VERIFIED_SUBDIRECTORY_PATH_PATTERN = String.raw`^verified_propositions(?:/${PATH_SEGMENT})+/?$`
export const VERIFIED_MARKDOWN_PATH_PATTERN = String.raw`^verified_propositions/(?!index\.md$)(?!.*\/index\.md$)(?:${PATH_SEGMENT}/)*${PATH_SEGMENT}\.md$`
export const VERIFIED_RENAME_NAME_PATTERN = String.raw`^(?!index\.md$)${PATH_SEGMENT}$`

export const PROJECT_TOOL_NAMES = Object.freeze({
  mkdir: 'alphasolve_mkdir',
  rename: 'alphasolve_rename',
  move: 'alphasolve_move',
} as const)

export interface ProjectMoveResult {
  readonly oldPath: string
  readonly path: string
  /** Number of Markdown files whose proposition references changed. */
  readonly updatedReferenceFiles: number
}

export interface ProjectToolsOptions {
  /** Injection seam for transactional failure tests and host-owned atomic IO. */
  readonly writeText?: (absolutePath: string, content: string) => Promise<void>
}

type ProjectScope = 'knowledge' | 'verified_propositions'

interface ResolvedProjectPath {
  readonly requested: string
  readonly relative: string
  readonly absolute: string
  readonly scope: ProjectScope
  readonly scopeRoot: string
  readonly exists: boolean
  readonly canonicalAnchor: string
  readonly inReferences: boolean
}

interface MarkdownSnapshot {
  readonly absolute: string
  readonly relative: string
  readonly content: string
}

interface MarkdownUpdate extends MarkdownSnapshot {
  readonly afterAbsolute: string
  readonly nextContent: string
}

/** A project-tool rejection whose message is safe to return to the orchestrator. */
export class ProjectToolError extends Error {
  constructor(message: string, public readonly path?: string, options?: ErrorOptions) {
    super(path === undefined ? message : `${message}: ${path}`, options)
    this.name = 'ProjectToolError'
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

function decodeUtf8(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new ProjectToolError('verified Markdown is not valid UTF-8', file, { cause: error })
  }
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function scopeOf(relativePath: string): ProjectScope | undefined {
  if (relativePath === KNOWLEDGE || relativePath.startsWith(`${KNOWLEDGE}/`)) return 'knowledge'
  if (relativePath === VERIFIED || relativePath.startsWith(`${VERIFIED}/`)) return 'verified_propositions'
  return undefined
}

function protectedName(relativePath: string): boolean {
  return PROTECTED_NAMES.has(path.posix.basename(relativePath))
}

function plainName(value: string, label: string): string {
  if (value.length === 0 || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new ProjectToolError(`${label} must be one plain name`, value)
  }
  if (!new RegExp(VERIFIED_RENAME_NAME_PATTERN).test(value)) {
    throw new ProjectToolError(`${label} is invalid or names protected index.md`, value)
  }
  return value
}

function withoutOptionalTrailingSlash(value: string): string {
  if (!value.endsWith('/') && !value.endsWith('\\')) return value
  return value.slice(0, -1)
}

function normalizedMatchingPath(value: string, pattern: string, label: string): string {
  const candidate = withoutOptionalTrailingSlash(value)
  const normalized = normalizeRelativePath(candidate)
  if (!new RegExp(pattern).test(normalized)) {
    throw new ProjectToolError(`${label} must stay inside verified_propositions and use AlphaSolve path names`, value)
  }
  return normalized
}

function mapMovedPath(source: string, target: string, candidate: string): string {
  if (candidate === source) return target
  if (!isContained(source, candidate)) return candidate
  return path.join(target, path.relative(source, candidate))
}

function refLabel(relativePath: string): string | undefined {
  const prefix = `${VERIFIED}/`
  if (!relativePath.startsWith(prefix) || !relativePath.toLowerCase().endsWith('.md')) return undefined
  return relativePath.slice(prefix.length, -3)
}

function rewriteReferences(
  content: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let next = content
  for (const [oldLabel, newReference] of [...replacements.entries()]
    .sort((left, right) => right[0].length - left[0].length)) {
    next = next.replaceAll(`\\ref{${oldLabel}}`, newReference)
  }
  return next
}

/**
 * Orchestrator-only organization operations.
 *
 * The class intentionally has no general write/delete-file primitive. A
 * caller can organize existing research, but cannot promote a knowledge note
 * into verified_propositions or fabricate a new verified proposition.
 */
export class AlphaSolveProjectTools {
  private constructor(
    public readonly workspaceRoot: string,
    private readonly knowledgeRoot: string,
    private readonly referencesRoot: string,
    private readonly verifiedRoot: string,
    private readonly writeText: (absolutePath: string, content: string) => Promise<void>,
  ) {}

  static async create(
    workspaceRoot: string,
    options: ProjectToolsOptions = {},
  ): Promise<AlphaSolveProjectTools> {
    const root = await canonicalWorkspace(workspaceRoot)
    const knowledgePath = path.join(root, KNOWLEDGE)
    const referencesPath = path.join(root, REFERENCES)
    const verifiedPath = path.join(root, VERIFIED)
    try {
      const rootInfos = await Promise.all([
        lstat(knowledgePath),
        lstat(referencesPath),
        lstat(verifiedPath),
      ])
      if (rootInfos.some(info => !info.isDirectory() || info.isSymbolicLink())) {
        throw new ProjectToolError('project tool roots must be ordinary directories')
      }
      const [knowledgeRoot, referencesRoot, verifiedRoot] = await Promise.all([
        realpath(knowledgePath),
        realpath(referencesPath),
        realpath(verifiedPath),
      ])
      if (!isContained(root, knowledgeRoot)
        || !isContained(knowledgeRoot, referencesRoot)
        || !isContained(root, verifiedRoot)) {
        throw new ProjectToolError('project tool root escapes the workspace')
      }
      return new AlphaSolveProjectTools(
        root,
        knowledgeRoot,
        referencesRoot,
        verifiedRoot,
        options.writeText ?? atomicWriteText,
      )
    } catch (error) {
      if (error instanceof ProjectToolError) throw error
      throw new ProjectToolError('unable to initialize AlphaSolve project tools', undefined, { cause: error })
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
      if (parent === cursor) throw new ProjectToolError('path has no existing ancestor', target)
      cursor = parent
    }
  }

  /** Reject every symlink component; this closes both escape and alias races. */
  private async assertNoSymlinkComponents(scopeRoot: string, target: string): Promise<void> {
    const relative = path.relative(scopeRoot, target)
    if (relative === '') return
    let cursor = scopeRoot
    for (const component of relative.split(path.sep)) {
      cursor = path.join(cursor, component)
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) throw new ProjectToolError('symbolic links are not allowed in project mutations', toRelative(this.workspaceRoot, cursor))
      } catch (error) {
        if (isMissing(error)) return
        throw error
      }
    }
  }

  private async resolve(input: string, mustExist: boolean): Promise<ResolvedProjectPath> {
    let relativePath: string
    try {
      relativePath = normalizeRelativePath(input)
    } catch (error) {
      if (error instanceof WorkspaceError) throw new ProjectToolError(error.message, undefined, { cause: error })
      throw error
    }
    const scope = scopeOf(relativePath)
    if (scope === undefined) {
      throw new ProjectToolError('project mutations are restricted to knowledge/ and verified_propositions/', input)
    }
    const scopeRoot = scope === 'knowledge' ? this.knowledgeRoot : this.verifiedRoot
    const absolute = path.resolve(this.workspaceRoot, ...relativePath.split('/'))
    if (!isContained(scopeRoot, absolute)) throw new ProjectToolError('path escapes its project root', input)
    await this.assertNoSymlinkComponents(scopeRoot, absolute)

    let exists = true
    let canonicalAnchor: string
    try {
      canonicalAnchor = await realpath(absolute)
    } catch (error) {
      if (!isMissing(error)) throw new ProjectToolError('unable to resolve project path', input, { cause: error })
      exists = false
      if (mustExist) throw new ProjectToolError('path does not exist', input, { cause: error })
      canonicalAnchor = await realpath(await this.nearestExisting(absolute))
    }
    if (!isContained(scopeRoot, canonicalAnchor)) {
      throw new ProjectToolError('path resolves outside its project root', input)
    }
    const inReferences = scope === 'knowledge'
      && (relativePath === REFERENCES || relativePath.startsWith(`${REFERENCES}/`)
        || isContained(this.referencesRoot, canonicalAnchor))
    return {
      requested: input,
      relative: relativePath,
      absolute,
      scope,
      scopeRoot,
      exists,
      canonicalAnchor,
      inReferences,
    }
  }

  private rejectReferences(target: ResolvedProjectPath): void {
    if (target.inReferences) {
      throw new ProjectToolError('knowledge/references is read-only project material', target.requested)
    }
  }

  private rejectRoot(target: ResolvedProjectPath, operation: string): void {
    if (target.absolute === target.scopeRoot) {
      throw new ProjectToolError(`${operation} cannot target a project root`, target.requested)
    }
  }

  private rejectProtected(target: ResolvedProjectPath): void {
    if (protectedName(target.relative)) {
      throw new ProjectToolError('protected index/state files cannot be moved or renamed', target.requested)
    }
  }

  private async ensureDirectory(relativePath: string): Promise<ResolvedProjectPath> {
    const normalized = normalizeRelativePath(relativePath)
    const scope = scopeOf(normalized)
    if (scope === undefined) throw new ProjectToolError('directory is outside project roots', relativePath)
    const components = normalized.split('/')
    let current = components[0]
    if (current === undefined) throw new ProjectToolError('invalid directory path', relativePath)
    let resolved = await this.resolve(current, true)
    for (const component of components.slice(1)) {
      current = `${current}/${component}`
      resolved = await this.resolve(current, false)
      this.rejectReferences(resolved)
      if (resolved.exists) {
        if (!(await stat(resolved.absolute)).isDirectory()) {
          throw new ProjectToolError('path component is not a directory', current)
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
        throw new ProjectToolError('path component is not a directory', current)
      }
    }
    return resolved
  }

  /** Recursively create only the requested directory chain below one allowed root. */
  async mkdir(relativePath: string): Promise<{ readonly path: string }> {
    const normalized = normalizedMatchingPath(
      relativePath,
      VERIFIED_SUBDIRECTORY_PATH_PATTERN,
      'mkdir path',
    )
    const target = await this.resolve(normalized, false)
    this.rejectReferences(target)
    this.rejectRoot(target, 'mkdir')
    const result = await this.ensureDirectory(target.relative)
    return { path: result.relative }
  }

  private async walkMarkdown(directory: string): Promise<readonly MarkdownSnapshot[]> {
    const result: MarkdownSnapshot[] = []
    const pending = [directory]
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) break
      const entries = await readdir(current, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const absolute = path.join(current, entry.name)
        if (entry.isSymbolicLink()) {
          const canonical = await realpath(absolute)
          if (!isContained(this.verifiedRoot, canonical)) {
            throw new ProjectToolError('symbolic link escapes verified_propositions', toRelative(this.workspaceRoot, absolute))
          }
          throw new ProjectToolError('symbolic links are not supported while updating proposition references', toRelative(this.workspaceRoot, absolute))
        }
        if (entry.isDirectory()) pending.push(absolute)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          result.push({
            absolute,
            relative: toRelative(this.workspaceRoot, absolute),
            content: decodeUtf8(await readFile(absolute), toRelative(this.workspaceRoot, absolute)),
          })
        }
      }
    }
    return result.sort((left, right) => left.relative.localeCompare(right.relative))
  }

  private buildReferenceUpdates(
    source: ResolvedProjectPath,
    target: ResolvedProjectPath,
    snapshots: readonly MarkdownSnapshot[],
  ): readonly MarkdownUpdate[] {
    const replacements = new Map<string, string>()
    for (const snapshot of snapshots) {
      if (!isContained(source.absolute, snapshot.absolute)) continue
      const afterAbsolute = mapMovedPath(source.absolute, target.absolute, snapshot.absolute)
      const oldLabel = refLabel(snapshot.relative)
      const newLabel = refLabel(toRelative(this.workspaceRoot, afterAbsolute))
      if (oldLabel === undefined || newLabel === undefined || oldLabel === newLabel) continue
      const newReference = `\\ref{${newLabel.replaceAll('/', '\\')}}`
      replacements.set(oldLabel, newReference)
      replacements.set(oldLabel.replaceAll('/', '\\'), newReference)
    }
    if (replacements.size === 0) return []
    return snapshots.flatMap(snapshot => {
      const nextContent = rewriteReferences(snapshot.content, replacements)
      if (nextContent === snapshot.content) return []
      return [{
        ...snapshot,
        afterAbsolute: mapMovedPath(source.absolute, target.absolute, snapshot.absolute),
        nextContent,
      }]
    })
  }

  private async rollbackMove(
    source: ResolvedProjectPath,
    target: ResolvedProjectPath,
    appliedUpdates: readonly MarkdownUpdate[],
  ): Promise<readonly string[]> {
    const failures: string[] = []
    for (const update of [...appliedUpdates].reverse()) {
      try {
        await withFileLock(update.afterAbsolute, async () => {
          const current = decodeUtf8(await readFile(update.afterAbsolute), toRelative(this.workspaceRoot, update.afterAbsolute))
          if (current !== update.nextContent) {
            throw new ProjectToolError('cannot roll back a reference file changed by another writer', toRelative(this.workspaceRoot, update.afterAbsolute))
          }
          await this.writeText(update.afterAbsolute, update.content)
        })
      } catch (error) {
        failures.push(`restore ${toRelative(this.workspaceRoot, update.afterAbsolute)}: ${String(error)}`)
      }
    }
    try {
      await renamePath(target.absolute, source.absolute)
    } catch (error) {
      failures.push(`restore path ${target.relative} -> ${source.relative}: ${String(error)}`)
    }
    return failures
  }

  private async writeReferenceUpdate(update: MarkdownUpdate): Promise<void> {
    await withFileLock(update.afterAbsolute, async () => {
      const current = decodeUtf8(
        await readFile(update.afterAbsolute),
        toRelative(this.workspaceRoot, update.afterAbsolute),
      )
      if (current !== update.content) {
        throw new ProjectToolError(
          'verified Markdown changed while preparing the move; retry after rereading the project',
          toRelative(this.workspaceRoot, update.afterAbsolute),
        )
      }
      await this.writeText(update.afterAbsolute, update.nextContent)
    })
  }

  /**
   * Move or rename an existing file/directory to an explicit new path.
   * Cross-root moves are forbidden, so knowledge can never masquerade as a
   * verified proposition.
   */
  private async move(sourcePath: string, targetPath: string): Promise<ProjectMoveResult> {
    const source = await this.resolve(sourcePath, true)
    const target = await this.resolve(targetPath, false)
    this.rejectReferences(source)
    this.rejectReferences(target)
    this.rejectRoot(source, 'move')
    this.rejectRoot(target, 'move')
    this.rejectProtected(source)
    this.rejectProtected(target)
    if (source.scope !== target.scope) {
      throw new ProjectToolError('moves cannot cross knowledge and verified_propositions boundaries', targetPath)
    }
    if (source.absolute === target.absolute) {
      return { oldPath: source.relative, path: target.relative, updatedReferenceFiles: 0 }
    }
    if (isContained(source.absolute, target.absolute)) {
      throw new ProjectToolError('cannot move a directory into its own subtree', targetPath)
    }
    const sourceInfo = await lstat(source.absolute)
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
      throw new ProjectToolError('move source must be an ordinary file or directory', sourcePath)
    }
    if (sourceInfo.isFile() && path.extname(source.absolute).toLowerCase() !== '.md') {
      throw new ProjectToolError('project move only supports Markdown files', sourcePath)
    }
    if (sourceInfo.isFile() && path.extname(target.absolute).toLowerCase() !== '.md') {
      throw new ProjectToolError('renaming a Markdown file must preserve the .md extension', targetPath)
    }
    if (target.exists) throw new ProjectToolError('move target already exists', targetPath)
    const parent = await this.resolve(toRelative(this.workspaceRoot, path.dirname(target.absolute)), true)
    this.rejectReferences(parent)
    if (!(await stat(parent.absolute)).isDirectory()) {
      throw new ProjectToolError('move target parent is not a directory', targetPath)
    }

    let updates: readonly MarkdownUpdate[] = []
    if (source.scope === 'verified_propositions') {
      const snapshots = await this.walkMarkdown(this.verifiedRoot)
      updates = this.buildReferenceUpdates(source, target, snapshots)
    }

    try {
      await renamePath(source.absolute, target.absolute)
    } catch (error) {
      if (isConflict(error)) throw new ProjectToolError('move target already exists', targetPath, { cause: error })
      throw new ProjectToolError('unable to move project path', sourcePath, { cause: error })
    }

    const appliedUpdates: MarkdownUpdate[] = []
    try {
      for (const update of updates) {
        await this.writeReferenceUpdate(update)
        appliedUpdates.push(update)
      }
    } catch (error) {
      const rollbackFailures = await this.rollbackMove(source, target, appliedUpdates)
      if (rollbackFailures.length > 0) {
        throw new ProjectToolError(
          `reference update failed and rollback was incomplete; workspace is fail-closed (${rollbackFailures.join('; ')})`,
          sourcePath,
          { cause: error },
        )
      }
      throw new ProjectToolError('reference update failed; move was rolled back', sourcePath, { cause: error })
    }
    return {
      oldPath: source.relative,
      path: target.relative,
      updatedReferenceFiles: updates.length,
    }
  }

  /** AlphaSolve-compatible in-place rename convenience. */
  async rename(
    directory: string,
    oldName: string,
    newName: string,
  ): Promise<ProjectMoveResult> {
    const oldPlain = plainName(oldName, 'oldName')
    const newPlain = plainName(newName, 'newName')
    const normalizedDirectory = normalizedMatchingPath(
      directory,
      VERIFIED_DIRECTORY_PATH_PATTERN,
      'rename directory',
    )
    return this.move(`${normalizedDirectory}/${oldPlain}`, `${normalizedDirectory}/${newPlain}`)
  }

  /** AlphaSolve-compatible move which preserves the source file name. */
  async moveInto(sourcePath: string, destinationDirectory: string): Promise<ProjectMoveResult> {
    const normalizedSource = normalizedMatchingPath(
      sourcePath,
      VERIFIED_MARKDOWN_PATH_PATTERN,
      'move path',
    )
    const normalizedDestination = normalizedMatchingPath(
      destinationDirectory,
      VERIFIED_DIRECTORY_PATH_PATTERN,
      'move destination',
    )
    const source = await this.resolve(normalizedSource, true)
    const destination = await this.resolve(normalizedDestination, true)
    const sourceInfo = await lstat(source.absolute)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new ProjectToolError('move path must be one ordinary verified Markdown file', sourcePath)
    }
    if (!(await stat(destination.absolute)).isDirectory()) {
      throw new ProjectToolError('move destination is not a directory', destinationDirectory)
    }
    return this.move(source.relative, `${destination.relative}/${path.basename(source.absolute)}`)
  }
}

export { AlphaSolveProjectTools as ProjectTools }

export async function createProjectTools(
  workspaceRoot: string,
  options: ProjectToolsOptions = {},
): Promise<AlphaSolveProjectTools> {
  return AlphaSolveProjectTools.create(workspaceRoot, options)
}
