import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ToolCallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { alphaSolveSessionProjection } from '../src/session-state.js'

import { ORCHESTRATOR_INDEX_PATH_PATTERN } from '../src/permissions.js'
import { PROJECT_TOOL_NAMES } from '../src/project-tools.js'
import { acquireWorkspaceLock } from '../src/lock.js'
import { RuntimeStore } from '../src/store.js'
import { STATE_VERSION } from '../src/types.js'
import {
  activateAlphaSolveRuntime,
  RUNTIME_TOOL_NAMES,
  shouldEnqueueCuratorTrace,
  type AlphaSolveRuntime,
} from '../src/runtime.js'
import { initializeWorkspace, readWorkspaceInput } from '../src/workspace.js'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('ScriptedAdapter exhausted')
    for (const chunk of response) yield chunk
  }
}

describe('curator trace routing', () => {
  it('persists but does not recursively enqueue curator-helper traces', () => {
    expect(shouldEnqueueCuratorTrace({ parentRole: 'curator' })).toBe(false)
    expect(shouldEnqueueCuratorTrace({ parentRole: 'generator' })).toBe(true)
    expect(shouldEnqueueCuratorTrace({})).toBe(true)
  })
})

function toolCallResponse(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function stubFileTool(name: 'write' | 'edit'): ToolDefinition {
  const edit = name === 'edit'
  return {
    name,
    description: `Stub ${name} tool`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        ...edit
          ? { old_string: { type: 'string' }, new_string: { type: 'string' } }
          : { content: { type: 'string' } },
      },
      required: edit ? ['file_path', 'old_string', 'new_string'] : ['file_path', 'content'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => ({ path: (args as { file_path: string }).file_path }),
  }
}

interface RuntimeHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: AlphaSolveRuntime
  readonly root: string
  readonly adapter: ScriptedAdapter
  readonly disposed: ReturnType<typeof vi.fn>
  readonly resumed: boolean
}

async function harness(
  script: StreamChunk[][] = [],
  prepareRoot?: (root: string) => Promise<void>,
): Promise<RuntimeHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-runtime-tools-'))
  roots.push(root)
  await writeFile(path.join(root, 'problem.md'), 'Prove that the test proposition holds.\n')
  await prepareRoot?.(root)

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.sessionProjections.register(alphaSolveSessionProjection)
  for (const name of ['read', 'glob', 'grep']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `Stub ${name} tool`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: name }]),
    }))
  }
  ctx.tools.register(stubFileTool('write'))
  ctx.tools.register(stubFileTool('edit'))
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(`runtime-${roots.length}`),
    meta: { cwd: root },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const disposed = vi.fn()
  const activated = await activateAlphaSolveRuntime(
    handle.agent,
    { capacity: 2 },
    { defaultDetailedTrace: false },
    disposed,
  )
  if (!activated.activated) throw new Error(`runtime activation failed: ${activated.reason}`)
  return {
    ctx,
    agent: handle.agent,
    runtime: activated.runtime,
    root,
    adapter,
    disposed,
    resumed: activated.resumed,
  }
}

