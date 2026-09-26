import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { createScopedGlobTool } from './scoped-glob.js'

/** Agent roles which receive an AlphaSolve-scoped filesystem view. */
export type RoleKind =
  | 'orchestrator'
  | 'generator'
  | 'verifier'
  | 'verifier_citation'
  | 'reviser'
  | 'theorem_checker'
  | 'curator'
  | 'curator_helper'
  | 'compute'
  | 'numerical_experiment'
  | 'research_reviewer'
  | 'reasoning'

export type PathAccess = 'read' | 'write'

export interface PathPermissionRule {
  /** Absolute file or directory path. */
  readonly root: string
  readonly kind: 'file' | 'directory'
  readonly access: readonly PathAccess[]
  /** Denials take precedence over grants, including through symlink aliases. */
  readonly effect?: 'allow' | 'deny'
  /** Optional POSIX-relative path constraint below a directory root. */
  readonly relativePattern?: RegExp
}

export interface RolePermissionPolicy {
  readonly role: RoleKind
  readonly cwd: string
  /** Includes standard global tools and scoped helper tools permitted for the role. */
  readonly allowedTools: ReadonlySet<string>
  readonly paths: readonly PathPermissionRule[]
}

export interface RolePolicyScope {
  readonly workspace: string
  readonly workerDirectory?: string
  readonly propositionFile?: string
  readonly theoremViewDirectory?: string
  readonly knowledgeDirectory?: string
  readonly verifiedDirectory?: string
  /** Read-only roots explicitly delegated to an auxiliary role. */
  readonly delegatedReadRoots?: readonly string[]
  /** Names of role-scoped helper tools installed by the workflow. */
  readonly extraAllowedTools?: readonly string[]
}

export interface CanonicalPathAccess {
  readonly requestedPath: string
  readonly lexicalPath: string
  readonly canonicalPath: string
  readonly matchedRule: PathPermissionRule
}

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep'])
const READ_ONLY_TOOLS = ['read', 'glob', 'grep'] as const
const READ_WRITE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep'] as const

/** AlphaSolve main permits orchestrator Write/Edit only for per-directory indexes. */
export const ORCHESTRATOR_INDEX_PATH_PATTERN = String.raw`^verified_propositions(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*/index\.md$`
const ORCHESTRATOR_INDEX_RELATIVE_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*index\.md$/

/** Exact names known to provide process, code, generic delegation, or network access. */
export const FORBIDDEN_ROLE_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec',
  'run_code',
  'subagent',
  'spawn_agent',
  'send_message',
  'task',
  'task_output',
  'task_kill',
  'web',
  'web_search',
  'web_fetch',
  'browser',
])

