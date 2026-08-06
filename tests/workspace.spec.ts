import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertFileStamp,
  backupSolution,
  canonicalWorkspace,
  captureFileStamp,
  digestText,
  initializeWorkspace,
  normalizeRelativePath,
  readWorkspaceInput,
  resolveWorkspacePath,
  snapshotWorkspace,
  WorkspaceError,
} from '../src/workspace.js'

const roots: string[] = []

async function temporaryDirectory(prefix = 'dsh-alphasolve-workspace-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace paths', () => {
  it('rejects POSIX, Windows, dot, empty-component, and NUL escapes', () => {
    expect(normalizeRelativePath('knowledge/note.md')).toBe('knowledge/note.md')
    for (const value of [
      '',
      '/etc/passwd',
      'C:\\Windows\\system.ini',
      '\\\\server\\share\\file',
      '../outside',
      'knowledge/../problem.md',
      'knowledge//note.md',
      './problem.md',
      'bad\0name',
    ]) {
      expect(() => normalizeRelativePath(value), value).toThrow(WorkspaceError)
    }
  })

  it('canonicalizes a symlink cwd and resolves descendants against the real root', async () => {
    const root = await temporaryDirectory()
    const aliasParent = await temporaryDirectory('dsh-alphasolve-alias-')
    const alias = path.join(aliasParent, 'workspace-link')
    await symlink(root, alias, 'dir')

    expect(await canonicalWorkspace(alias)).toBe(root)
    expect(await resolveWorkspacePath(alias, 'new/file.md', { mustExist: false }))
      .toBe(path.join(root, 'new', 'file.md'))
  })

  it('rejects existing and create-target symlink escapes', async () => {
    const root = await temporaryDirectory()
    const outside = await temporaryDirectory('dsh-alphasolve-outside-')
    await writeFile(path.join(outside, 'secret.md'), 'secret')
    await symlink(path.join(outside, 'secret.md'), path.join(root, 'problem.md'))
    await symlink(outside, path.join(root, 'escape'), 'dir')

    await expect(readWorkspaceInput(root, 'problem.md', { nonEmpty: true }))
      .rejects.toThrow(/symlink resolves outside/)
    await expect(resolveWorkspacePath(root, 'escape/new.md', { mustExist: false }))
      .rejects.toThrow(/ancestry resolves outside/)
  })
})

describe('workspace inputs and initialization', () => {
  it('snapshots strict UTF-8 inputs, digests, and solution presence', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'problem.md'), 'Prove x = x.\n')
    await writeFile(path.join(root, 'hint.md'), 'Use reflexivity.\n')
    await writeFile(path.join(root, 'solution.md'), 'old solution\n')

    const snapshot = await snapshotWorkspace(root)
    expect(snapshot.root).toBe(root)
    expect(snapshot.problem.digest).toBe(digestText('Prove x = x.\n'))
    expect(snapshot.hint?.content).toBe('Use reflexivity.\n')
    expect(snapshot.solutionExists).toBe(true)
  })

  it('fails closed on empty or invalid UTF-8 problem files', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'problem.md'), ' \n\t')
    await expect(snapshotWorkspace(root)).rejects.toThrow(/input file is empty/)

    await writeFile(path.join(root, 'problem.md'), Uint8Array.from([0xc3, 0x28]))
    await expect(snapshotWorkspace(root)).rejects.toThrow(/not valid UTF-8/)
  })

  it('creates the skeleton non-destructively and reports directory conflicts', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'problem.md'), 'problem')
    await mkdir(path.join(root, 'knowledge'))
    await writeFile(path.join(root, 'knowledge', 'index.md'), '# Human Index\n')
    await initializeWorkspace(root)
    expect(await readFile(path.join(root, 'knowledge', 'index.md'), 'utf8')).toBe('# Human Index\n')

    const conflict = await temporaryDirectory()
    await writeFile(path.join(conflict, 'knowledge'), 'not a directory')
    await expect(initializeWorkspace(conflict)).rejects.toThrow(/initialize workspace directory/)
  })

  it('backs up a solution and detects external proposition edits', async () => {
    const root = await temporaryDirectory()
    await writeFile(path.join(root, 'problem.md'), 'problem')
    await initializeWorkspace(root)
    await writeFile(path.join(root, 'solution.md'), 'old solution')

    const backup = await backupSolution(root, new Date('2026-01-02T03:04:05.000Z'))
    expect(backup).toMatch(/^\.alphasolve\/backups\/solution-2026-01-02T03-04-05-000Z-/)
    expect(await readFile(path.join(root, backup ?? ''), 'utf8')).toBe('old solution')

    const proposition = 'unverified_propositions/proposition.md'
    await writeFile(path.join(root, proposition), 'version one')
    const stamp = await captureFileStamp(root, proposition)
    await assertFileStamp(root, proposition, stamp)
    await writeFile(path.join(root, proposition), 'version two')
    await expect(assertFileStamp(root, proposition, stamp)).rejects.toThrow(/changed outside/)
  })
})