async function seedCompletionBeforeSolvedState(
  root: string,
  options: { readonly delivered?: boolean; readonly curatorPending?: boolean } = {},
): Promise<void> {
  await initializeWorkspace(root)
  const problem = await readWorkspaceInput(root, 'problem.md', { nonEmpty: true })
  const now = new Date().toISOString()
  const store = new RuntimeStore(root)
  await store.open({
    version: STATE_VERSION,
    sessionId: 'crashed-session',
    workspace: root,
    activatedAt: now,
    updatedAt: now,
    status: 'active',
    problemDigest: problem.digest,
    capacity: 2,
    detailedTrace: false,
    modelOverrides: {},
    nextCompletionSequence: 1,
    winnerWorkerId: 'recovered-winner',
  })
  await writeFile(path.join(root, 'solution.md'), [
    '# Solution',
    '',
    '## Problem',
    '',
    'Prove that the test proposition holds.',
    '',
    '## Verified Proposition Chain',
    '',
    'Recovered proof.',
    '',
  ].join('\n'))
  await store.recordCompletion({
    workerId: 'recovered-winner',
    status: 'solved',
    startedAt: now,
    completedAt: now,
    problemDigest: problem.digest,
    producedVerifiedProposition: true,
    solved: true,
    summary: 'recovered accepted solution',
    statement: 'The proposition holds.',
    propositionPath: 'verified_propositions/recovered-winner.md',
    artifactPaths: ['solution.md'],
  })
  if (options.delivered === true) {
    await store.reserveUndelivered('prior-solved-wait')
    await store.commitDelivery('prior-solved-wait')
  }
  if (options.curatorPending === true) {
    await writeFile(path.join(root, '.alphasolve', 'curator', 'queue.json'), `${JSON.stringify({
      version: STATE_VERSION,
      tasks: [{
        version: STATE_VERSION,
        id: 'recovered-curator-task',
        kind: 'digest',
        createdAt: now,
        tracePath: '.alphasolve/traces/missing-recovered-trace.json',
        status: 'pending',
        attempts: 0,
      }],
    })}\n`)
  }
}

async function execute(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown,
  callId: string,
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
}

function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition did not become true')
}

