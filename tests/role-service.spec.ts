import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { CALCULATOR_TOOL_NAME } from '../src/calculator.js'
import { createCuratorKnowledgeTools } from '../src/curator-tools.js'
import {
  AlphaSolveRoleService,
  CURATOR_TOOL_NAMES,
  RoleAgentDidNotCompleteError,
  SUBAGENT_TOOL_NAME,
  type RoleAgentRunner,
  type RoleTraceEvent,
} from '../src/role-service.js'
import { RESEARCH_REVIEW_TOOL_NAMES } from '../src/research-tools.js'
import { STATE_VERSION, type AlphaSolveConfig, type CuratorTask } from '../src/types.js'
import type { RoleInvocation } from '../src/workflow.js'

const temporaryRoots: string[] = []
const contexts: Context[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-role-service-'))
  temporaryRoots.push(root)
  await Promise.all([
    mkdir(path.join(root, 'knowledge', 'references'), { recursive: true }),
    mkdir(path.join(root, 'verified_propositions'), { recursive: true }),
    mkdir(path.join(root, 'unverified_propositions', 'prop-worker-a'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(root, 'problem.md'), 'Prove the problem.'),
    writeFile(path.join(root, 'knowledge', 'index.md'), '# Index\n'),
    writeFile(path.join(root, 'knowledge', 'common-errors.md'), '# Common errors\n'),
    writeFile(path.join(root, 'unverified_propositions', 'prop-worker-a', 'proposition.md'), '## Statement\nS\n\n## Proof\nP\n'),
  ])
  return root
}

afterEach(async () => {
  contexts.splice(0)
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function mainAgent(): Agent {
  return {
    options: { provider: 'option-provider', model: 'option-model' },
    session: {
      requestHeader: () => ({
        config: {
          provider: 'main-provider',
          model: 'main-model',
          reasoningEffort: 'high',
        },
      }),
    },
  } as unknown as Agent
}

function config(overrides: Partial<AlphaSolveConfig> = {}): AlphaSolveConfig {
  return {
    capacity: 2,
    detailedTrace: true,
    models: {},
    ...overrides,
  }
}

let runSequence = 0
function completedRun(
  options: Parameters<RoleAgentRunner>[0],
  text = `completed ${options.role}`,
): Awaited<ReturnType<RoleAgentRunner>> {
  runSequence += 1
  return {
    agentId: SessionId(`role-${runSequence}`),
    role: options.role,
    output: [{ type: 'text', text }],
    text,
    stopReason: 'completed',
    steps: 1,
    turnEndReason: { kind: 'completed' },
  }
}

function invocation(root: string, role: RoleInvocation['role']): RoleInvocation {
  const workerDirectory = path.join(root, 'unverified_propositions', 'prop-worker-a')
  return {
    role,
    workerId: 'worker-a',
    cwd: root,
    workspace: root,
    workerDirectory,
    propositionPath: path.join(workerDirectory, 'proposition.md'),
    ...(role === 'verifier_citation' ? { verifierProfile: 'citation' as const } : {}),
    persona: `persona for ${role}`,
    task: `task for ${role}`,
    maxTurns: 17,
    signal: new AbortController().signal,
  }
}

async function toolContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('AlphaSolveRoleService workflow roles', () => {
  it('inherits the live main route, applies the verifier override, and installs one strictly typed helper', async () => {
    const root = await workspace()
    const calls: Parameters<RoleAgentRunner>[0][] = []
    const traces: RoleTraceEvent[] = []
    const runner: RoleAgentRunner = async options => {
      calls.push(options)
      return completedRun(options)
    }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(),
      workspace: root,
      getConfig: () => config({
        models: { verifier: { model: 'strict-verifier' } },
      }),
      onTrace: event => {
        traces.push(event)
        return `.alphasolve/traces/${event.kind}-${event.agentId}.json`
      },
      runner,
    })

    const result = await service.invoke(invocation(root, 'verifier_citation'))
    const verifier = calls[0]
    expect(verifier).toBeDefined()
    expect(verifier?.role).toBe('verifier_citation')
    expect(verifier?.modelSelection).toEqual({
      provider: 'main-provider',
      model: 'strict-verifier',
      reasoningEffort: 'high',
    })
    expect(verifier?.permissionPolicy.allowedTools.has(SUBAGENT_TOOL_NAME)).toBe(true)
    expect(verifier?.permissionPolicy.paths.some(rule => rule.root === path.join(root, 'knowledge'))).toBe(false)
    expect(result.trace).toHaveLength(1)
    expect(traces).toMatchObject([{
      kind: 'workflow_role', role: 'verifier_citation', workerId: 'worker-a', stopReason: 'completed',
    }])

    const ctx = await toolContext()
    const roleChild = { options: {}, session: {} } as unknown as Agent
    await verifier?.setupHelpers?.(ctx, roleChild)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([SUBAGENT_TOOL_NAME])

    const denied = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('research-denied'),
      name: SUBAGENT_TOOL_NAME,
      arguments: { type: 'research_reviewer', task: 'survey this' },
    })
    expect(denied.isError).toBe(true)
    expect(denied.content[0]).toMatchObject({ text: expect.stringMatching(/cannot launch/) })

    const reasoning = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('reasoning-ok'),
      name: SUBAGENT_TOOL_NAME,
      arguments: { type: 'reasoning', task: 'check one implication' },
    })
    expect(reasoning.isError).toBe(false)
    expect(calls[1]).toMatchObject({
      parent: roleChild,
      role: 'reasoning',
      cwd: root,
      maxTurns: 80,
    })
    expect(calls[1]?.setupHelpers).toBeUndefined()
    expect(calls[1]?.permissionPolicy.allowedTools.has(SUBAGENT_TOOL_NAME)).toBe(false)
    expect(service.artifactPaths('worker-a')).toEqual([
      expect.stringMatching(/^\.alphasolve\/traces\/subagent-/),
      expect.stringMatching(/^\.alphasolve\/traces\/workflow_role-/),
    ])
    expect(calls[1]?.permissionPolicy.paths.some(rule => rule.root === path.join(root, 'knowledge'))).toBe(false)
  })

  it('gives compute helpers only the calculator as a non-nesting scoped helper', async () => {
    const root = await workspace()
    const calls: Parameters<RoleAgentRunner>[0][] = []
    let calculatorNames: string[] = []
    const helperCtx = await toolContext()
    const runner: RoleAgentRunner = async options => {
      calls.push(options)
      if (options.role === 'compute') {
        await options.setupHelpers?.(helperCtx, {} as Agent)
        calculatorNames = helperCtx.tools.schemas().map(schema => schema.name)
      }
      return completedRun(options, options.role === 'compute' ? '4' : undefined)
    }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(), workspace: root, getConfig: () => config(), runner,
    })
    await service.invoke(invocation(root, 'generator'))
    const generator = calls[0]
    const ctx = await toolContext()
    await generator?.setupHelpers?.(ctx, {} as Agent)

    const calculation = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('compute-helper'),
      name: SUBAGENT_TOOL_NAME,
      arguments: { type: 'compute', task: 'calculate 2+2' },
    })
    expect(calculation.isError).toBe(false)
    expect(calculatorNames).toEqual([CALCULATOR_TOOL_NAME])
    expect(calls[1]?.permissionPolicy.allowedTools.has(CALCULATOR_TOOL_NAME)).toBe(true)
    expect(calls[1]?.permissionPolicy.allowedTools.has(SUBAGENT_TOOL_NAME)).toBe(false)
  })

  it('throws a typed failure whenever a role Agent does not complete', async () => {
    const root = await workspace()
    const runner: RoleAgentRunner = async options => ({
      ...completedRun(options),
      stopReason: 'max_turns',
      steps: options.maxTurns,
    })
    const service = new AlphaSolveRoleService({
      parent: mainAgent(), workspace: root, getConfig: () => config(), runner,
    })
    await expect(service.invoke(invocation(root, 'reviser')))
      .rejects.toBeInstanceOf(RoleAgentDidNotCompleteError)
  })

  it('persists a partial error trace and rethrows the original runner error unchanged', async () => {
    const root = await workspace()
    const traces: RoleTraceEvent[] = []
    const original = Object.assign(new Error('provider transport failed'), { code: 'TRANSPORT' })
    const runner: RoleAgentRunner = async options => {
      options.onFailure?.({
        agentId: 'failed-role-session',
        role: options.role,
        phase: 'run',
        output: [{ type: 'text', text: 'partial proof' }],
        text: 'partial proof',
        steps: 4,
        error: original,
        turnEndReason: {
          kind: 'error',
          error: { message: original.message, code: original.code },
        },
      })
      throw original
    }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(),
      workspace: root,
      getConfig: () => config(),
      runner,
      onTrace: event => {
        traces.push(event)
        return `.alphasolve/traces/${event.agentId}.json`
      },
    })

    let thrown: unknown
    try {
      await service.invoke(invocation(root, 'reviser'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(original)
    expect(traces).toEqual([expect.objectContaining({
      kind: 'workflow_role',
      role: 'reviser',
      workerId: 'worker-a',
      agentId: 'failed-role-session',
      stopReason: 'error',
      phase: 'run',
      text: 'partial proof',
      steps: 4,
      error: { name: 'Error', message: 'provider transport failed', code: 'TRANSPORT' },
      turnEndReason: {
        kind: 'error',
        error: { message: 'provider transport failed', code: 'TRANSPORT' },
      },
    })])
    expect(service.artifactPaths('worker-a')).toEqual([
      '.alphasolve/traces/failed-role-session.json',
    ])
  })

  it('does not mask a runner error when failure-trace persistence also fails', async () => {
    const root = await workspace()
    const original = new Error('original runner failure')
    const traceFailure = new Error('trace backend unavailable')
    const runner: RoleAgentRunner = async () => { throw original }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(),
      workspace: root,
      getConfig: () => config(),
      runner,
      onTrace: () => { throw traceFailure },
    })

    let thrown: unknown
    try {
      await service.invoke(invocation(root, 'generator'))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBe(original)
  })
})

