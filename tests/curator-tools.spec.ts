import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CuratorKnowledgeTools } from '../src/curator-tools.js'
import { initializeWorkspace } from '../src/workspace.js'

const temporaryRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-curator-tools-'))
  temporaryRoots.push(root)
  await initializeWorkspace(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('curator knowledge tools', () => {
  it('keeps references read-only except for exact, non-destructive line splitting', async () => {
    const root = await workspace()
    const source = path.join(root, 'knowledge', 'references', 'source.md')
    const original = 'A\r\nB\nC'
    await writeFile(source, original)
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    await expect(tools.write('knowledge/references/new.md', 'no')).rejects.toThrow(/read-only/)
    await expect(tools.edit('knowledge/references/source.md', 'A', 'X')).rejects.toThrow(/read-only/)
    await expect(tools.delete('knowledge/references/source.md')).rejects.toThrow(/read-only/)
    await expect(tools.mkdir('knowledge/references/new-directory')).rejects.toThrow(/read-only/)

    const split = await tools.splitReference('knowledge/references/source.md', [
      { path: 'knowledge/references/part-1.md', startLine: 1, endLine: 2 },
      { path: 'knowledge/references/part-2.md', startLine: 3, endLine: 3 },
    ])
    expect(split.paths).toEqual([
      'knowledge/references/part-1.md',
      'knowledge/references/part-2.md',
    ])
    expect(await readFile(path.join(root, 'knowledge', 'references', 'part-1.md'), 'utf8')).toBe('A\r\nB\n')
    expect(await readFile(path.join(root, 'knowledge', 'references', 'part-2.md'), 'utf8')).toBe('C')
    expect(await readFile(source, 'utf8')).toBe(original)
    await tools.finalizeMetadata()
    expect(await readFile(path.join(root, 'knowledge', 'references', 'part-1.md'), 'utf8')).toBe('A\r\nB\n')

    await expect(tools.splitReference('knowledge/references/source.md', [
      { path: 'knowledge/outside.md', startLine: 1, endLine: 1 },
    ])).rejects.toThrow(/must stay below/)
    await expect(tools.splitReference('knowledge/references/source.md', [
      { path: 'knowledge/references/part-1.md', startLine: 1, endLine: 1 },
    ])).rejects.toThrow(/already exists/)
  })

  it('prevents moving content into or out of references, including through an alias', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'knowledge', 'note.md'), 'note')
    await writeFile(path.join(root, 'knowledge', 'references', 'paper.md'), 'paper')
    await symlink('references', path.join(root, 'knowledge', 'reference-alias'), 'dir')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    await expect(tools.move('knowledge/note.md', 'knowledge/references')).rejects.toThrow(/read-only/)
    await expect(tools.move('knowledge/references/paper.md', 'knowledge')).rejects.toThrow(/read-only/)
    await expect(tools.write('knowledge/reference-alias/new.md', 'no')).rejects.toThrow(/read-only/)
    await expect(tools.rename('knowledge/reference-alias', 'paper.md', 'renamed.md')).rejects.toThrow(/read-only/)
  })

  it('protects index/common-errors and gates common-error updates by task kind', async () => {
    const root = await workspace()
    const digest = await CuratorKnowledgeTools.create(root, 'digest')
    await expect(digest.write('knowledge/common-errors.md', '# changed')).rejects.toThrow(/verifier-final/)
    await expect(digest.edit('knowledge/common-errors.md', 'Common', 'Known')).rejects.toThrow(/verifier-final/)
    await expect(digest.delete('knowledge/index.md')).rejects.toThrow(/protected/)
    await expect(digest.rename('knowledge', 'index.md', 'old-index.md')).rejects.toThrow(/protected/)
    await expect(digest.rename('knowledge', 'notes.md', 'index.md')).rejects.toThrow(/protected/)

    const verifierFinal = await CuratorKnowledgeTools.create(root, 'verifier_final')
    await verifierFinal.read('knowledge/common-errors.md')
    await verifierFinal.write('knowledge/common-errors.md', '# Common Errors\n\n- missed premise\n')
    expect(await readFile(path.join(root, 'knowledge', 'common-errors.md'), 'utf8')).toContain('missed premise')
  })

  it('uses non-recursive deletion and fails rename/move conflicts', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'knowledge', 'topic'))
    await writeFile(path.join(root, 'knowledge', 'topic', 'note.md'), 'note')
    await writeFile(path.join(root, 'knowledge', 'a.md'), 'a')
    await writeFile(path.join(root, 'knowledge', 'b.md'), 'b')
    await mkdir(path.join(root, 'knowledge', 'destination'))
    await writeFile(path.join(root, 'knowledge', 'destination', 'a.md'), 'conflict')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    await expect(tools.delete('knowledge/topic')).rejects.toThrow(/must be empty/)
    await expect(tools.rename('knowledge', 'a.md', 'b.md')).rejects.toThrow(/already exists/)
    await expect(tools.move('knowledge/a.md', 'knowledge/destination')).rejects.toThrow(/already exists/)
    expect(await readFile(path.join(root, 'knowledge', 'a.md'), 'utf8')).toBe('a')

    await tools.delete('knowledge/topic/note.md')
    await tools.delete('knowledge/topic')
    await expect(readFile(path.join(root, 'knowledge', 'topic', 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects symlink escapes for existing reads and not-yet-created writes', async () => {
    const root = await workspace()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-curator-outside-'))
    temporaryRoots.push(outside)
    await writeFile(path.join(outside, 'secret.md'), 'secret')
    await symlink(outside, path.join(root, 'knowledge', 'escape'), 'dir')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    await expect(tools.read('knowledge/escape/secret.md')).rejects.toThrow(/outside knowledge/)
    await expect(tools.write('knowledge/escape/new.md', 'no')).rejects.toThrow(/outside knowledge/)
  })

  it('provides bounded read/list/glob/grep operations without a shell', async () => {
    const root = await workspace()
    await mkdir(path.join(root, 'knowledge', 'topic'))
    await writeFile(path.join(root, 'knowledge', 'topic', 'lemma.md'), 'first\nUseful Lemma\nlast\n')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    expect((await tools.read('knowledge/topic/lemma.md', { startLine: 2, endLine: 2 })).content)
      .toBe('Useful Lemma\n')
    expect(await tools.glob('knowledge/**/*.md')).toContain('knowledge/topic/lemma.md')
    expect(await tools.grep('useful', { caseSensitive: false })).toContainEqual({
      path: 'knowledge/topic/lemma.md',
      line: 2,
      text: 'Useful Lemma',
    })
    expect((await tools.list('knowledge/topic')).map(entry => entry.path))
      .toEqual(['knowledge/topic/lemma.md'])
    await expect(tools.read('../problem.md')).rejects.toThrow(/parent component/)
  })

  it('caps requested read ranges at EOF and reports the actual range', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'knowledge', 'short.md'), 'first\nsecond\nthird\n')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    for (const endLine of [40, 60, 100]) {
      await expect(tools.read('knowledge/short.md', { startLine: 1, endLine })).resolves.toEqual({
        path: 'knowledge/short.md', content: 'first\nsecond\nthird\n',
        startLine: 1, endLine: 3, totalLines: 3,
      })
    }
    await expect(tools.read('knowledge/short.md', { startLine: 2, endLine: 100 })).resolves.toMatchObject({
      content: 'second\nthird\n', startLine: 2, endLine: 3, totalLines: 3,
    })
    for (const range of [
      { startLine: 0, endLine: 100 }, { startLine: 4, endLine: 100 },
      { startLine: 2, endLine: 1 }, { startLine: 1, endLine: 1.5 },
    ]) {
      await expect(tools.read('knowledge/short.md', range)).rejects.toThrow(/invalid inclusive line range/)
    }
    await writeFile(path.join(root, 'knowledge', 'empty.md'), '')
    await expect(tools.read('knowledge/empty.md')).resolves.toMatchObject({
      content: '', startLine: 0, endLine: 0, totalLines: 0,
    })
    await expect(tools.read('knowledge/empty.md', { startLine: 1, endLine: 100 })).rejects.toThrow(/invalid inclusive line range/)
  })

  it('scopes dot discovery to knowledge without exposing the workspace root', async () => {
    const root = await workspace()
    await writeFile(path.join(root, 'problem.md'), 'private search marker')
    await writeFile(path.join(root, 'knowledge', 'note.md'), 'visible search marker')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    for (const discoveryPath of ['.', './', '.\\']) {
      expect(await tools.list(discoveryPath)).toEqual(await tools.list('knowledge'))
      expect(await tools.grep('search marker', { path: discoveryPath })).toEqual([
        { path: 'knowledge/note.md', line: 1, text: 'visible search marker' },
      ])
    }
    await expect(tools.list('../')).rejects.toThrow(/parent component/)
    await expect(tools.grep('search marker', { path: '..' })).rejects.toThrow(/parent component/)
    await expect(tools.read('index.md')).rejects.toThrow(/knowledge\/index\.md/)
    await expect(tools.glob('**/*.md')).rejects.toThrow(/knowledge\/\*\*\/\*\.md/)
    await expect(tools.write('problem.md', 'no')).rejects.toThrow(/workspace-relative path beginning with knowledge/)
    await expect(readFile(path.join(root, 'problem.md'), 'utf8')).resolves.toBe('private search marker')
  })

  it('preserves DSH read-before-write and stale-observation semantics', async () => {
    const root = await workspace()
    const file = path.join(root, 'knowledge', 'observed.md')
    await writeFile(file, 'original\n')
    const tools = await CuratorKnowledgeTools.create(root, 'digest')

    await expect(tools.write('knowledge/observed.md', 'blind\n')).rejects.toThrow(/must be read/)
    await tools.read('knowledge/observed.md')
    await writeFile(file, 'external change\n')
    await expect(tools.write('knowledge/observed.md', 'stale\n')).rejects.toThrow(/changed since/)
    expect(await readFile(file, 'utf8')).toBe('external change\n')

    await tools.read('knowledge/observed.md')
    await tools.edit('knowledge/observed.md', 'external', 'reviewed')
    await tools.write('knowledge/observed.md', 'reviewed again\n')
    expect(await readFile(file, 'utf8')).toBe('reviewed again\n')

    await tools.write('knowledge/nested/topic/new.md', 'new\n')
    expect(await readFile(path.join(root, 'knowledge', 'nested', 'topic', 'new.md'), 'utf8')).toBe('new\n')
  })

  it('adds system-owned modification_count metadata once per successful curator task', async () => {
    const root = await workspace()
    const file = path.join(root, 'knowledge', 'entry.md')
    const first = await CuratorKnowledgeTools.create(root, 'digest')
    await first.write('knowledge/entry.md', '# Entry\n')
    await first.finalizeMetadata()
    await first.finalizeMetadata()
    expect(await readFile(file, 'utf8')).toBe(
      '---\nmodification_count: 1\n---\n# Entry\n',
    )

    const second = await CuratorKnowledgeTools.create(root, 'digest')
    await second.read('knowledge/entry.md')
    await second.edit('knowledge/entry.md', '# Entry', '# Revised Entry')
    await second.finalizeMetadata()
    expect(await readFile(file, 'utf8')).toBe(
      '---\nmodification_count: 2\n---\n# Revised Entry\n',
    )
  })

  it('recovers a prepared mutation by comparing its durable before and after digests', async () => {
    const root = await workspace()
    const taskId = 'prepared-write'
    const first = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await first.write('knowledge/prepared.md', '# Prepared\n')
    const journalDirectory = path.join(root, '.alphasolve', 'curator', 'mutations')
    const [journalName] = await readdir(journalDirectory)
    if (journalName === undefined) throw new Error('missing mutation journal')
    const journalPath = path.join(journalDirectory, journalName)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ status: 'prepared' | 'applied' }>
    }
    const operation = journal.operations[0]
    if (operation === undefined) throw new Error('missing mutation operation')
    operation.status = 'prepared'
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`)

    const replay = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    expect(await replay.write('knowledge/prepared.md', '# Prepared\n')).toEqual({
      path: 'knowledge/prepared.md',
    })
    const recovered = JSON.parse(await readFile(journalPath, 'utf8')) as {
      operations: Array<{ status: string }>
    }
    expect(recovered.operations[0]?.status).toBe('applied')
    expect(await readFile(path.join(root, 'knowledge', 'prepared.md'), 'utf8')).toBe('# Prepared\n')
  })

  it('reports a replay conflict instead of blindly repeating a mutation', async () => {
    const root = await workspace()
    const taskId = 'conflicting-write'
    const first = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await first.write('knowledge/conflict.md', 'first\n')
    await writeFile(path.join(root, 'knowledge', 'conflict.md'), 'external\n')

    const replay = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await expect(replay.write('knowledge/conflict.md', 'first\n')).rejects.toThrow(/conflicts/)
    expect(await readFile(path.join(root, 'knowledge', 'conflict.md'), 'utf8')).toBe('external\n')
  })

  it('allows an applied directory operation to be superseded by its durable child operations', async () => {
    const root = await workspace()
    const taskId = 'directory-and-child'
    const first = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await first.mkdir('knowledge/topic')
    await first.write('knowledge/topic/entry.md', '# Entry\n')
    await first.finalizeMetadata()

    const replay = await CuratorKnowledgeTools.create(root, 'digest', taskId)
    await replay.mkdir('knowledge/topic')
    await replay.write('knowledge/topic/entry.md', '# Entry\n')
    await replay.finalizeMetadata()
    expect(await readFile(path.join(root, 'knowledge', 'topic', 'entry.md'), 'utf8')).toBe(
      '---\nmodification_count: 1\n---\n# Entry\n',
    )
  })

  it('fails closed for unknown journal fields and symlinked journal files', async () => {
    const rootWithUnknown = await workspace()
    const taskId = 'unknown-journal-field'
    await CuratorKnowledgeTools.create(rootWithUnknown, 'digest', taskId)
    const mutationDirectory = path.join(rootWithUnknown, '.alphasolve', 'curator', 'mutations')
    const [journalName] = await readdir(mutationDirectory)
    if (journalName === undefined) throw new Error('missing mutation journal')
    const journalPath = path.join(mutationDirectory, journalName)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>
    journal.unexpected = true
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`)
    await expect(CuratorKnowledgeTools.create(rootWithUnknown, 'digest', taskId))
      .rejects.toThrow(/invalid curator mutation journal/)

    const rootWithSymlink = await workspace()
    const symlinkTaskId = 'symlink-journal'
    await CuratorKnowledgeTools.create(rootWithSymlink, 'digest', symlinkTaskId)
    const symlinkDirectory = path.join(rootWithSymlink, '.alphasolve', 'curator', 'mutations')
    const [symlinkJournalName] = await readdir(symlinkDirectory)
    if (symlinkJournalName === undefined) throw new Error('missing mutation journal')
    const symlinkJournalPath = path.join(symlinkDirectory, symlinkJournalName)
    const outside = path.join(rootWithSymlink, 'outside-journal.json')
    await writeFile(outside, await readFile(symlinkJournalPath, 'utf8'))
    await rm(symlinkJournalPath)
    await symlink(outside, symlinkJournalPath)
    await expect(CuratorKnowledgeTools.create(rootWithSymlink, 'digest', symlinkTaskId))
      .rejects.toThrow(/ordinary file/)
  })
})
