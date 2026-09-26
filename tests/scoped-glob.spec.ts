import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { afterEach, describe, expect, it } from 'vitest'
import { createRolePolicy, installRolePermissionBoundary, type RolePermissionPolicy } from '../src/permissions.js'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(role: 'generator' | 'verifier_citation' = 'generator', customize?: (policy: RolePermissionPolicy) => RolePermissionPolicy) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'alphasolve-scoped-glob-'))
  roots.push(cwd)
  const files = ['problem.md', 'knowledge/index.md', 'knowledge/notes.md', 'verified_propositions/lemma.md',
    'unverified_propositions/worker-a/worker_hint.md', 'unverified_propositions/worker-a/proposition.md',
    'unverified_propositions/worker-b/proposition.md', '.alphasolve/state.md']
  for (const file of files) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
    await writeFile(path.join(cwd, file), file)
    await utimes(path.join(cwd, file), new Date('2020-01-01'), new Date('2020-01-01'))
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
  const agent = { session: { header: { id: 'scoped-glob', cwd } } } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  scope.ctx.tools.presentAs('native')
  const original = ctx.tools.get('glob', agent)
  const basePolicy = createRolePolicy(role, { workspace: cwd, workerDirectory: 'unverified_propositions/worker-a', propositionFile: 'unverified_propositions/worker-a/proposition.md' })
  const dispose = installRolePermissionBoundary(scope.ctx, customize?.(basePolicy) ?? basePolicy, agent)
  let counter = 0
  const call = (args: object, name = 'glob', signal = new AbortController().signal) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(`scoped-${++counter}`), signal, agent,
  })
  return { cwd, ctx, agent, call, dispose, original }
}

function normalizedPaths(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['call']>>): string[] {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toHaveProperty('paths')
  return (result.value as { paths: string[] }).paths.map(file => file.replaceAll('\\', '/')).sort()
}

describe('role discovery through native glob and packaged ripgrep', () => {
  it.each(['omitted', '.', './', 'absolute'])('replays %s base without exposing other workers or internal files', async (variant) => {
    const { call, cwd } = await fixture()
    const base = variant === 'omitted' ? undefined : variant === 'absolute' ? cwd : variant
    const result = await call({ pattern: '**/*.md', ...(base === undefined ? {} : { path: base }) })
    expect(normalizedPaths(result)).toEqual([
      'knowledge/index.md', 'knowledge/notes.md', 'problem.md',
      'unverified_propositions/worker-a/proposition.md', 'unverified_propositions/worker-a/worker_hint.md',
      'verified_propositions/lemma.md',
    ])
    expect(JSON.stringify(result)).not.toContain('worker-b')
    expect(JSON.stringify(result)).not.toContain('.alphasolve')
  })

  it.each([
    ['knowledge/*.md', ['knowledge/index.md', 'knowledge/notes.md']],
    ['verified_propositions/**/*.md', ['verified_propositions/lemma.md']],
    ['unverified_propositions/**/*.md', ['unverified_propositions/worker-a/proposition.md', 'unverified_propositions/worker-a/worker_hint.md']],
    ['/problem.md', ['problem.md']],
    ['no-files-*.xyz', []],
  ])('matches logged or anchored pattern %s', async (pattern, expected) => {
    const { call } = await fixture()
    expect(normalizedPaths(await call({ pattern }))).toEqual(expected)
  })

  it('supports negative anchored patterns and authorized ancestor bases', async () => {
    const { call } = await fixture()
    expect(normalizedPaths(await call({ pattern: '*.md', path: 'unverified_propositions' }))).toHaveLength(2)
    expect(normalizedPaths(await call({ pattern: '!/problem.md' }))).not.toContain('problem.md')
  })

  it('retains native ascending modification-time order across readable roots', async () => {
    const { call, cwd } = await fixture()
    await utimes(path.join(cwd, 'problem.md'), new Date('2000-01-01'), new Date('2000-01-01'))
    const result = await call({ pattern: '*.md' })
    normalizedPaths(result)
    expect((result.value as { paths: string[] }).paths[0]).toBe('problem.md')
  })

  it('keeps verifier discovery independent of the problem, hints, and knowledge', async () => {
    const { call } = await fixture('verifier_citation')
    const result = await call({ pattern: '**/*.md', path: '.' })
    expect(normalizedPaths(result)).toEqual(['unverified_propositions/worker-a/proposition.md', 'verified_propositions/lemma.md'])
    const rendered = result.content.filter(block => block.type === 'text').map(block => block.text.replaceAll('\\', '/')).join('\n')
    expect(rendered.split('\n').sort()).toEqual(normalizedPaths(result))
    expect(JSON.stringify(result.meta)).not.toMatch(/problem\.md|knowledge|worker-b|\.alphasolve/)
  })

  it('rejects explicit forbidden roots and leaves grep requiring an admitted base', async () => {
    const { call, cwd } = await fixture()
    for (const target of ['..', '../knowledge', '.alphasolve', 'unverified_propositions/worker-b', path.dirname(cwd)]) {
      expect((await call({ pattern: '*.md', path: target })).isError, target).toBe(true)
    }
    expect((await call({ pattern: 'index' }, 'grep')).isError).toBe(true)
    expect((await call({ pattern: 'index', path: 'knowledge' }, 'grep')).isError).toBe(false)
  })

  it('filters denied descendants before value, rendering, and presentation metadata', async () => {
    const { call } = await fixture('generator', policy => ({ ...policy, paths: [...policy.paths, {
      root: path.join(policy.cwd, 'knowledge/notes.md'), kind: 'file', access: ['read'], effect: 'deny',
    }] }))
    const result = await call({ pattern: '*.md', path: 'knowledge' })
    expect(normalizedPaths(result)).toEqual(['knowledge/index.md'])
    expect(JSON.stringify(result)).not.toContain('notes.md')
  })

  it('blocks symlink escapes and aliases to another worker', async () => {
    const { call, cwd } = await fixture()
    const outside = await mkdtemp(path.join(tmpdir(), 'alphasolve-glob-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'secret.md'), 'outside')
    await symlink(outside, path.join(cwd, 'knowledge/escape'), 'dir')
    await symlink(path.join(cwd, 'unverified_propositions/worker-b/proposition.md'), path.join(cwd, 'knowledge/alias.md'), 'file')
    const result = await call({ pattern: '**/*.md' })
    expect(normalizedPaths(result)).not.toContain('knowledge/alias.md')
    expect(JSON.stringify(result)).not.toContain('secret.md')
    expect((await call({ pattern: '*.md', path: 'knowledge/escape' })).isError).toBe(true)
    expect((await call({ pattern: '*.md', path: 'knowledge/alias.md' })).isError).toBe(true)
  })

  it('reports invalid patterns, honors cancellation, and restores the original tool on disposal', async () => {
    const { call, ctx, agent, dispose, original } = await fixture()
    expect((await call({ pattern: '[' })).isError).toBe(true)
    expect((await call({ pattern: '*.md' }, 'glob', AbortSignal.abort())).isError).toBe(true)
    dispose()
    expect(ctx.tools.get('glob', agent)).toBe(original)
    expect(normalizedPaths(await call({ pattern: '**/*.md' }))).toContain('unverified_propositions/worker-b/proposition.md')
  })
})