describe('AlphaSolveRoleService auxiliary routes', () => {
  it('uses a one-step no-tool generator route for filenames and a fresh non-nesting reviewer route', async () => {
    const root = await workspace()
    const calls: Parameters<RoleAgentRunner>[0][] = []
    const runner: RoleAgentRunner = async options => {
      calls.push(options)
      return completedRun(options, options.role === 'generator' ? 'finite-field-bound' : 'review')
    }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(),
      workspace: root,
      getConfig: () => config({
        models: {
          generator: { model: 'namer-model' },
          research_reviewer: { provider: 'survey-provider' },
        },
      }),
      runner,
    })

    await expect(service.buildPropositionFilename({
      workerId: 'worker-a',
      propositionText: 'unused by the already-built prompt',
      prompt: 'Name this proposition.',
      signal: new AbortController().signal,
    })).resolves.toBe('finite-field-bound')
    expect(calls[0]).toMatchObject({
      role: 'generator', maxTurns: 1, allowedInheritedTools: [],
      modelSelection: { provider: 'main-provider', model: 'namer-model', reasoningEffort: 'high' },
    })
    expect(calls[0]?.setupHelpers).toBeUndefined()

    await expect(service.runResearchReview({ signal: new AbortController().signal })).resolves.toBe('review')
    expect(calls[1]).toMatchObject({
      role: 'research_reviewer',
      modelSelection: { provider: 'survey-provider', model: 'main-model', reasoningEffort: 'high' },
    })
    expect(calls[1]?.setupHelpers).toBeDefined()
    expect(calls[1]?.permissionPolicy.paths.some(rule => rule.root.includes('unverified_propositions'))).toBe(false)
    const reviewerCtx = await toolContext()
    await calls[1]?.setupHelpers?.(reviewerCtx, {} as Agent)
    expect(reviewerCtx.tools.schemas().map(schema => schema.name)).toEqual([
      RESEARCH_REVIEW_TOOL_NAMES.progress,
      RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown,
    ])
    expect(reviewerCtx.tools.get('bash')).toBeUndefined()
  })

  it('wraps the curator knowledge API in dedicated scoped tools and exposes no global tools', async () => {
    const root = await workspace()
    const knowledgeTools = await createCuratorKnowledgeTools(root, 'health_check')
    const childCtx = await toolContext()
    let curatorOptions: Parameters<RoleAgentRunner>[0] | undefined
    const runner: RoleAgentRunner = async options => {
      curatorOptions = options
      await options.setupHelpers?.(childCtx, {} as Agent)
      return completedRun(options)
    }
    const service = new AlphaSolveRoleService({
      parent: mainAgent(), workspace: root, getConfig: () => config(), runner,
    })
    const task: CuratorTask = {
      version: STATE_VERSION,
      id: 'health-1',
      kind: 'health_check',
      createdAt: new Date(0).toISOString(),
      status: 'active',
      attempts: 1,
    }

    await service.runCurator({ task, tools: knowledgeTools, signal: new AbortController().signal })
    expect(curatorOptions?.role).toBe('curator')
    expect(curatorOptions?.allowedInheritedTools).toEqual([])
    expect(childCtx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      ...Object.values(CURATOR_TOOL_NAMES),
      SUBAGENT_TOOL_NAME,
    ].sort())
    expect(childCtx.tools.get('bash')).toBeUndefined()

    const write = await childCtx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('curator-write'),
      name: CURATOR_TOOL_NAMES.write,
      arguments: { path: 'knowledge/new-page.md', content: '# New page\n' },
    })
    expect(write.isError).toBe(false)
    await expect(readFile(path.join(root, 'knowledge', 'new-page.md'), 'utf8')).resolves.toBe('# New page\n')

    const deniedHelper = await childCtx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('curator-helper-denied'),
      name: SUBAGENT_TOOL_NAME,
      arguments: { type: 'numerical_experiment', task: 'not curator-approved' },
    })
    expect(deniedHelper.isError).toBe(true)
  })
})
