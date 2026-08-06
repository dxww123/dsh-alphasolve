import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_VERIFY_ROUNDS,
  THEOREM_CHECK_ATTEMPTS,
  runFixedWorkerWorkflow,
  type RoleInvocation,
  type RoleInvoker,
} from '../src/workflow.js'
import type { WorkerExecutionContext } from '../src/worker-manager.js'
import type { WorkerRecord } from '../src/types.js'

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-alphasolve-workflow-'))
  try {
    await Promise.all([
      mkdir(path.join(workspace, 'knowledge', 'references'), { recursive: true }),
      mkdir(path.join(workspace, 'unverified_propositions'), { recursive: true }),
      mkdir(path.join(workspace, 'verified_propositions'), { recursive: true }),
      mkdir(path.join(workspace, '.alphasolve', 'tmp'), { recursive: true }),
    ])
    await writeFile(path.join(workspace, 'problem.md'), 'Prove the requested statement.\n')
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

interface TestContext {
  readonly context: WorkerExecutionContext
  readonly progress: Partial<WorkerRecord>[]
  readonly events: string[]
}

function makeContext(options: {
  claim?: boolean
  onAssert?: () => void | Promise<void>
} = {}): TestContext {
  const progress: Partial<WorkerRecord>[] = []
  const events: string[] = []
  return {
    progress,
    events,
    context: {
      id: 'abc12345',
      instruction: 'Explore a useful exact statement.',
      signal: new AbortController().signal,
      problemDigest: 'problem-digest',
      progress: async (update) => {
        progress.push(update)
        events.push(`progress:${String(update.phase ?? 'data')}`)
      },
      assertInputsCurrent: async () => {
        events.push('assert')
        await options.onAssert?.()
      },
      claimSolvedWinner: async () => {
        events.push('claim')
        return options.claim ?? false
      },
    },
  }
}

function isVerifier(role: RoleInvocation['role']): boolean {
  return role.startsWith('verifier_')
}

describe('fixed worker workflow', () => {
  it('runs all five profiles with independent judges, then promotes a non-solved proposition', async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, 'verified_propositions', 'existing.md'), '## Statement\n\nExisting.\n')
      const calls: RoleInvocation[] = []
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nUseful lemma.\n\n## Proof\n\nComplete proof.\n')
            return { text: 'generated' }
          }
          if (isVerifier(request.role)) return { text: `Review from ${request.role}: Verdict: pass` }
          if (request.role === 'review_verdict_judge') return { text: 'pass' }
          if (request.role === 'theorem_checker') {
            expect(request.cwd).toBe(request.theoremViewDirectory)
            expect(await readFile(path.join(request.cwd, 'verified_propositions', 'existing.md'), 'utf8'))
              .toContain('Existing')
            expect(await readFile(path.join(request.cwd, 'verified_propositions', 'useful-lemma.md'), 'utf8'))
              .toContain('Useful lemma')
            return { text: 'Solves original problem: no' }
          }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const test = makeContext()
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'useful-lemma',
      }, test.context)

      expect(result).toMatchObject({
        status: 'verified',
        producedVerifiedProposition: true,
        solved: false,
        propositionPath: 'verified_propositions/useful-lemma.md',
        statement: 'Useful lemma.',
      })
      expect(await readFile(path.join(workspace, 'verified_propositions', 'useful-lemma.md'), 'utf8'))
        .toContain('Complete proof')
      expect(calls.map(call => call.role)).toEqual([
        'generator',
        'verifier_format_references', 'review_verdict_judge',
        'verifier_citation', 'review_verdict_judge',
        'verifier_failure_modes', 'review_verdict_judge',
        'verifier_stepwise', 'review_verdict_judge',
        'verifier_premise_chain', 'review_verdict_judge',
        'theorem_checker',
      ])
      for (const call of calls.filter(call => isVerifier(call.role))) {
        expect(call.task).not.toContain('Prove the requested statement.')
        expect(call.task).toContain('Judge only defects in this candidate')
      }
      expect(calls.find(call => call.role === 'theorem_checker')?.task)
        .toContain('Prove the requested statement.')
      expect(test.events).not.toContain('claim')
    })
  })

  it('fails the worker directly on a verifier infrastructure exception without revising', async () => {
    await withWorkspace(async (workspace) => {
      const calls: RoleInvocation[] = []
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nDraft.\n\n## Proof\n\nDraft proof.\n')
            return { text: 'generated' }
          }
          if (request.role === 'verifier_format_references') {
            throw new Error('verifier transport failed')
          }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
      }, makeContext().context)

      expect(result).toMatchObject({
        status: 'failed',
        producedVerifiedProposition: false,
        solved: false,
        statement: 'Draft.',
        failureStage: 'verifier:format_references',
        reason: expect.stringContaining('verifier transport failed'),
      })
      expect(calls.map(call => call.role)).toEqual(['generator', 'verifier_format_references'])
      expect(calls.filter(call => call.role === 'reviser')).toHaveLength(0)
    })
  })

  it('fails the worker directly on a verdict-judge execution error without revising', async () => {
    await withWorkspace(async (workspace) => {
      const calls: RoleInvocation[] = []
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nDraft.\n\n## Proof\n\nDraft proof.\n')
            return { text: 'generated' }
          }
          if (request.role === 'verifier_format_references') return { text: 'The proof is valid.' }
          if (request.role === 'review_verdict_judge') throw new Error('judge Agent timed out')
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const result = await runFixedWorkerWorkflow({ workspace, invoker }, makeContext().context)

      expect(result).toMatchObject({
        status: 'failed',
        producedVerifiedProposition: false,
        solved: false,
        failureStage: 'review_verdict_judge:format_references',
        reason: expect.stringContaining('judge Agent timed out'),
      })
      expect(calls.map(call => call.role)).toEqual([
        'generator',
        'verifier_format_references',
        'review_verdict_judge',
      ])
      expect(calls.filter(call => call.role === 'reviser')).toHaveLength(0)
    })
  })

  it('revises only after a completed mathematical fail verdict and restarts at profile one', async () => {
    await withWorkspace(async (workspace) => {
      const calls: RoleInvocation[] = []
      let revised = false
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nDraft.\n\n## Proof\n\nGap.\n')
            return { text: 'generated' }
          }
          if (request.role === 'verifier_format_references' && !revised) {
            return { text: 'The displayed argument has a mathematical gap at line 7.' }
          }
          if (request.role === 'review_verdict_judge') return { text: revised ? 'pass' : 'fail' }
          if (request.role === 'reviser') {
            revised = true
            await writeFile(request.propositionPath, '## Statement\n\nRevised.\n\n## Proof\n\nComplete proof.\n')
            return { text: 'revised' }
          }
          if (isVerifier(request.role)) return { text: 'The proposition is correct.' }
          if (request.role === 'theorem_checker') return { text: 'Solves original problem: no' }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'revised-lemma',
      }, makeContext().context)

      expect(result).toMatchObject({
        status: 'verified',
        producedVerifiedProposition: true,
        solved: false,
        statement: 'Revised.',
      })
      expect(calls.slice(0, 6).map(call => call.role)).toEqual([
        'generator',
        'verifier_format_references',
        'review_verdict_judge',
        'reviser',
        'verifier_format_references',
        'review_verdict_judge',
      ])
      expect(calls.filter(call => call.role === 'reviser')).toHaveLength(1)
      expect(calls.find(call => call.role === 'reviser')?.task)
        .not.toContain('Prove the requested statement.')
    })
  })

  it('fails closed on ambiguous judge output and rejects after six rounds', async () => {
    await withWorkspace(async (workspace) => {
      const calls: RoleInvocation[] = []
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nDraft.\n\n## Proof\n\nDraft proof.\n')
            return { text: 'generated' }
          }
          if (request.role === 'verifier_format_references') return { text: 'Ambiguous review' }
          if (request.role === 'review_verdict_judge') return { text: 'pass and fail' }
          if (request.role === 'reviser') return { text: 'left unchanged' }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const result = await runFixedWorkerWorkflow({ workspace, invoker }, makeContext().context)

      expect(result.status).toBe('rejected')
      expect(result.failureStage).toBe('verifier:format_references')
      expect(calls.filter(call => call.role === 'verifier_format_references')).toHaveLength(MAX_VERIFY_ROUNDS)
      expect(calls.filter(call => call.role === 'review_verdict_judge')).toHaveLength(MAX_VERIFY_ROUNDS)
      expect(calls.filter(call => call.role === 'reviser')).toHaveLength(MAX_VERIFY_ROUNDS - 1)
      expect(calls.some(call => call.role === 'verifier_citation')).toBe(false)
      expect(calls.some(call => call.role === 'theorem_checker')).toBe(false)
    })
  })

  it('promotes an already verified candidate but reports a theorem-checker infrastructure failure', async () => {
    await withWorkspace(async (workspace) => {
      let theoremCalls = 0
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nVerified.\n\n## Proof\n\nProof.\n')
            return { text: 'generated' }
          }
          if (isVerifier(request.role)) return { text: 'Verdict: pass' }
          if (request.role === 'review_verdict_judge') return { text: 'pass' }
          if (request.role === 'theorem_checker') {
            theoremCalls += 1
            throw new Error('checker unavailable')
          }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const test = makeContext({ claim: true })
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'verified-only',
      }, test.context)

      expect(result).toMatchObject({
        status: 'failed',
        producedVerifiedProposition: true,
        solved: false,
        propositionPath: 'verified_propositions/verified-only.md',
        failureStage: 'theorem_checker:1',
        reason: expect.stringContaining('checker unavailable'),
      })
      expect(theoremCalls).toBe(1)
      expect(test.events).not.toContain('claim')
      expect(await readFile(path.join(workspace, 'verified_propositions', 'verified-only.md'), 'utf8'))
        .toContain('Verified.')
      await expect(stat(path.join(workspace, 'verified_propositions', '.alphasolve')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(result.artifactPaths).toContain('unverified_propositions/prop-abc12345/theorem_check.md')
      expect(await readFile(path.join(workspace, 'unverified_propositions', 'prop-abc12345', 'theorem_check.md'), 'utf8'))
        .toContain('theorem_checker:1 infrastructure failure: checker unavailable')
    })
  })

  it('claims, revalidates, promotes, and publishes only the earliest solved worker', async () => {
    await withWorkspace(async (workspace) => {
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nThe requested statement holds.\n\n## Proof\n\nProof.\n')
            return { text: 'generated' }
          }
          if (isVerifier(request.role)) return { text: 'Verdict: pass' }
          if (request.role === 'review_verdict_judge') return { text: 'pass' }
          if (request.role === 'theorem_checker') return { text: 'Solves original problem: yes' }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const test = makeContext({ claim: true })
      let published = 0
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'winning-proposition',
        solutionPublisher: async (request) => {
          published += 1
          expect(await readFile(request.finalPropositionPath, 'utf8')).toContain('requested statement')
          await writeFile(request.solutionPath, '# Solution\n')
          return request.solutionPath
        },
      }, test.context)

      expect(result).toMatchObject({
        status: 'solved',
        producedVerifiedProposition: true,
        solved: true,
        propositionPath: 'verified_propositions/winning-proposition.md',
      })
      expect(published).toBe(1)
      expect(test.progress.filter(update => update.phase === 'theorem_checker')).toHaveLength(THEOREM_CHECK_ATTEMPTS)
      const claimIndex = test.events.indexOf('claim')
      expect(claimIndex).toBeGreaterThan(0)
      expect(test.events[claimIndex + 1]).toBe('assert')
      expect(await readFile(path.join(workspace, 'unverified_propositions', 'prop-abc12345', 'theorem_check.md'), 'utf8'))
        .toContain('## Attempt 5')
    })
  })

  it('rolls back the winner proposition and solution when the problem changes during publication', async () => {
    await withWorkspace(async (workspace) => {
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nTransient solution.\n\n## Proof\n\nProof.\n')
            return { text: 'generated' }
          }
          if (isVerifier(request.role)) return { text: 'Verdict: pass' }
          if (request.role === 'review_verdict_judge') return { text: 'pass' }
          if (request.role === 'theorem_checker') return { text: 'Solves original problem: yes' }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      let invalidated = false
      let released = false
      const test = makeContext({
        claim: true,
        onAssert: () => {
          if (invalidated) throw new Error('problem changed during publisher')
        },
      })
      const context: WorkerExecutionContext = {
        ...test.context,
        releaseSolvedWinner: async () => { released = true },
      }

      await expect(runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'transient-winner',
        solutionPublisher: async request => {
          await writeFile(request.solutionPath, '# Solution\n')
          invalidated = true
          return request.solutionPath
        },
      }, context)).rejects.toThrow(/problem changed during publisher/)

      expect(released).toBe(true)
      await expect(stat(path.join(workspace, 'solution.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(path.join(workspace, 'verified_propositions', 'transient-winner.md')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('keeps a solved loser only as an auditable unverified worker', async () => {
    await withWorkspace(async (workspace) => {
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nLate solution.\n\n## Proof\n\nProof.\n')
            return { text: 'generated' }
          }
          if (isVerifier(request.role)) return { text: 'Verdict: pass' }
          if (request.role === 'review_verdict_judge') return { text: 'pass' }
          if (request.role === 'theorem_checker') return { text: 'Solves original problem: yes' }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      let published = false
      const result = await runFixedWorkerWorkflow({
        workspace,
        invoker,
        filenameBuilder: async () => 'late-solution',
        solutionPublisher: async () => {
          published = true
          return path.join(workspace, 'solution.md')
        },
      }, makeContext({ claim: false }).context)

      expect(result).toMatchObject({
        status: 'discarded_after_solution',
        producedVerifiedProposition: false,
        solved: true,
      })
      expect(published).toBe(false)
      await expect(stat(path.join(workspace, 'verified_propositions', 'late-solution.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(path.join(workspace, 'unverified_propositions', 'prop-abc12345', 'proposition.md'), 'utf8'))
        .toContain('Late solution')
    })
  })

  it('reports a write conflict when a read-only role observes an externally edited proposition', async () => {
    await withWorkspace(async (workspace) => {
      const calls: RoleInvocation[] = []
      const invoker: RoleInvoker = {
        invoke: async (request) => {
          calls.push(request)
          if (request.role === 'generator') {
            await writeFile(request.propositionPath, '## Statement\n\nOriginal.\n\n## Proof\n\nProof.\n')
            return { text: 'generated' }
          }
          if (request.role === 'verifier_format_references') {
            await writeFile(request.propositionPath, '## Statement\n\nExternal edit.\n\n## Proof\n\nChanged.\n')
            return { text: 'Verdict: pass' }
          }
          throw new Error(`unexpected role ${request.role}`)
        },
      }
      const result = await runFixedWorkerWorkflow({ workspace, invoker }, makeContext().context)

      expect(result).toMatchObject({
        status: 'write_conflict',
        producedVerifiedProposition: false,
        solved: false,
        failureStage: 'proposition_stamp',
      })
      expect(calls.some(call => call.role === 'review_verdict_judge')).toBe(false)
      expect(calls.some(call => call.role === 'reviser')).toBe(false)
    })
  })
})
