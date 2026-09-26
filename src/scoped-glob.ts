/** Role-scoped glob execution; only checked results reach the inherited renderer. */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Filesystem policy applied before searching roots and before publishing each path. */
export interface ScopedGlobAccess {
  readonly cwd: string
  roots(base: string): readonly string[]
  assertRoot(root: string): Promise<void>
  canRead(file: string): Promise<boolean>
}

const originalTools = new WeakMap<ToolDefinition, ToolDefinition>()

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('glob expects an object')
  return value as Record<string, unknown>
}

function matchesFile(file: string, pattern: string): boolean {
  const negated = pattern.startsWith('!')
  const positive = negated ? pattern.slice(1) : pattern
  const candidate = positive.includes('/') ? file : path.posix.basename(file)
  const matches = path.posix.matchesGlob(candidate, positive.startsWith('/') ? positive.slice(1) : positive)
  return negated ? !matches : matches
}

/** Wrap the preset's glob tool without changing its result schema or UI presentation. */
export function createScopedGlobTool(inherited: ToolDefinition, access: ScopedGlobAccess): ToolDefinition {
  const original = originalTools.get(inherited) ?? inherited
  const tool: ToolDefinition = {
    ...original,
    description: 'Find files matching a glob pattern within this role\'s readable paths. Returns workspace-relative paths in modification-time order. Narrow pattern or path if the result is capped.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'File glob, e.g. "**/*.md" or "verified_propositions/**/*.md". A pattern without "/" matches basenames at any depth.' },
        path: { type: 'string', description: 'Search base relative to the session workspace. Omit or use "." to search only this role\'s readable files across the workspace. A workspace-absolute base is also accepted.' },
      },
      required: ['pattern'],
    },
    async execute(raw, exec) {
      const args = record(raw)
      if (Object.keys(args).some(key => key !== 'pattern' && key !== 'path')) throw new TypeError('glob accepts only pattern and path')
      if (typeof args.pattern !== 'string' || !args.pattern.trim()) throw new TypeError('glob pattern must be a non-empty string')
      if (args.path !== undefined && (typeof args.path !== 'string' || !args.path.trim())) throw new TypeError('glob path must be a non-empty string')
      const base = typeof args.path === 'string' ? args.path : '.'
      const found = new Map<string, number>()
      for (const root of access.roots(base)) {
        exec.signal.throwIfAborted()
        await access.assertRoot(root)
        let entry
        try { entry = await stat(path.resolve(access.cwd, root)) } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue
          throw error
        }
        let files: string[]
        if (entry.isFile()) {
          files = matchesFile(root.replaceAll('\\', '/'), args.pattern) ? [root] : []
        } else {
          const value = record(await original.execute({ pattern: args.pattern, path: root }, exec))
          if (!Array.isArray(value.paths) || !value.paths.every(file => typeof file === 'string')) {
            throw new TypeError('glob returned an invalid paths array')
          }
          files = value.paths
        }
        for (const file of files) {
          exec.signal.throwIfAborted()
          if (!await access.canRead(file)) continue
          try {
            const info = await stat(path.resolve(access.cwd, file))
            if (info.isFile()) found.set(file, info.mtimeMs)
          } catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue
            throw error
          }
        }
      }
      exec.signal.throwIfAborted()
      return {
        root: path.relative(access.cwd, path.resolve(access.cwd, base)) || '.',
        paths: [...found].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([file]) => file),
      }
    },
  }
  originalTools.set(tool, original)
  return tool
}
