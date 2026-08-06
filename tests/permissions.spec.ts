import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

import {
  assertCanonicalContainment,
  assertLexicalPathAccess,
  createLexicalToolGuard,
  createRolePolicy,
} from '../src/permissions.js'

const temporaryRoots: string[] = []

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-permissions-'))
  temporaryRoots.push(root)
  await Promise.all([
    mkdir(path.join(root, 'knowledge', 'references'), { recursive: true }),
    mkdir(path.join(root, 'verified_propositions'), { recursive: true }),
    mkdir(path.join(root, 'unverified_propositions', 'worker-a'), { recursive: true }),
  ])
  await writeFile(path.join(root, 'problem.md'), 'problem')
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function execution(name: string, args: Record<string, unknown>): ToolExecution {
  return { name, arguments: args } as ToolExecution
}

describe('lexical role boundary', () => {
  it('lets the orchestrator edit only root or nested verified index files', async () => {
    const workspace = await temporaryWorkspace()
    const policy = createRolePolicy('orchestrator', { workspace })
    const guard = createLexicalToolGuard(policy)

    expect(assertLexicalPathAccess(policy, 'verified_propositions/index.md', 'write'))
      .toBe(path.join(workspace, 'verified_propositions', 'index.md'))
    expect(assertLexicalPathAccess(policy, 'verified_propositions/route-a/subroute/index.md', 'write'))
      .toBe(path.join(workspace, 'verified_propositions', 'route-a', 'subroute', 'index.md'))
    expect(assertLexicalPathAccess(policy, 'knowledge/index.md', 'read'))
      .toBe(path.join(workspace, 'knowledge', 'index.md'))

    for (const denied of [
      'verified_propositions/new-proposition.md',
      'verified_propositions/route-a/proof.md',
      'verified_propositions/not allowed/index.md',
      'knowledge/index.md',
      'knowledge/notes.md',
    ]) {
      expect(() => assertLexicalPathAccess(policy, denied, 'write'), denied).toThrow(/outside/)
    }
    expect(guard(execution('write', {
      file_path: 'verified_propositions/new-proposition.md',
      content: '# Fabricated proposition',
    }))).toMatch(/outside/)
    expect(guard(execution('edit', {
      file_path: 'verified_propositions/route-a/proof.md',
      old_string: 'a',
      new_string: 'b',
    }))).toMatch(/outside/)
  })

  it('allows only the generator proposition write target', async () => {
    const workspace = await temporaryWorkspace()
    const worker = path.join(workspace, 'unverified_propositions', 'worker-a')
    const policy = createRolePolicy('generator', {
      workspace,
      workerDirectory: worker,
      propositionFile: path.join(worker, 'proposition.md'),
    })

    expect(assertLexicalPathAccess(policy, 'unverified_propositions/worker-a/proposition.md', 'write'))
      .toBe(path.join(worker, 'proposition.md'))
    expect(() => assertLexicalPathAccess(policy, 'unverified_propositions/worker-a/notes.md', 'write'))
      .toThrow(/outside the generator role boundary/)
    expect(() => assertLexicalPathAccess(policy, '/etc/passwd', 'read')).toThrow(/absolute paths/)
    expect(() => assertLexicalPathAccess(policy, '../secret.md', 'read')).toThrow(/parent path segments/)
    expect(() => assertLexicalPathAccess(policy, 'knowledge\\..\\problem.md', 'read'))
      .toThrow(/parent path segments/)
  })

  it('denies dangerous tools and write escalation at the final guard', async () => {
    const workspace = await temporaryWorkspace()
    const worker = path.join(workspace, 'unverified_propositions', 'worker-a')
    const policy = createRolePolicy('generator', {
      workspace,
      workerDirectory: worker,
      propositionFile: path.join(worker, 'proposition.md'),
    })
    const guard = createLexicalToolGuard(policy)

    expect(guard(execution('run_code', {}))).toMatch(/forbidden/)
    expect(guard(execution('web_search', {}))).toMatch(/forbidden/)
    expect(guard(execution('subagent', {}))).toMatch(/forbidden/)
    expect(guard(execution('write', {
      file_path: 'unverified_propositions/worker-a/proposition.md',
      content: 'x',
      sandbox_permissions: 'require_escalated',
    }))).toMatch(/cannot request sandbox escalation/)
  })

  it('keeps citation verification out of knowledge and theorem checking inside its view', async () => {
    const workspace = await temporaryWorkspace()
    const proposition = path.join(workspace, 'unverified_propositions', 'worker-a', 'proposition.md')
    await writeFile(proposition, 'draft')

    const citation = createRolePolicy('verifier_citation', { workspace, propositionFile: proposition })
    expect(() => assertLexicalPathAccess(citation, 'knowledge/index.md', 'read')).toThrow(/outside/)
    expect(() => assertLexicalPathAccess(citation, 'problem.md', 'read')).toThrow(/outside/)
    expect(assertLexicalPathAccess(citation, 'unverified_propositions/worker-a/proposition.md', 'read'))
      .toBe(proposition)

    const reviser = createRolePolicy('reviser', { workspace, propositionFile: proposition })
    expect(() => assertLexicalPathAccess(reviser, 'problem.md', 'read')).toThrow(/outside/)
    expect(() => assertLexicalPathAccess(reviser, 'hint.md', 'read')).toThrow(/outside/)
    expect(assertLexicalPathAccess(reviser, 'unverified_propositions/worker-a/proposition.md', 'write'))
      .toBe(proposition)

    const theoremView = path.join(workspace, '.alphasolve', 'theorem-view')
    await mkdir(path.join(theoremView, 'verified_propositions'), { recursive: true })
    const theorem = createRolePolicy('theorem_checker', { workspace, theoremViewDirectory: theoremView })
    expect(assertLexicalPathAccess(theorem, '.alphasolve/theorem-view/verified_propositions/candidate.md', 'read'))
      .toBe(path.join(theoremView, 'verified_propositions', 'candidate.md'))
    expect(() => assertLexicalPathAccess(theorem, 'problem.md', 'read')).toThrow(/outside/)
  })

  it('lets the curator read references but never write their text', async () => {
    const workspace = await temporaryWorkspace()
    const policy = createRolePolicy('curator', { workspace })

    expect(assertLexicalPathAccess(policy, 'knowledge/references/paper.md', 'read'))
      .toBe(path.join(workspace, 'knowledge', 'references', 'paper.md'))
    expect(() => assertLexicalPathAccess(policy, 'knowledge/references/paper.md', 'write'))
      .toThrow(/denied/)
    expect(assertLexicalPathAccess(policy, 'knowledge/index.md', 'write'))
      .toBe(path.join(workspace, 'knowledge', 'index.md'))
  })
})