describe('runtime tool contract', () => {
  it('notifies the controller even when workspace-lock release fails', async () => {
    const { runtime, disposed } = await harness()
    const internals = runtime as unknown as {
      lock: { release(): Promise<void> }
      shutdown(kind: 'interrupted', releaseLock?: boolean): Promise<void>
    }
    vi.spyOn(internals.lock, 'release').mockRejectedValueOnce(new Error('injected lock release failure'))

    await expect(internals.shutdown('interrupted')).rejects.toThrow('injected lock release failure')
    expect(disposed).toHaveBeenCalledTimes(1)

    await runtime.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('releases the workspace lock on dispose even when the stop shutdown failed', async () => {
    const { ctx, agent, runtime, root, disposed } = await harness()
    vi.spyOn(runtime.manager, 'stop').mockRejectedValueOnce(new Error('injected shutdown failure'))

    const stopped = await execute(ctx, agent, RUNTIME_TOOL_NAMES.stop, {}, 'stop-shutdown-failure')
    expect(stopped).toMatchObject({ isError: true })
    await expect(runtime.dispose()).resolves.toBeUndefined()
    expect(disposed).toHaveBeenCalledTimes(1)

    const replacement = await acquireWorkspaceLock(root, 'replacement-session')
    await replacement.release()
  })

  it('injects one orchestrator-visible notice when a curator task fails', async () => {
    const { agent, runtime } = await harness()
    const inject = vi.spyOn(agent, 'inject')
    const curator = (runtime as unknown as {
      curator: {
        submit(input: { id: string; kind: 'digest'; tracePath: string }): Promise<unknown>
        waitForIdle(): Promise<void>
      }
    }).curator

    await curator.submit({
      id: 'curator-failure-notice',
      kind: 'digest',
      tracePath: '.alphasolve/traces/missing.json',
    })
    await curator.waitForIdle()
    await until(() => inject.mock.calls.some(([message]) => (
      JSON.stringify(message).includes('curator-failure-notice')
    )))

    const matching = inject.mock.calls.filter(([message]) => (
      JSON.stringify(message).includes('curator-failure-notice')
    ))
    expect(matching).toHaveLength(1)
    expect(JSON.stringify(matching[0]?.[0])).toContain('kind=digest')
    expect(matching[0]?.[0].source).toEqual({
      kind: 'alphasolve', form: 'notice', summary: 'AlphaSolve curator task failed',
    })
  })

  it('assembles live capacity and worker state instead of a stale static snapshot', async () => {
    const { ctx, agent } = await harness()
    const runtimeContext = async (): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agent })
      return assembly.contexts.find(entry => entry.name === 'alphasolve:runtime-state')?.text ?? ''
    }

    expect(await runtimeContext()).toContain('- capacity: 2')
    expect(await runtimeContext()).toContain('- activeWorkerIds: []')
    expect(await runtimeContext()).toContain('- activeWorkerProgress: []')
    expect(await runtimeContext()).toContain('- overCapacity: false')
    expect(await runtimeContext()).toContain('- completedSinceResearchReview: 0')
    expect(await runtimeContext()).toContain('- researchReviewDue: false')
    const staticAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(staticAssembly.sections.find(entry => entry.name === 'alphasolve:orchestrator')?.text)
      .not.toContain('Current worker capacity is 2')

    const configured = await execute(ctx, agent, RUNTIME_TOOL_NAMES.configure, { capacity: 4 }, 'configure-live-prompt')
    expect(configured.isError).toBe(false)
    expect(await runtimeContext()).toContain('- capacity: 4')
  })

  it('narrows standard index writes and exposes only verified organization tools', async () => {
    const { ctx, agent, root } = await harness()

    for (const name of Object.values(PROJECT_TOOL_NAMES)) {
      expect(ctx.tools.get(name, agent), name).toBeDefined()
    }
    expect(ctx.tools.get('alphasolve_delete_empty', agent)).toBeUndefined()
    for (const name of ['write', 'edit'] as const) {
      expect(ctx.tools.get(name, agent)?.parameters).toMatchObject({
        properties: { file_path: { pattern: ORCHESTRATOR_INDEX_PATH_PATTERN } },
      })
    }

    const deniedPropositionWrite = await execute(ctx, agent, 'write', {
      file_path: 'verified_propositions/fabricated.md',
      content: '# Fabricated',
    }, 'write-proposition')
    expect(deniedPropositionWrite).toMatchObject({ isError: true })
    const deniedKnowledgeWrite = await execute(ctx, agent, 'write', {
      file_path: 'knowledge/index.md',
      content: '# Knowledge',
    }, 'write-knowledge')
    expect(deniedKnowledgeWrite).toMatchObject({ isError: true })
    const allowedNestedIndex = await execute(ctx, agent, 'write', {
      file_path: 'verified_propositions/route-a/index.md',
      content: '# Route A',
    }, 'write-nested-index')
    expect(allowedNestedIndex).toMatchObject({ isError: false })

    const deniedKnowledgeMkdir = await execute(ctx, agent, PROJECT_TOOL_NAMES.mkdir, {
      path: 'knowledge/agent-notes',
    }, 'mkdir-knowledge')
    expect(deniedKnowledgeMkdir).toMatchObject({ isError: true })
    const verifiedMkdir = await execute(ctx, agent, PROJECT_TOOL_NAMES.mkdir, {
      path: 'verified_propositions/route-a/archive',
    }, 'mkdir-verified')
    expect(verifiedMkdir).toMatchObject({ isError: false })

    await writeFile(path.join(root, 'verified_propositions', 'lemma.md'), '# Lemma\n')
    const renamed = await execute(ctx, agent, PROJECT_TOOL_NAMES.rename, {
      directory: 'verified_propositions', old_name: 'lemma.md', new_name: 'specific-lemma.md',
    }, 'rename-verified')
    expect(renamed).toMatchObject({
      isError: false,
      value: { oldPath: 'verified_propositions/lemma.md', path: 'verified_propositions/specific-lemma.md' },
    })
    const moved = await execute(ctx, agent, PROJECT_TOOL_NAMES.move, {
      path: 'verified_propositions/specific-lemma.md',
      destination_dir: 'verified_propositions/route-a',
    }, 'move-verified')
    expect(moved).toMatchObject({
      isError: false,
      value: {
        oldPath: 'verified_propositions/specific-lemma.md',
        path: 'verified_propositions/route-a/specific-lemma.md',
      },
    })
    expect(await readFile(path.join(root, 'verified_propositions', 'route-a', 'specific-lemma.md'), 'utf8'))
      .toBe('# Lemma\n')
  })

  it('publishes strict argument schemas and enforces semantic validation', async () => {
    const { ctx, agent, runtime } = await harness()
    for (const name of Object.values(RUNTIME_TOOL_NAMES)) {
      expect(ctx.tools.get(name, agent), name).toBeDefined()
    }
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)?.description).toContain('proposition worker')
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)?.description).toContain('not a general subagent')
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)?.description).toContain('Pure wait')
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.researchReview, agent)?.description).toContain('not a Web')
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)?.parameters).toMatchObject({
      type: 'object', additionalProperties: false, properties: {},
    })

    const whitespace = await execute(
      ctx,
      agent,
      RUNTIME_TOOL_NAMES.worker,
      { instruction: '   ' },
      'worker-whitespace',
    )
    expect(whitespace).toMatchObject({
      isError: false,
      value: { accepted: false, reason: 'invalid_instruction', active: 0, capacity: 2 },
    })

    for (const [name, args, callId] of [
      [RUNTIME_TOOL_NAMES.worker, { instruction: 'try', extra: true }, 'worker-extra'],
      [RUNTIME_TOOL_NAMES.wait, { timeout: 1 }, 'wait-argument'],
      [RUNTIME_TOOL_NAMES.configure, { capacity: 0 }, 'configure-zero'],
      [RUNTIME_TOOL_NAMES.researchReview, { prompt: 7 }, 'review-prompt'],
      [RUNTIME_TOOL_NAMES.stop, { now: true }, 'stop-extra'],
    ] as const) {
      const result = await execute(ctx, agent, name, args, callId)
      expect(result.isError, name).toBe(true)
    }

    const configured = await execute(
      ctx,
      agent,
      RUNTIME_TOOL_NAMES.configure,
      { capacity: 3 },
      'configure-three',
    )
    expect(configured).toMatchObject({
      isError: false,
      value: { previousCapacity: 2, capacity: 3, active: 0, overCapacity: false },
    })
    expect(runtime.store.currentState().capacity).toBe(3)

    const emptyWait = await execute(ctx, agent, RUNTIME_TOOL_NAMES.wait, {}, 'wait-empty')
    expect(emptyWait).toMatchObject({
      isError: false,
      value: {
        status: 'no_active_workers', completed: [], active: 0, capacity: 3,
        completedSinceResearchReview: 0, researchReviewDue: false,
      },
    })
    expect(emptyWait.concludesTurn).toBeUndefined()
  })

  it('surfaces a deterministic research-review reminder after four worker lifecycles', async () => {
    const { ctx, agent, runtime } = await harness()
    const state = runtime.store.currentState()
    const now = new Date().toISOString()
    for (let index = 1; index <= 4; index += 1) {
      await runtime.store.recordCompletion({
        workerId: `review-cadence-${index}`,
        status: 'rejected',
        startedAt: now,
        completedAt: now,
        problemDigest: state.problemDigest,
        producedVerifiedProposition: false,
        solved: false,
        summary: `mathematical rejection ${index}`,
        failureStage: 'verifier:stepwise',
        reason: 'completed mathematical review failed',
        artifactPaths: [],
      })
    }

    const waited = await execute(ctx, agent, RUNTIME_TOOL_NAMES.wait, {}, 'wait-review-cadence')
    expect(waited).toMatchObject({
      isError: false,
      value: {
        status: 'completed',
        completed: expect.arrayContaining([
          expect.objectContaining({ workerId: 'review-cadence-1' }),
          expect.objectContaining({ workerId: 'review-cadence-4' }),
        ]),
        completedSinceResearchReview: 4,
        researchReviewDue: true,
      },
    })

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    let runtimeState = assembly.contexts.find(entry => entry.name === 'alphasolve:runtime-state')?.text ?? ''
    expect(runtimeState).toContain('- completedSinceResearchReview: 4')
    expect(runtimeState).toContain('- researchReviewDue: true')

    const roleService = (runtime as unknown as {
      roleService: { runResearchReview(input: unknown): Promise<string> }
    }).roleService
    vi.spyOn(roleService, 'runResearchReview').mockResolvedValue('Ranked next proposition targets.')
    const reviewed = await execute(
      ctx,
      agent,
      RUNTIME_TOOL_NAMES.researchReview,
      { prompt: 'Compare the two active routes.' },
      'research-review-cadence-reset',
    )
    expect(reviewed).toMatchObject({
      isError: false,
      value: { review: 'Ranked next proposition targets.' },
    })
    const afterReview = await ctx.systemPrompt.assemble({ scope: agent })
    runtimeState = afterReview.contexts.find(entry => entry.name === 'alphasolve:runtime-state')?.text ?? ''
    expect(runtimeState).toContain('- completedSinceResearchReview: 0')
    expect(runtimeState).toContain('- researchReviewDue: false')
  })
})

