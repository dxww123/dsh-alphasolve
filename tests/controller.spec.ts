import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  agentEvents,
  assembleContextFor,
  type Agent,
  type AgentStatus,
} from '@deepseek-ai/dsh-agent'
import {
  ToolCallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  defineContentToolFixture,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import {
  ACTIVATE_TOOL_NAME,
  AlphaSolveController,
  isTopLevelAgent,
  requestsAlphaSolvePreflight,
} from '../src/controller.js'
import {
  RUNTIME_TOOL_NAMES,
  type AlphaSolveRuntime,
  type RuntimeActivationResult,
  type RuntimeRestoreResult,
} from '../src/runtime.js'

const contexts: Context[] = []

class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continued' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function message(text: string, source: UserMessage['source'] = { kind: 'user' }): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function createAgent(ctx: Context, id: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    agentOptions: { provider: 'unused', model: 'unused' },
  })
  return handle.agent
}

function registerRequiredFileTools(ctx: Context): void {
  for (const name of ['read', 'write', 'edit', 'glob', 'grep']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} capability fixture`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: name }]),
    }))
  }
}

async function submit(ctx: Context, agent: Agent, input: UserMessage): Promise<void> {
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: input, turn: 1 })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      messages: [input],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter', messages: [input] }),
  )
  expect(decision).toMatchObject({ kind: 'enter' })
}

function status(ctx: Context, agent: Agent, value: AgentStatus): void {
  agentEvents(ctx, agent).emit('agent/status', { status: value })
}

function settled(ctx: Context, agent: Agent, _turn: number): void {
  status(ctx, agent, 'idle')
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition did not become true')
}

describe('dormant AlphaSolve trigger', () => {
  it('requires a whole ASCII word in a direct user message', () => {
    expect(requestsAlphaSolvePreflight(message('Use AlphaSolve to solve this.'))).toBe(true)
    expect(requestsAlphaSolvePreflight(message('Use alphasolve, please.'))).toBe(true)
    expect(requestsAlphaSolvePreflight(message('Use alphaSolve-style reasoning.'))).toBe(true)

    expect(requestsAlphaSolvePreflight(message('Use myalphasolve now.'))).toBe(false)
    expect(requestsAlphaSolvePreflight(message('Use alphasolver now.'))).toBe(false)
    expect(requestsAlphaSolvePreflight(message('Use alphasolve_workflow now.'))).toBe(false)
    expect(requestsAlphaSolvePreflight(message(
      'AlphaSolve appears only in injected plugin context.',
      { kind: 'alphasolve' },
    ))).toBe(false)
  })

  it('accepts only a top-level session, never a fork or subagent origin', () => {
    const top = { session: { header: {} } } as unknown as Agent
    const fork = {
      session: { header: { parentSession: SessionId('parent') } },
    } as unknown as Agent
    const subagent = {
      session: { header: { origin: 'subagent' } },
    } as unknown as Agent

    expect(isTopLevelAgent(top)).toBe(true)
    expect(isTopLevelAgent(fork)).toBe(false)
    expect(isTopLevelAgent(subagent)).toBe(false)
  })
})

describe('session-scoped preflight lifecycle', () => {
  it('temporarily exposes only read plus the local activation tool', async () => {
    const ctx = await harness()
    for (const name of ['read', 'bash']) {
      ctx.tools.register(defineContentToolFixture({
        name,
        description: `${name} fixture`,
        parameters: {},
        execute: () => Promise.resolve([{ type: 'text', text: name }]),
      }))
    }
    const agent = await createAgent(ctx, 'controller-preflight-tools')
    new AlphaSolveController(ctx).install()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    expect(ctx.tools.get('read', agent)).toBeDefined()
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()
    expect(ctx.tools.get('bash', agent)).toBeUndefined()

    settled(ctx, agent, 1)
    await until(() => ctx.tools.get(ACTIVATE_TOOL_NAME, agent) === undefined)
    expect(ctx.tools.get('bash', agent)).toBeDefined()
  })

  it('stages the preflight prompt and activation tool before the triggering step assembly', async () => {
    const ctx = await harness()
    const agent = await createAgent(ctx, 'controller-preflight-context')
    new AlphaSolveController(ctx).install()
    const input = message('Use AlphaSolve to solve problem.md.')
    const signal = new AbortController().signal

    agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: input, turn: 1 })
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))

    expect(assembly.sections).toContainEqual(expect.objectContaining({
      name: 'alphasolve:preflight',
      text: expect.stringContaining('call alphasolve_activate'),
    }))
    expect(assembly.tools.map(tool => tool.name)).toContain(ACTIVATE_TOOL_NAME)
  })

  it('publishes preflight and activated tools only in the triggering agent scope', async () => {
    const ctx = await harness()
    registerRequiredFileTools(ctx)
    const first = await createAgent(ctx, 'controller-first')
    const second = await createAgent(ctx, 'controller-second')
    let runtimeFiber: Fiber | undefined
    const runtimeDispose = vi.fn(async () => runtimeFiber?.dispose())
    const activate = vi.fn(async (agent: Agent): Promise<RuntimeActivationResult> => {
      runtimeFiber = agent.ctx.plugin((inner: Context) => {
        inner.tools.register(defineContentToolFixture({
          name: RUNTIME_TOOL_NAMES.worker,
          description: 'test runtime worker',
          parameters: {},
          execute: () => Promise.resolve([{ type: 'text', text: 'worker' }]),
        }))
        inner.tools.register(defineContentToolFixture({
          name: RUNTIME_TOOL_NAMES.wait,
          description: 'test runtime wait',
          parameters: {},
          execute: () => Promise.resolve([{ type: 'text', text: 'wait' }]),
        }))
      })
      await runtimeFiber
      return {
        activated: true,
        workspace: '/test/workspace',
        capacity: 2,
        resumed: false,
        runtime: { dispose: runtimeDispose } as unknown as AlphaSolveRuntime,
      }
    })
    new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, first, message('Please solve it with AlphaSolve.'))
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, first)).toBeDefined()
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, second)).toBeUndefined()

    const activation = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('activate-first'),
      name: ACTIVATE_TOOL_NAME,
      arguments: { capacity: 2, overwriteSolution: false },
      agent: first,
    })
    expect(activation).toMatchObject({ isError: false, value: { activated: true, capacity: 2 } })
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, first)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, first)).toBeDefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, first)).toBeDefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, second)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, second)).toBeUndefined()
    const guessed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('second-guesses-worker'),
      name: RUNTIME_TOOL_NAMES.worker,
      arguments: {},
      agent: second,
    })
    expect(guessed.isError).toBe(true)
    expect(guessed.content[0]).toMatchObject({ text: expect.stringMatching(/unknown tool/i) })
  })

  it('unloads an ordinary preflight after its one response turn', async () => {
    const ctx = await harness()
    const agent = await createAgent(ctx, 'controller-one-turn')
    const activate = vi.fn()
    new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, agent, message('Explain AlphaSolve to me.'))
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()

    settled(ctx, agent, 1)
    await until(() => ctx.tools.get(ACTIVATE_TOOL_NAME, agent) === undefined)
    expect(activate).not.toHaveBeenCalled()
  })

  it('cannot authorize an overwrite before the authoritative confirmation round trip', async () => {
    const ctx = await harness()
    registerRequiredFileTools(ctx)
    const agent = await createAgent(ctx, 'controller-no-first-turn-overwrite')
    const activate = vi.fn()
    new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const activation = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('activation-illegal-overwrite'),
      name: ACTIVATE_TOOL_NAME,
      arguments: { overwriteSolution: true },
      agent,
    })
    expect(activation).toMatchObject({
      isError: false,
      value: { activated: false, reason: 'overwrite_confirmation_not_established' },
    })
    expect(activate).not.toHaveBeenCalled()
  })

  it('retains confirmation preflight for exactly the next direct user response', async () => {
    const ctx = await harness()
    registerRequiredFileTools(ctx)
    const agent = await createAgent(ctx, 'controller-confirmation')
    const activate = vi.fn(async (): Promise<RuntimeActivationResult> => ({
      activated: false,
      workspace: '/test/workspace',
      reason: 'solution_exists_confirmation_required',
    }))
    new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const activation = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('activation-needs-confirmation'),
      name: ACTIVATE_TOOL_NAME,
      arguments: { overwriteSolution: false },
      agent,
    })
    expect(activation).toMatchObject({
      isError: false,
      value: { activated: false, reason: 'solution_exists_confirmation_required' },
    })

    settled(ctx, agent, 1)
    await Promise.resolve()
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()

    await submit(ctx, agent, message('Yes, back it up and overwrite it.'))
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()
    settled(ctx, agent, 2)
    await until(() => ctx.tools.get(ACTIVATE_TOOL_NAME, agent) === undefined)
  })

  it('does not call the activator or publish a runtime for an already-aborted tool context', async () => {
    const ctx = await harness()
    const agent = await createAgent(ctx, 'controller-aborted-activation')
    const activate = vi.fn(async (): Promise<RuntimeActivationResult> => {
      throw new Error('activator must not be reached')
    })
    new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const tool = ctx.tools.get(ACTIVATE_TOOL_NAME, agent)
    expect(tool).toBeDefined()

    const abort = new AbortController()
    const reason = new DOMException('activation was cancelled', 'AbortError')
    abort.abort(reason)
    const exec = {
      signal: abort.signal,
      callId: ToolCallId('activation-already-aborted'),
      name: ACTIVATE_TOOL_NAME,
      arguments: { overwriteSolution: false },
      agent,
      token: Symbol('activation-already-aborted'),
      deferContext: vi.fn(),
      concludeTurn: vi.fn(),
    } as unknown as ToolRunContext

    await expect(tool?.execute({ overwriteSolution: false }, exec)).rejects.toBe(reason)
    expect(activate).not.toHaveBeenCalled()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.wait, agent)).toBeUndefined()

    settled(ctx, agent, 1)
    await until(() => ctx.tools.get(ACTIVATE_TOOL_NAME, agent) === undefined)
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
  })
})

describe('same-session cold resume lifecycle', () => {
  it('finishes awaited agent initialization before the first followup can use runtime tools', async () => {
    const ctx = await harness()
    const adapter = new CapturingAdapter()
    ctx.llm.registerAdapter(['unused'], adapter)
    const gate = Promise.withResolvers<void>()
    ctx.on('dispose', () => gate.resolve())
    let runtimeFiber: Fiber | undefined
    const runtimeDispose = vi.fn(async () => runtimeFiber?.dispose())
    const restore = vi.fn(async (agent: Agent): Promise<RuntimeRestoreResult> => {
      await gate.promise
      runtimeFiber = agent.ctx.plugin((inner: Context) => {
        inner.tools.register(defineContentToolFixture({
          name: RUNTIME_TOOL_NAMES.worker,
          description: 'restored worker',
          parameters: {},
          execute: () => Promise.resolve([{ type: 'text', text: 'worker' }]),
        }))
      })
      await runtimeFiber
      return {
        restored: true,
        workspace: '/test/workspace',
        capacity: 3,
        runtime: { dispose: runtimeDispose } as unknown as AlphaSolveRuntime,
      }
    })
    new AlphaSolveController(ctx, { restore }).install()
    const agent = await createAgent(ctx, 'controller-cold-resume')
    let claimed = 0
    ctx.on('agent/inbox/claimed', ({ agent: subject }) => {
      if (subject === agent) claimed += 1
    })

    const initialized = agent.runMaintenance(() =>
      agentEvents(ctx, agent).serial('agent/created', { source: 'resume' }))
    agent.followup(message('继续'))
    await Promise.resolve()

    expect(restore).toHaveBeenCalledTimes(1)
    expect(claimed).toBe(0)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()

    gate.resolve()
    await initialized
    await agent.whenIdle()

    expect(claimed).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain(RUNTIME_TOOL_NAMES.worker)
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeUndefined()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeDefined()
  })

  it('awaits cancelled initialization work and leaves no recovery diagnostic or mounted preflight', async () => {
    const ctx = await harness()
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<AbortSignal>()
    ctx.on('dispose', () => gate.resolve())
    const restore = vi.fn(async (
      _agent: Agent,
      _defaults: object,
      _onDisposed: () => void,
      signal?: AbortSignal,
    ): Promise<RuntimeRestoreResult> => {
      if (signal === undefined) throw new Error('restore must receive initialization cancellation')
      entered.resolve(signal)
      await gate.promise
      return { restored: false, workspace: '/test/workspace', reason: 'late restore failure' }
    })
    new AlphaSolveController(ctx, { restore }).install()
    const agent = await createAgent(ctx, 'controller-cancelled-resume')
    const abort = new AbortController()
    const initialization = agent.runMaintenance(() => agentEvents(ctx, agent).serial('agent/created', {
      source: 'resume', signal: abort.signal,
    }))
    let initialized = false
    void initialization.then(() => { initialized = true })
    const restoreSignal = await entered.promise
    abort.abort(new Error('resume cancelled'))
    expect(restoreSignal.aborted).toBe(true)
    await Promise.resolve()
    expect(initialized).toBe(false)
    gate.resolve()
    await initialization
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeUndefined()
    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()
  })

  it('silently returns to keyword-gated dormancy when no durable intent exists', async () => {
    const ctx = await harness()
    const restore = vi.fn(async (): Promise<RuntimeRestoreResult> => ({
      restored: false,
      workspace: '/test/workspace',
    }))
    new AlphaSolveController(ctx, { restore }).install()
    const agent = await createAgent(ctx, 'controller-resume-dormant')

    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    await agent.whenIdle()
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeUndefined()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()
  })

  it('injects one diagnostic when an eligible resumed runtime cannot be restored', async () => {
    const ctx = await harness()
    const restore = vi.fn(async (): Promise<RuntimeRestoreResult> => ({
      restored: false,
      workspace: '/test/workspace',
      reason: 'problem.md changed during recovery',
    }))
    new AlphaSolveController(ctx, { restore }).install()
    const agent = await createAgent(ctx, 'controller-resume-failure')

    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    await agent.whenIdle()

    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(JSON.stringify(agent.inbox.nextStep[0])).toContain('could not restore')
    expect(JSON.stringify(agent.inbox.nextStep[0])).toContain('problem.md changed')
  })

  it('injects one cold-resume diagnostic naming every missing preset file tool', async () => {
    const ctx = await harness()
    const restore = vi.fn(async () => ({
      restored: false as const,
      workspace: '/test/workspace',
      reason: 'agent_preset_missing_required_tools',
      agentPreset: 'minimal',
      missingTools: ['write', 'edit', 'glob', 'grep'],
    }))
    new AlphaSolveController(ctx, { restore }).install()
    const agent = await createAgent(ctx, 'controller-resume-missing-tools')
    const inject = vi.spyOn(agent, 'inject')

    await agentEvents(ctx, agent).serial('agent/created', { source: 'resume' })
    await agent.whenIdle()

    expect(inject).toHaveBeenCalledTimes(1)
    const diagnostic = JSON.stringify(inject.mock.calls[0]?.[0])
    expect(diagnostic).toContain('minimal')
    for (const name of ['write', 'edit', 'glob', 'grep']) expect(diagnostic, name).toContain(name)
  })
})
