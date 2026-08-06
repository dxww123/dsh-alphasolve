import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createResearchReviewTools,
  RESEARCH_PROGRESS_CHARACTER_BUDGET,
  RESEARCH_PROGRESS_DEFAULT_CANDIDATES,
} from '../src/research-tools.js'
import { initializeWorkspace } from '../src/workspace.js'

const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-research-tools-'))
  roots.push(root)
  await initializeWorkspace(root)
  await Promise.all([
    writeFile(path.join(root, 'problem.md'), '# Problem\n\nDetermine the target.\n'),
    writeFile(path.join(root, 'verified_propositions', 'bound.md'), [
      '# Bound', '## Statement', 'The target is at least 3.', '',
      '## Proof', 'A calculation proves the bound.', 'Therefore the target is strictly positive.', '',
    ].join('\n')),
    writeFile(path.join(root, 'knowledge', 'route.md'), '# Route\n\n## Remaining Gap\nJoin the bounds.\n'),
    writeFile(path.join(root, 'unverified_propositions', 'secret.md'), '# Unverified\n'),
  ])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('research-review Markdown tools', () => {
  it('builds a deterministic map from only problem, knowledge, and verified Markdown', async () => {
    const root = await fixture()
    const tools = await createResearchReviewTools(root)
    const result = await tools.progressReview()

    expect(result.files.map(file => file.path)).toEqual(expect.arrayContaining([
      'problem.md',
      'knowledge/route.md',
      'verified_propositions/bound.md',
    ]))
    expect(result.files.some(file => file.path.includes('unverified_propositions'))).toBe(false)
    expect(result.suggestedInspectionPaths[0]).toBe('problem.md')
  })

  it('surfaces headings, a statement/progress section, and the proof tail', async () => {
    const root = await fixture()
    const tools = await createResearchReviewTools(root)
    const result = await tools.inspectMarkdown('verified_propositions/bound.md')

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({
      path: 'verified_propositions/bound.md',
      headings: expect.arrayContaining(['## Statement', '## Proof']),
      statementOrProgress: expect.stringContaining('The target is at least 3.'),
      tail: expect.stringContaining('strictly positive'),
    })
  })

  it('uses authoritative Statements and ranks problem-focused proof tails and gaps first', async () => {
    const root = await fixture()
    await Promise.all([
      writeFile(path.join(root, 'verified_propositions', 'aaa-local.md'), [
        '# Local Note',
        '## Statement',
        'An unrelated auxiliary estimate holds.',
        '## Proof',
        'A routine calculation finishes the estimate.',
      ].join('\n')),
      writeFile(path.join(root, 'verified_propositions', 'zzz-target.md'), [
        '# Early Progress',
        'A speculative target route was considered.',
        '## Statement',
        'The target has exact value 7.',
        '## Proof',
        'The upper and lower target bounds meet.',
        'Therefore the exact target value is 7.',
      ].join('\n')),
      writeFile(path.join(root, 'knowledge', 'aaa-background.md'), [
        '# Background',
        'A general side observation.',
      ].join('\n')),
      writeFile(path.join(root, 'knowledge', 'zzz-global-gap.md'), [
        '# Route Status',
        '## Remaining Gap',
        'The unresolved blocker is to join the target bounds.',
      ].join('\n')),
    ])
    const tools = await createResearchReviewTools(root)
    const result = await tools.progressReview()
    const paths = result.files.map(file => file.path)

    expect(paths[0]).toBe('problem.md')
    expect(paths.indexOf('verified_propositions/zzz-target.md'))
      .toBeLessThan(paths.indexOf('verified_propositions/aaa-local.md'))
    expect(paths.indexOf('knowledge/zzz-global-gap.md'))
      .toBeLessThan(paths.indexOf('knowledge/aaa-background.md'))
    const target = result.files.find(file => file.path === 'verified_propositions/zzz-target.md')
    expect(target?.statementOrProgress).toContain('## Statement')
    expect(target?.statementOrProgress).toContain('exact value 7')
    expect(target?.statementOrProgress).not.toContain('speculative target route')
    expect(target?.tail).toContain('Therefore the exact target value is 7.')
    expect(result.files.find(file => file.path === 'knowledge/zzz-global-gap.md')?.statementOrProgress)
      .toContain('unresolved blocker')
  })

  it('returns a bounded 10-20 candidate map for a large workspace', async () => {
    const root = await fixture()
    const longProof = Array.from({ length: 80 }, (_value, index) => (
      `Proof detail ${index}: this line deliberately carries substantial context that must not all reach the reviewer.`
    )).join('\n')
    await Promise.all(Array.from({ length: 260 }, async (_value, index) => {
      const number = String(index).padStart(3, '0')
      if (index % 2 === 0) {
        await writeFile(path.join(root, 'verified_propositions', `candidate-${number}.md`), [
          `# Candidate ${number}`,
          '## Statement',
          `The target candidate ${number} provides a certified bound.`,
          '## Proof',
          longProof,
          `Therefore target candidate ${number} is proved.`,
        ].join('\n'))
      } else {
        await writeFile(path.join(root, 'knowledge', `route-${number}.md`), [
          `# Route ${number}`,
          '## Remaining Gap',
          `The unresolved target blocker for route ${number} remains.`,
          longProof,
        ].join('\n'))
      }
    }))
    const tools = await createResearchReviewTools(root)
    const result = await tools.progressReview()

    expect(result.scanned).toBe(200)
    expect(result.truncated).toBe(true)
    expect(result.files.length).toBeGreaterThanOrEqual(10)
    expect(result.files.length).toBeLessThanOrEqual(RESEARCH_PROGRESS_DEFAULT_CANDIDATES)
    expect(result.files.some(file => file.path.startsWith('verified_propositions/'))).toBe(true)
    expect(result.files.some(file => file.path.startsWith('knowledge/'))).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESEARCH_PROGRESS_CHARACTER_BUDGET)
    expect(Object.keys(result).sort()).toEqual([
      'files',
      'scanned',
      'suggestedInspectionPaths',
      'truncated',
    ])
    expect(Object.keys(result.files[0] ?? {}).sort()).toEqual([
      'headings',
      'path',
      'statementOrProgress',
      'tail',
      'totalLines',
    ])
    expect(result.suggestedInspectionPaths.every(suggested => (
      result.files.some(file => file.path === suggested)
    ))).toBe(true)
  })

  it('treats maxFiles as a scan cap while retaining the global output budget', async () => {
    const root = await fixture()
    const tools = await createResearchReviewTools(root)
    const result = await tools.progressReview({ maxFiles: 3 })

    expect(result.scanned).toBe(3)
    expect(result.files).toHaveLength(3)
    expect(result.files[0]?.path).toBe('problem.md')
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESEARCH_PROGRESS_CHARACTER_BUDGET)
  })

  it('rejects unverified, parent, and symlink escape paths', async () => {
    const root = await fixture()
    const tools = await createResearchReviewTools(root)
    await expect(tools.progressReview({ paths: ['unverified_propositions/secret.md'] }))
      .rejects.toThrow(/restricted/)
    await expect(tools.inspectMarkdown('../problem.md')).rejects.toThrow()

    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-research-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'outside.md'), '# Outside\n')
    await symlink(path.join(outside, 'outside.md'), path.join(root, 'knowledge', 'escape.md'))
    await expect(tools.inspectMarkdown('knowledge/escape.md')).rejects.toThrow()
  })
})