describe('terminal crash recovery', () => {
  it('resumes a completion-before-state crash and delivers it without archiving', async () => {
    const waitCallId = 'wait-recovered-terminal'
    const { ctx, agent, runtime, root, disposed, resumed } = await harness([
      toolCallResponse(waitCallId, RUNTIME_TOOL_NAMES.wait, {}),
    ], root => seedCompletionBeforeSolvedState(root))

    expect(resumed).toBe(true)
    expect(runtime.store.currentState()).toMatchObject({
      status: 'solved',
      winnerWorkerId: 'recovered-winner',
    })
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.configure, agent)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeDefined()
    expect(await readdir(path.join(root, '.alphasolve', 'backups'))).toEqual([])

    const idle = nextIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Return the recovered AlphaSolve result.' }],
      source: { kind: 'user' },
    }))
    await idle
    await until(() => disposed.mock.calls.length === 1)

    expect((await runtime.store.listCompletions())[0]).toMatchObject({
      workerId: 'recovered-winner',
      deliveredByCallId: waitCallId,
    })
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeUndefined()
  })

  it('resumes a delivered solution while its curator queue still needs recovery', async () => {
    const waitCallId = 'wait-recovered-curator'
    const { ctx, agent, runtime, root, disposed, resumed } = await harness([
      toolCallResponse(waitCallId, RUNTIME_TOOL_NAMES.wait, {}),
    ], root => seedCompletionBeforeSolvedState(root, { delivered: true, curatorPending: true }))
    const events: SessionEvent[] = []
    agent.ctx.on('session/event', (_session, event) => { events.push(event) })

    expect(resumed).toBe(true)
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect(await readdir(path.join(root, '.alphasolve', 'backups'))).toEqual([])

    const idle = nextIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Drain the recovered AlphaSolve terminal state.' }],
      source: { kind: 'user' },
    }))
    await idle
    await until(() => disposed.mock.calls.length === 1)

    const [completion] = await runtime.store.listCompletions()
    expect(completion).toMatchObject({
      workerId: 'recovered-winner',
      deliveredByCallId: 'prior-solved-wait',
    })
    const resultEvent = events.find((event): event is SessionEvent<'tool/result'> => (
      event.type === 'tool/result'
      && event.data.message.source.callId === ToolCallId(waitCallId)
    ))
    expect(resultEvent?.data.message).toMatchObject({ isError: false })
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeUndefined()
  })
})

