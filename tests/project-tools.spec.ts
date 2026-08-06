import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { atomicWriteText } from '../src/atomic.js'
import { ProjectTools } from '../src/project-tools.js'
import { initializeWorkspace } from '../src/workspace.js'

const temporaryRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-project-tools-'))
  temporaryRoots.push(root)
  await initializeWorkspace(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('orchestrator project tools', () => {
  it('creates only valid verified-proposition topic directory chains', async () => {
    const root = await workspace()
    const tools = await ProjectTools.create(root)

    await expect(tools.mkdir('problem-material/archive')).rejects.toThrow(/verified_propositions/)
    await expect(tools.mkdir('knowledge/topics/algebra')).rejects.toThrow(/verified_propositions/)
    await expect(tools.mkdir('verified_propositions/not allowed')).rejects.toThrow(/AlphaSolve path names/)
    expect(await tools.mkdir('verified_propositions/number-theory/lifting')).toEqual({
      path: 'verified_propositions/number-theory/lifting',
    })
    expect(await tools.mkdir('verified_propositions/number-theory/lifting')).toEqual({
      path: 'verified_propositions/number-theory/lifting',
    })
    expect((await readFile(path.join(root, 'knowledge', 'index.md'), 'utf8'))).toContain('Knowledge Index')
  })

  it('renames in place and moves verified Markdown while preserving the file name', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'verified_propositions', 'topic'))
    await writeFile(path.join(root, 'verified_propositions', 'note.md'), 'note')
    await writeFile(path.join(root, 'verified_propositions', 'taken.md'), 'taken')
    const tools = await ProjectTools.create(root)

    await expect(tools.rename('verified_propositions', 'note.md', 'taken.md')).rejects.toThrow(/already exists/)
    expect(await tools.rename('verified_propositions', 'note.md', 'renamed.md')).toMatchObject({
      oldPath: 'verified_propositions/note.md',
      path: 'verified_propositions/renamed.md',
    })
    expect(await tools.moveInto('verified_propositions/renamed.md', 'verified_propositions/topic')).toMatchObject({
      oldPath: 'verified_propositions/renamed.md',
      path: 'verified_propositions/topic/renamed.md',
    })
    await expect(tools.rename('verified_propositions', 'index.md', 'old-index.md')).rejects.toThrow(/index/)
    await expect(tools.rename('verified_propositions', 'taken.md', 'index.md')).rejects.toThrow(/index/)
    await expect(tools.moveInto('verified_propositions/index.md', 'verified_propositions/topic'))
      .rejects.toThrow(/index/)
    await expect(tools.moveInto('knowledge/index.md', 'verified_propositions/topic'))
      .rejects.toThrow(/verified_propositions/)
    await expect(tools.rename('knowledge', 'note.md', 'renamed.md'))
      .rejects.toThrow(/verified_propositions/)
    expect(await readFile(path.join(root, 'verified_propositions', 'topic', 'renamed.md'), 'utf8')).toBe('note')
  })

  it('rejects existing and missing paths whose ancestry uses a symlink', async () => {
    const root = await workspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-project-tools-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'outside.md'), 'outside')
    await symlink(outside, path.join(root, 'verified_propositions', 'escape'), 'dir')
    const tools = await ProjectTools.create(root)

    await expect(tools.mkdir('verified_propositions/escape/new')).rejects.toThrow(/symbolic links/)
    await expect(tools.moveInto('verified_propositions/escape/outside.md', 'verified_propositions'))
      .rejects.toThrow(/symbolic links/)
    expect(await readFile(path.join(outside, 'outside.md'), 'utf8')).toBe('outside')
  })

  it('updates slash and backslash proposition references when a verified file moves', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'verified_propositions', 'lemmas'))
    await mkdir(path.join(root, 'verified_propositions', 'archive'))
    await writeFile(
      path.join(root, 'verified_propositions', 'lemmas', 'order.md'),
      '# Order lemma\n',
    )
    await writeFile(
      path.join(root, 'verified_propositions', 'consumer-a.md'),
      'Uses \\ref{lemmas/order}.\n',
    )
    await writeFile(
      path.join(root, 'verified_propositions', 'consumer-b.md'),
      'Also uses \\ref{lemmas\\order}.\n',
    )
    const tools = await ProjectTools.create(root)

    await tools.rename('verified_propositions/lemmas', 'order.md', 'renamed-order.md')
    const result = await tools.moveInto(
      'verified_propositions/lemmas/renamed-order.md',
      'verified_propositions/archive',
    )
    expect(result).toEqual({
      oldPath: 'verified_propositions/lemmas/renamed-order.md',
      path: 'verified_propositions/archive/renamed-order.md',
      updatedReferenceFiles: 2,
    })
    expect(await readFile(path.join(root, 'verified_propositions', 'consumer-a.md'), 'utf8'))
      .toBe('Uses \\ref{archive\\renamed-order}.\n')
    expect(await readFile(path.join(root, 'verified_propositions', 'consumer-b.md'), 'utf8'))
      .toBe('Also uses \\ref{archive\\renamed-order}.\n')
    await expect(readFile(path.join(root, 'verified_propositions', 'lemmas', 'order.md')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(root, 'verified_propositions', 'archive', 'renamed-order.md'), 'utf8'))
      .toBe('# Order lemma\n')
  })

  it('updates the complete reference mapping when a verified directory is renamed', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'verified_propositions', 'old-topic', 'nested'), { recursive: true })
    await writeFile(path.join(root, 'verified_propositions', 'old-topic', 'a.md'), '# A\n')
    await writeFile(path.join(root, 'verified_propositions', 'old-topic', 'nested', 'b.md'), '# B\n')
    await writeFile(
      path.join(root, 'verified_propositions', 'consumer.md'),
      '\\ref{old-topic/a} and \\ref{old-topic\\nested\\b}\n',
    )
    const tools = await ProjectTools.create(root)

    const result = await tools.rename('verified_propositions', 'old-topic', 'new-topic')
    expect(result.updatedReferenceFiles).toBe(1)
    expect(await readFile(path.join(root, 'verified_propositions', 'consumer.md'), 'utf8'))
      .toBe('\\ref{new-topic\\a} and \\ref{new-topic\\nested\\b}\n')
    expect(await readFile(path.join(root, 'verified_propositions', 'new-topic', 'nested', 'b.md'), 'utf8'))
      .toBe('# B\n')
  })

  it('rolls back both the path and every changed reference if an atomic update fails', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'verified_propositions', 'source'))
    await mkdir(path.join(root, 'verified_propositions', 'target'))
    await writeFile(path.join(root, 'verified_propositions', 'source', 'lemma.md'), '# Lemma\n')
    const referenceA = path.join(root, 'verified_propositions', 'a.md')
    const referenceB = path.join(root, 'verified_propositions', 'b.md')
    await writeFile(referenceA, '\\ref{source/lemma}\n')
    await writeFile(referenceB, '\\ref{source/lemma}\n')
    let writes = 0
    let failed = false
    const tools = await ProjectTools.create(root, {
      writeText: async (file, content) => {
        writes += 1
        if (writes === 2 && !failed) {
          failed = true
          throw new Error('injected write failure')
        }
        await atomicWriteText(file, content)
      },
    })

    await expect(tools.moveInto(
      'verified_propositions/source/lemma.md',
      'verified_propositions/target',
    )).rejects.toThrow(/rolled back/)
    expect(await readFile(path.join(root, 'verified_propositions', 'source', 'lemma.md'), 'utf8')).toBe('# Lemma\n')
    await expect(readFile(path.join(root, 'verified_propositions', 'target', 'lemma.md')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(referenceA, 'utf8')).toBe('\\ref{source/lemma}\n')
    expect(await readFile(referenceB, 'utf8')).toBe('\\ref{source/lemma}\n')
  })

  it('does not overwrite a reference file changed concurrently during a move', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'verified_propositions', 'source'))
    await mkdir(path.join(root, 'verified_propositions', 'target'))
    await writeFile(path.join(root, 'verified_propositions', 'source', 'lemma.md'), '# Lemma\n')
    const referenceA = path.join(root, 'verified_propositions', 'a.md')
    const referenceB = path.join(root, 'verified_propositions', 'b.md')
    await writeFile(referenceA, '\\ref{source/lemma}\n')
    await writeFile(referenceB, '\\ref{source/lemma}\n')
    let writes = 0
    const tools = await ProjectTools.create(root, {
      writeText: async (file, content) => {
        await atomicWriteText(file, content)
        writes += 1
        if (writes === 1) await writeFile(referenceB, 'external edit\n')
      },
    })

    await expect(tools.moveInto(
      'verified_propositions/source/lemma.md',
      'verified_propositions/target',
    )).rejects.toThrow(/rolled back/)
    expect(await readFile(referenceA, 'utf8')).toBe('\\ref{source/lemma}\n')
    expect(await readFile(referenceB, 'utf8')).toBe('external edit\n')
    expect(await readFile(path.join(root, 'verified_propositions', 'source', 'lemma.md'), 'utf8')).toBe('# Lemma\n')
  })

  it('fails before moving if verified reference traversal encounters a symlink escape', async () => {
    const root = await workspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-verified-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'outside.md'), '\\ref{x}\n')
    await writeFile(path.join(root, 'verified_propositions', 'lemma.md'), '# Lemma\n')
    await symlink(path.join(outside, 'outside.md'), path.join(root, 'verified_propositions', 'alias.md'))
    const tools = await ProjectTools.create(root)

    await expect(tools.rename(
      'verified_propositions',
      'lemma.md',
      'renamed.md',
    )).rejects.toThrow(/escapes verified/)
    expect(await readFile(path.join(root, 'verified_propositions', 'lemma.md'), 'utf8')).toBe('# Lemma\n')
    await expect(readFile(path.join(root, 'verified_propositions', 'renamed.md')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