// Prefix matching catches host-specific variants while permitting explicitly
// registered, typed helpers such as `compute_subagent`.
const FORBIDDEN_TOOL_FAMILY = /^(?:bash|shell|terminal|exec(?:ute|[_-]command)?|run[_-]?code|web|browser)(?:$|[_-])/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyPath(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`)
  return value
}

function absoluteFrom(root: string, candidate: string): string {
  return path.resolve(root, candidate)
}

function normalizeRule(cwd: string, rule: PathPermissionRule): PathPermissionRule {
  const root = path.isAbsolute(rule.root) ? path.normalize(rule.root) : absoluteFrom(cwd, rule.root)
  return Object.freeze({
    ...rule,
    root,
    access: Object.freeze([...rule.access]),
    effect: rule.effect ?? 'allow',
    ...(rule.relativePattern === undefined ? {} : {
      relativePattern: new RegExp(rule.relativePattern.source, rule.relativePattern.flags),
    }),
  })
}

function fileRule(root: string, access: readonly PathAccess[], effect: 'allow' | 'deny' = 'allow'): PathPermissionRule {
  return { root, kind: 'file', access, effect }
}

function directoryRule(
  root: string,
  access: readonly PathAccess[],
  effect: 'allow' | 'deny' = 'allow',
  relativePattern?: RegExp,
): PathPermissionRule {
  return { root, kind: 'directory', access, effect, ...relativePattern === undefined ? {} : { relativePattern } }
}

function requireScopePath(value: string | undefined, role: RoleKind, field: keyof RolePolicyScope): string {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`role "${role}" requires ${String(field)}`)
  }
  return value
}

function resolveScopePath(cwd: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(cwd, value))
}

/**
 * Materialize the filesystem/tool policy for one fresh role agent.
 *
 * Auxiliary roles intentionally receive no ambient workspace access: their
 * caller must pass the roots which are safe for that particular delegation.
 */
export function createRolePolicy(role: RoleKind, scope: RolePolicyScope): RolePermissionPolicy {
  const cwd = path.resolve(nonEmptyPath(scope.workspace, 'workspace'))
  const knowledge = path.resolve(scope.knowledgeDirectory ?? path.join(cwd, 'knowledge'))
  const verified = path.resolve(scope.verifiedDirectory ?? path.join(cwd, 'verified_propositions'))
  const problem = path.join(cwd, 'problem.md')
  const hint = path.join(cwd, 'hint.md')
  const extraTools = scope.extraAllowedTools ?? []

  let standardTools: readonly string[]
  let rules: PathPermissionRule[]

  switch (role) {
    case 'orchestrator':
      standardTools = READ_WRITE_TOOLS
      rules = [
        fileRule(problem, ['read']),
        fileRule(hint, ['read']),
        fileRule(path.join(cwd, 'solution.md'), ['read']),
        directoryRule(knowledge, ['read']),
        directoryRule(verified, ['read']),
        directoryRule(verified, ['write'], 'allow', ORCHESTRATOR_INDEX_RELATIVE_PATTERN),
      ]
      break

    case 'generator': {
      const worker = resolveScopePath(cwd, requireScopePath(scope.workerDirectory, role, 'workerDirectory'))
      const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, 'propositionFile'))
      standardTools = READ_WRITE_TOOLS
      rules = [
        fileRule(problem, ['read']),
        fileRule(hint, ['read']),
        directoryRule(knowledge, ['read']),
        directoryRule(verified, ['read']),
        directoryRule(worker, ['read']),
        fileRule(proposition, ['read', 'write']),
      ]
      break
    }

    case 'verifier':
    case 'verifier_citation': {
      const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, 'propositionFile'))
      standardTools = READ_ONLY_TOOLS
      rules = [
        fileRule(proposition, ['read']),
        directoryRule(verified, ['read']),
        ...role === 'verifier_citation' ? [] : [directoryRule(knowledge, ['read'])],
      ]
      break
    }

    case 'reviser': {
      const proposition = resolveScopePath(cwd, requireScopePath(scope.propositionFile, role, 'propositionFile'))
      standardTools = READ_WRITE_TOOLS
      rules = [
        directoryRule(knowledge, ['read']),
        directoryRule(verified, ['read']),
        fileRule(proposition, ['read', 'write']),
      ]
      break
    }

    case 'theorem_checker': {
      const theoremView = resolveScopePath(cwd, requireScopePath(scope.theoremViewDirectory, role, 'theoremViewDirectory'))
      standardTools = READ_ONLY_TOOLS
      rules = [directoryRule(path.join(theoremView, 'verified_propositions'), ['read'])]
      break
    }

    case 'curator':
      standardTools = READ_WRITE_TOOLS
      rules = [
        directoryRule(knowledge, ['read', 'write']),
        directoryRule(path.join(knowledge, 'references'), ['write'], 'deny'),
      ]
      break

    case 'curator_helper':
      standardTools = READ_ONLY_TOOLS
      rules = [directoryRule(knowledge, ['read'])]
      break

    case 'research_reviewer':
      standardTools = READ_ONLY_TOOLS
      rules = [
        fileRule(problem, ['read']),
        directoryRule(knowledge, ['read']),
        directoryRule(verified, ['read']),
        ...(scope.delegatedReadRoots ?? []).map(root => directoryRule(resolveScopePath(cwd, root), ['read'])),
      ]
      break

    case 'compute':
    case 'numerical_experiment':
    case 'reasoning':
      standardTools = READ_ONLY_TOOLS
      rules = (scope.delegatedReadRoots ?? []).map(root => directoryRule(resolveScopePath(cwd, root), ['read']))
      break
  }

  for (const name of extraTools) {
    if (role !== 'orchestrator' && isForbiddenRoleTool(name)) {
      throw new TypeError(`role "${role}" cannot allow forbidden tool "${name}"`)
    }
  }

  return Object.freeze({
    role,
    cwd,
    allowedTools: new Set([...standardTools, ...extraTools]),
    paths: Object.freeze(rules.map(rule => normalizeRule(cwd, rule))),
  })
}

/** Treat both POSIX and Windows path syntax as path syntax on every platform. */
export function normalizeUserPath(candidate: string): string {
  if (candidate.includes('\0')) throw new TypeError('path must not contain NUL bytes')
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || /^[A-Za-z]:/.test(candidate)) {
    throw new TypeError('absolute paths are not allowed')
  }
  const segments = candidate.replaceAll('\\', '/').split('/')
  if (segments.includes('..')) throw new TypeError('parent path segments (..) are not allowed')
  return segments.join(path.sep)
}

/** A denied role path, distinct from filesystem and configuration failures. */
class RolePathAccessError extends Error {}

function pathGuidance(policy: RolePermissionPolicy, access: PathAccess = 'read'): string {
  const roots = policy.paths.filter(rule => rule.access.includes(access) && rule.effect !== 'deny')
    .map(rule => path.relative(policy.cwd, rule.root).split(path.sep).join('/')
      + (rule.kind === 'directory' ? '/' : '')
      + (rule.relativePattern === undefined ? '' : ` (relative paths matching ${rule.relativePattern.source})`))
  return roots.length === 0 ? `No paths permit ${access} access.` : `Permitted ${access} paths: ${[...new Set(roots)].join(', ')}.`
}

/** A broad glob visits only admitted roots; direct file access still requires its own grant. */
function globRoots(policy: RolePermissionPolicy, requested: string): readonly string[] {
  if (requested.replaceAll('\\', '/').split('/').includes('..')) throw new TypeError('parent path segments (..) are not allowed')
  let relative = requested
  if (path.isAbsolute(requested)) {
    if (!isWithin(requested, policy.cwd, 'directory')) throw new RolePathAccessError('glob path must stay inside the workspace')
    relative = path.relative(policy.cwd, requested) || '.'
  }
  const base = path.resolve(policy.cwd, normalizeUserPath(relative))
  const match = applicableRules(policy, base, 'read')
  if (match.denied !== undefined) throw new RolePathAccessError(`read access is denied for "${requested}"`)
  const roots = match.allowed === undefined
    ? policy.paths.filter(rule => rule.access.includes('read') && rule.effect !== 'deny' && isWithin(rule.root, base, 'directory')).map(rule => rule.root)
    : [base]
  if (roots.length === 0 && base !== policy.cwd) {
    throw new RolePathAccessError(`read access is outside the ${policy.role} role boundary: "${requested}". ${pathGuidance(policy)}`)
  }
  return [...new Set(roots)].filter(root => !roots.some(other => other !== root && isWithin(root, other, 'directory')))
    .map(root => path.relative(policy.cwd, root) || '.')
}

function isWithin(candidate: string, root: string, kind: PathPermissionRule['kind']): boolean {
  const relative = path.relative(root, candidate)
  if (kind === 'file') return relative === ''
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function applicableRules(
  policy: RolePermissionPolicy,
  candidate: string,
  access: PathAccess,
): { denied?: PathPermissionRule; allowed?: PathPermissionRule } {
  let allowed: PathPermissionRule | undefined
  for (const rule of policy.paths) {
    if (!rule.access.includes(access) || !matchesPathRule(candidate, rule)) continue
    if ((rule.effect ?? 'allow') === 'deny') return { denied: rule }
    allowed ??= rule
  }
  return allowed === undefined ? {} : { allowed }
}

function matchesPathRule(candidate: string, rule: PathPermissionRule): boolean {
  if (!isWithin(candidate, rule.root, rule.kind)) return false
  if (rule.relativePattern === undefined) return true
  const relative = path.relative(rule.root, candidate).split(path.sep).join('/')
  rule.relativePattern.lastIndex = 0
  return rule.relativePattern.test(relative)
}

export interface ToolPathRequest {
  readonly path: string
  readonly access: PathAccess
}

/** Extract the standard DSH filesystem path without interpreting helper tools. */
export function toolPathRequest(execution: Pick<ToolExecution, 'name' | 'arguments'>): ToolPathRequest | undefined {
  if (!FILE_TOOLS.has(execution.name)) return undefined
  if (!isRecord(execution.arguments)) throw new TypeError(`tool "${execution.name}" arguments must be an object`)

  if (execution.name === 'write' || execution.name === 'edit') {
    if ('sandbox_permissions' in execution.arguments || 'justification' in execution.arguments) {
      throw new TypeError(`tool "${execution.name}" cannot request sandbox escalation`)
    }
  }

  const field = execution.name === 'glob' || execution.name === 'grep' ? 'path' : 'file_path'
  const raw = execution.arguments[field]
  const requested = raw === undefined && field === 'path' ? '.' : raw
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new TypeError(`tool "${execution.name}" requires a non-empty string ${field}`)
  }
  return {
    path: requested,
    access: execution.name === 'write' || execution.name === 'edit' ? 'write' : 'read',
  }
}

/** Validate a tool path without touching the filesystem; suitable for tools.guard(). */
export function assertLexicalPathAccess(
  policy: RolePermissionPolicy,
  requestedPath: string,
  access: PathAccess,
): string {
  const normalized = normalizeUserPath(requestedPath)
  const lexicalPath = absoluteFrom(policy.cwd, normalized)
  const match = applicableRules(policy, lexicalPath, access)
  if (match.denied !== undefined) {
    throw new RolePathAccessError(`${access} access is denied for "${requestedPath}"`)
  }
  if (match.allowed === undefined) {
    throw new RolePathAccessError(`${access} access is outside the ${policy.role} role boundary: "${requestedPath}". ${pathGuidance(policy, access)}`)
  }
  return lexicalPath
}

/**
 * Resolve an existing path, or the nearest existing ancestor of a create target.
 * This detects a symlink in every existing component without requiring the leaf
 * to exist yet.
 */
export async function canonicalizePotentialPath(candidate: string): Promise<string> {
  const missing: string[] = []
  let cursor = path.resolve(candidate)

  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor)
      return path.resolve(canonicalAncestor, ...missing.reverse())
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
      try {
        const entry = await lstat(cursor)
        if (entry.isSymbolicLink()) {
          throw new Error(`path contains a broken symbolic link: "${cursor}"`)
        }
      } catch (lstatError: unknown) {
        if (!isRecord(lstatError) || lstatError.code !== 'ENOENT') throw lstatError
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      missing.push(path.basename(cursor))
      cursor = parent
    }
  }
}

/** Resolve symlinks in both the requested path and grants, then re-check access. */
export async function assertCanonicalContainment(
  policy: RolePermissionPolicy,
  requestedPath: string,
  access: PathAccess,
): Promise<CanonicalPathAccess> {
  const lexicalPath = assertLexicalPathAccess(policy, requestedPath, access)
  const canonicalPath = await canonicalizePotentialPath(lexicalPath)

  let allowed: PathPermissionRule | undefined
  for (const lexicalRule of policy.paths) {
    if (!lexicalRule.access.includes(access)) continue
    const canonicalRoot = await canonicalizePotentialPath(lexicalRule.root)
    const canonicalRule = { ...lexicalRule, root: canonicalRoot }
    if (!matchesPathRule(canonicalPath, canonicalRule)) continue
    if ((lexicalRule.effect ?? 'allow') === 'deny') {
      throw new RolePathAccessError(`${access} access resolves into a denied path: "${requestedPath}"`)
    }
    allowed ??= canonicalRule
  }

  if (allowed === undefined) {
    throw new RolePathAccessError(`${access} access escapes the ${policy.role} role boundary through a symbolic link: "${requestedPath}"`)
  }
  return { requestedPath, lexicalPath, canonicalPath, matchedRule: allowed }
}

export function isForbiddenRoleTool(name: string): boolean {
  return FORBIDDEN_ROLE_TOOLS.has(name) || FORBIDDEN_TOOL_FAMILY.test(name)
}

/** Final synchronous policy boundary which later waterfall listeners cannot override. */
export function createLexicalToolGuard(policy: RolePermissionPolicy, ownsScopedGlob: (execution: ToolExecution) => boolean = () => false): ToolGuard {
  return (execution): string | undefined => {
    if (policy.role !== 'orchestrator' && isForbiddenRoleTool(execution.name)) {
      return `tool "${execution.name}" is forbidden for AlphaSolve role agents`
    }
    if (!policy.allowedTools.has(execution.name)) {
      return `tool "${execution.name}" is not allowed for AlphaSolve role "${policy.role}"`
    }

    try {
      const request = toolPathRequest(execution)
      if (request !== undefined) {
        if (execution.name === 'glob' && ownsScopedGlob(execution)) globRoots(policy, request.path)
        else assertLexicalPathAccess(policy, request.path, request.access)
      }
      return undefined
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Install both lexical and canonical checks into one Agent scope.
 *
 * Custom helper tools remain responsible for calling
 * assertCanonicalContainment for each path they accept; only the five standard
 * DSH filesystem tools have a common argument contract here.
 */
export function installRolePermissionBoundary(ctx: Context, policy: RolePermissionPolicy, agent?: ToolExecution['agent']): () => void {
  const inheritedGlob = policy.allowedTools.has('glob') ? ctx.tools.get('glob', agent) : undefined
  const scopedGlob = inheritedGlob === undefined ? undefined : createScopedGlobTool(inheritedGlob, {
    cwd: policy.cwd,
    roots: base => globRoots(policy, base),
    assertRoot: async root => { await assertCanonicalContainment(policy, root, 'read') },
    canRead: async file => {
      try {
        await assertCanonicalContainment(policy, file, 'read')
        return true
      } catch (error) {
        if (error instanceof RolePathAccessError) return false
        throw error
      }
    },
  })
  const disposeGlob = scopedGlob === undefined ? undefined : ctx.tools.register(scopedGlob)
  const ownsScopedGlob = (execution: ToolExecution): boolean => scopedGlob !== undefined && ctx.tools.get('glob', execution.agent) === scopedGlob
  const disposeGuidance = ctx.systemPrompt.section({
    name: 'alphasolve:file-paths', order: 51,
    text: `File paths resolve from the session workspace, never a worker directory. Use workspace-relative paths for read/write/edit. ${pathGuidance(policy)} glob with omitted path or path="." discovers only readable files; grep requires an explicit readable path.`,
  })
  const disposeGuard = ctx.tools.guard(createLexicalToolGuard(policy, ownsScopedGlob))
  const disposeCanonical = ctx.on(
    'tools/pre-execute',
    async (execution, next): Promise<PreToolDecision> => {
      try {
        const request = toolPathRequest(execution)
        if (request !== undefined) {
          if (execution.signal.aborted) return { kind: 'deny', reason: 'tool call was cancelled' }
          if (execution.name === 'glob' && ownsScopedGlob(execution)) {
            for (const root of globRoots(policy, request.path)) {
              execution.signal.throwIfAborted()
              await assertCanonicalContainment(policy, root, 'read')
            }
          } else await assertCanonicalContainment(policy, request.path, request.access)
          if (execution.signal.aborted) return { kind: 'deny', reason: 'tool call was cancelled' }
        }
      } catch (error: unknown) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
      }
      return next()
    },
  )

  return () => {
    disposeCanonical()
    disposeGuard()
    disposeGlob?.()
    disposeGuidance()
  }
}