describe('authoritative final wait lifecycle', () => {
  it('commits solved delivery, concludes the turn, then unloads the session runtime', async () => {
    const waitCallId = 'wait-solved-final'
    const { ctx, agent, runtime, root, adapter, disposed } = await harness([
      toolCallResponse(waitCallId, RUNTIME_TOOL_NAMES.wait, {}),
    ])
    const events: SessionEvent[] = []
    agent.ctx.on('session/event', (_session, event) => { events.push(event) })
    const state = runtime.store.currentState()
    await writeFile(path.join(root, 'solution.md'), '# Solution\n\nThe proposition holds.\n')
    await runtime.store.recordCompletion({
      workerId: 'winner',
      status: 'solved',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      problemDigest: state.problemDigest,
      producedVerifiedProposition: true,
      solved: true,
      summary: 'worker produced the accepted solution: The proposition holds.',
      statement: 'The proposition holds.',
      propositionPath: 'solution.md',
      artifactPaths: ['solution.md'],
    })
    await runtime.store.updateState(current => ({
      ...current,
      status: 'solved',
      winnerWorkerId: 'winner',
    }))

    const idle = nextIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Return the completed AlphaSolve result.' }],
      source: { kind: 'user' },
    }))
    await idle
    await until(() => disposed.mock.calls.length === 1)

    expect(adapter.requests).toHaveLength(1)
    const resultEvent = events.find((event): event is SessionEvent<'tool/result'> => (
      event.type === 'tool/result'
      && event.data.message.source.callId === ToolCallId(waitCallId)
    ))
    expect(resultEvent?.data.message).toMatchObject({ isError: false })
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })

    const [completion] = await runtime.store.listCompletions()
    expect(completion).toMatchObject({
      workerId: 'winner',
      reservedByCallId: waitCallId,
      deliveredByCallId: waitCallId,
    })
    expect(completion?.deliveredAt).toBeDefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
  })

  it('holds session flush and runtime teardown until a delayed solved delivery commit finishes', async () => {
    const waitCallId = 'wait-solved-delayed-commit'
    const { ctx, agent, runtime, root, disposed } = await harness([
      toolCallResponse(waitCallId, RUNTIME_TOOL_NAMES.wait, {}),
    ])
    const state = runtime.store.currentState()
    await writeFile(path.join(root, 'solution.md'), '# Solution\n\nCommitted after the gate.\n')
    await runtime.store.recordCompletion({
      workerId: 'delayed-winner',
      status: 'solved',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      problemDigest: state.problemDigest,
      producedVerifiedProposition: true,
      solved: true,
      summary: 'worker produced the accepted solution: Committed after the gate.',
      statement: 'Committed after the gate.',
      propositionPath: 'solution.md',
      artifactPaths: ['solution.md'],
    })
    await runtime.store.updateState(current => ({
      ...current,
      status: 'solved',
      winnerWorkerId: 'delayed-winner',
    }))

    const commitGate = Promise.withResolvers<void>()
    const commitEntered = Promise.withResolvers<void>()
    const flushEntered = Promise.withResolvers<void>()
    const order: string[] = []
    const commitDelivery = runtime.store.commitDelivery.bind(runtime.store)
    vi.spyOn(runtime.store, 'commitDelivery').mockImplementation(async callId => {
      order.push('commit-entered')
      commitEntered.resolve()
      await commitGate.promise
      await commitDelivery(callId)
      order.push('commit-finished')
    })
    agent.ctx.on('session/flush', () => {
      order.push('flush-entered')
      flushEntered.resolve()
    })
    disposed.mockImplementation(() => {
      order.push('runtime-disposed')
    })

    const idle = nextIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Return the delayed committed result.' }],
      source: { kind: 'user' },
    }))
    await commitEntered.promise
    const flush = ctx.sessions.flush(agent.session)
    await flushEntered.promise
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(order).toEqual(['commit-entered', 'flush-entered'])
    expect(disposed).not.toHaveBeenCalled()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeDefined()
    expect((await runtime.store.listCompletions())[0]).toMatchObject({
      workerId: 'delayed-winner',
      reservedByCallId: waitCallId,
    })
    expect((await runtime.store.listCompletions())[0]?.deliveredByCallId).toBeUndefined()

    commitGate.resolve()
    await Promise.all([idle, flush])
    await until(() => disposed.mock.calls.length === 1)

    expect(order.indexOf('commit-finished')).toBeLessThan(order.indexOf('runtime-disposed'))
    expect((await runtime.store.listCompletions())[0]).toMatchObject({
      workerId: 'delayed-winner',
      deliveredByCallId: waitCallId,
    })
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeUndefined()
  })
})