describe('canonical role boundary', () => {
  it('does not let an index-shaped symlink alias authorize proposition edits', async () => {
    const workspace = await temporaryWorkspace()
    const proposition = path.join(workspace, 'verified_propositions', 'lemma.md')
    await writeFile(proposition, '# Lemma\n')
    await symlink('lemma.md', path.join(workspace, 'verified_propositions', 'index.md'), 'file')
    const policy = createRolePolicy('orchestrator', { workspace })

    await expect(assertCanonicalContainment(policy, 'verified_propositions/index.md', 'write'))
      .rejects.toThrow(/escapes the orchestrator role boundary/)
  })

  it('rejects an existing-directory symlink escape for reads and new writes', async () => {
    const workspace = await temporaryWorkspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'secret.md'), 'secret')
    await symlink(outside, path.join(workspace, 'knowledge', 'escape'), 'dir')
    const policy = createRolePolicy('curator', { workspace })

    await expect(assertCanonicalContainment(policy, 'knowledge/escape/secret.md', 'read'))
      .rejects.toThrow(/escapes the curator role boundary/)
    await expect(assertCanonicalContainment(policy, 'knowledge/escape/new.md', 'write'))
      .rejects.toThrow(/escapes the curator role boundary/)
  })

  it('accepts a symlink whose final target stays in an allowed root', async () => {
    const workspace = await temporaryWorkspace()
    await mkdir(path.join(workspace, 'knowledge', 'notes'))
    await writeFile(path.join(workspace, 'knowledge', 'notes', 'lemma.md'), 'lemma')
    await symlink('notes', path.join(workspace, 'knowledge', 'alias'), 'dir')
    const policy = createRolePolicy('curator_helper', { workspace })

    const result = await assertCanonicalContainment(policy, 'knowledge/alias/lemma.md', 'read')
    expect(result.canonicalPath).toBe(path.join(workspace, 'knowledge', 'notes', 'lemma.md'))
  })

  it('fails closed on a broken symlink in a create target', async () => {
    const workspace = await temporaryWorkspace()
    await symlink(path.join(workspace, 'missing-target'), path.join(workspace, 'knowledge', 'broken'), 'dir')
    const policy = createRolePolicy('curator', { workspace })

    await expect(assertCanonicalContainment(policy, 'knowledge/broken/new.md', 'write'))
      .rejects.toThrow(/broken symbolic link/)
  })
})
