import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentHandle, CreateAgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

import { createRolePolicy } from '../src/permissions.js'
import {
  ROLE_INACTIVITY_TIMEOUT_MS,
  RoleTechnicalTimeoutError,
  runRoleAgent,
  type RoleRunFailure,
} from '../src/role-runner.js'

function options(parent: Agent) {
  const cwd = path.resolve('/tmp/dsh-alphasolve-role-timeout')
  return {
    parent,
    role: 'reasoning' as const,
    cwd,
    persona: 'Bounded reasoning role.',
    prompt: 'Check one implication.',
    maxTurns: 2,
    signal: new AbortController().signal,
    permissionPolicy: createRolePolicy('reasoning', { workspace: cwd }),
    createTimeoutMs: 5,
    inactivityTimeoutMs: 5,
    disposeTimeoutMs: 5,
  }
}

describe('role Agent technical timeouts', () => {
  it('defaults the inactivity limit to exactly 3600 seconds', () => {
    expect(ROLE_INACTIVITY_TIMEOUT_MS).toBe(3_600_000)
  })

  it('bounds an Agent factory which ignores cancellation', async () => {
    const create = vi.fn(() => new Promise<AgentHandle>(() => undefined))
    const parent = {
      id: SessionId('parent-create-timeout'),
      options: {},
      session: { header: {}, requestHeader: () => undefined },
      ctx: { agents: { create }, get: vi.fn(() => undefined) },
    } as unknown as Agent

    await expect(runRoleAgent(options(parent))).rejects.toMatchObject({
      name: 'RoleTechnicalTimeoutError',
      phase: 'create',
    } satisfies Partial<RoleTechnicalTimeoutError>)
  })

  it('cancels, reports, and disposes a child with no observable activity', async () => {
    const cancel = vi.fn()
    const dispose = vi.fn(() => Promise.resolve())
    const failures: RoleRunFailure[] = []
    const child = {
      id: SessionId('hanging-role'),
      options: {},
      session: {},
      followup: vi.fn(),
      whenIdle: vi.fn(() => new Promise<void>(() => undefined)),
      cancel,
    } as unknown as Agent
    const create = vi.fn(() => Promise.resolve({ agent: child, dispose } as unknown as AgentHandle))
    const parent = {
      id: SessionId('parent-idle-timeout'),
      options: {},
      session: { header: {}, requestHeader: () => undefined },
      ctx: { agents: { create }, get: vi.fn(() => undefined) },
    } as unknown as Agent

    await expect(runRoleAgent({
      ...options(parent),
      onFailure: failure => failures.push(failure),
    })).rejects.toMatchObject({
      name: 'RoleTechnicalTimeoutError',
      phase: 'inactivity',
    } satisfies Partial<RoleTechnicalTimeoutError>)
    expect(cancel).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(failures).toMatchObject([{
      agentId: 'hanging-role',
      role: 'reasoning',
      phase: 'inactivity',
      text: '',
      steps: 0,
      error: { name: 'RoleTechnicalTimeoutError', phase: 'inactivity' },
    }])
  })

  it.each([true, false])('reads only the terminal retry response (response present: %s)', async (hasResponse) => {
    const dispose = vi.fn(() => Promise.resolve())
    let sessionEvent: ((session: unknown, event: unknown) => void) | undefined
    const child = {
      id: SessionId('retried-role'),
      options: {},
      session: {},
      followup: vi.fn(() => {
        for (const event of events) sessionEvent?.(child.session, event)
      }),
      whenIdle: vi.fn(() => Promise.resolve()),
      cancel: vi.fn(),
    } as unknown as Agent
    const events = [
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'stale attempt' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
      ...hasResponse ? [{ type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'fresh success' }] } } }] : [],
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const childCtx = {
      get: vi.fn(() => undefined),
      systemPrompt: { section: vi.fn(), getSectionOrder: vi.fn(() => 0) },
      tools: {
        get: vi.fn(() => undefined), presentAs: vi.fn(), restrict: vi.fn(), guard: vi.fn(),
      },
      on: vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
        if (name === 'session/event') sessionEvent = listener
        return vi.fn()
      }),
    }
    const parent = {
      id: SessionId('parent-retried-role'),
      options: {},
      session: { header: {}, requestHeader: () => undefined },
      ctx: {
        agents: { create: vi.fn(async (request: CreateAgentOptions) => {
          await request.setup?.(childCtx as Context, child)
          return { agent: child, dispose }
        }) },
        get: vi.fn(() => undefined),
      },
    } as unknown as Agent

    await expect(runRoleAgent(options(parent))).resolves.toMatchObject({
      agentId: 'retried-role',
      text: hasResponse ? 'fresh success' : '',
      stopReason: 'completed',
      turnEndReason: { kind: 'completed' },
    })
  })

  it('creates immutable role routes from the latest request or explicit selection', async () => {
    const factoryError = new Error('creation stopped after capturing options')
    const create = vi.fn(() => Promise.reject(factoryError))
    const logged: ModelSelection = {
      provider: 'live-provider', model: 'live-model', reasoningEffort: ReasoningEffortId('high'),
    }
    const parent = {
      id: SessionId('parent-current-route'),
      options: { provider: 'startup-provider', model: 'startup-model', maxTokens: 500 },
      session: { header: {}, requestHeader: () => ({ config: logged }) },
      ctx: { agents: { create }, get: vi.fn(() => undefined) },
    } as Agent

    await expect(runRoleAgent(options(parent))).rejects.toBe(factoryError)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      parentAgent: parent,
      agentOptions: { ...logged, maxTokens: 500 },
    }))

    await expect(runRoleAgent({
      ...options(parent), modelSelection: { provider: 'role-provider', model: 'role-model' },
    })).rejects.toBe(factoryError)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      agentOptions: { provider: 'role-provider', model: 'role-model', maxTokens: 500 },
    }))
  })

  it('renews inactivity on session events and nested-helper activity', async () => {
    vi.useFakeTimers()
    try {
      let resolveIdle: (() => void) | undefined
      let sessionActivity: ((session: unknown, event: unknown) => void) | undefined
      let streamActivity: ((payload: { agent: Agent }) => void) | undefined
      let preStep: ((
        payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
        next: () => Promise<{ kind: 'enter'; messages: [] }>,
      ) => Promise<unknown>) | undefined
      let nestedActivity: (() => void) | undefined
      const events: unknown[] = []
      const session = {}
      const child = {
        id: SessionId('active-role'),
        options: {},
        session,
        followup: vi.fn(),
        whenIdle: vi.fn(() => new Promise<void>(resolve => { resolveIdle = resolve })),
        cancel: vi.fn(),
      } as unknown as Agent
      const childCtx = {
        get: vi.fn(() => undefined),
        systemPrompt: { section: vi.fn(), getSectionOrder: vi.fn(() => 0) },
        tools: {
          get: vi.fn(() => undefined),
          presentAs: vi.fn(() => vi.fn()),
          restrict: vi.fn(),
          guard: vi.fn(() => vi.fn()),
        },
        on: vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
          if (name === 'session/event') sessionActivity = listener
          if (name === 'agent/assistant-stream') streamActivity = listener
          if (name === 'agent/pre-step') preStep = listener as typeof preStep
          return vi.fn()
        }),
      }
      const dispose = vi.fn(() => Promise.resolve())
      const create = vi.fn(async (request: { setup: (ctx: unknown, child: Agent) => Promise<void> }) => {
        await request.setup(childCtx, child)
        return { agent: child, dispose }
      })
      const parent = {
        id: SessionId('parent-active-role'),
        options: {},
        session: { header: {}, requestHeader: () => undefined },
        ctx: { agents: { create }, get: vi.fn(() => undefined) },
      } as unknown as Agent

      const run = runRoleAgent({
        ...options(parent),
        createTimeoutMs: 100,
        inactivityTimeoutMs: 25,
        disposeTimeoutMs: 100,
        setupHelpers: (_ctx, _child, reportActivity) => { nestedActivity = reportActivity },
      })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(20)
      streamActivity?.({ agent: child })
      await vi.advanceTimersByTimeAsync(20)
      await preStep?.(
        { agent: child, turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter', messages: [] }),
      )
      sessionActivity?.(session, { type: 'step/start', data: { turn: 1, step: 1 } })
      await vi.advanceTimersByTimeAsync(20)
      nestedActivity?.()
      await vi.advanceTimersByTimeAsync(20)
      sessionActivity?.(session, { type: 'tool/result' })
      events.push(
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'still active' }] } },
        },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      )
      for (const event of events) sessionActivity?.(session, event)
      resolveIdle?.()
      await vi.advanceTimersByTimeAsync(0)

      await expect(run).resolves.toMatchObject({ text: 'still active', stopReason: 'completed', steps: 1 })
      expect(child.cancel).not.toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ parentAgent: parent }))
      expect(childCtx.systemPrompt.section).toHaveBeenCalledWith({
        name: 'deployment:persona-prefix', order: 0, text: 'Bounded reasoning role.',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([1, 2])('caps model requests across %i turns', async (turns) => {
    let resolveIdle: (() => void) | undefined
    let sessionEvent: ((session: unknown, event: unknown) => void) | undefined
    let preStep: ((
      payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<{ kind: 'enter'; messages: [] }>,
    ) => Promise<unknown>) | undefined
    const events: unknown[] = []
    const session = {}
    const cancel = vi.fn()
    const child = {
      id: SessionId('bounded-role'),
      options: {},
      session,
      followup: vi.fn(),
      whenIdle: vi.fn(() => new Promise<void>(resolve => { resolveIdle = resolve })),
      cancel,
    } as unknown as Agent
    const childCtx = {
      get: vi.fn(() => undefined),
      systemPrompt: { section: vi.fn(), getSectionOrder: vi.fn(() => 0) },
      tools: {
        get: vi.fn(() => undefined),
        presentAs: vi.fn(() => vi.fn()),
        restrict: vi.fn(),
        guard: vi.fn(() => vi.fn()),
      },
      on: vi.fn((name: string, listener: (...args: unknown[]) => unknown) => {
        if (name === 'session/event') sessionEvent = listener
        if (name === 'agent/pre-step') preStep = listener as typeof preStep
        return vi.fn()
      }),
    }
    const dispose = vi.fn(() => Promise.resolve())
    const parent = {
      id: SessionId('parent-bounded-role'),
      options: {},
      session: { header: {}, requestHeader: () => undefined },
      ctx: {
        agents: {
          create: vi.fn(async (request: { setup: (ctx: unknown, child: Agent) => Promise<void> }) => {
            await request.setup(childCtx, child)
            return { agent: child, dispose }
          }),
        },
        get: vi.fn(() => undefined),
      },
    } as unknown as Agent

    const run = runRoleAgent({
      ...options(parent),
      createTimeoutMs: 100,
      inactivityTimeoutMs: 1_000,
      disposeTimeoutMs: 100,
    })
    await Promise.resolve()

    for (const request of [1, 2]) {
      const turn = turns === 1 ? 1 : request
      const step = turns === 1 ? request : 1
      await preStep?.(
        { agent: child, turn, step, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter', messages: [] }),
      )
      sessionEvent?.(session, { type: 'step/start', data: { turn, step } })
    }
    const downstream = vi.fn(() => Promise.resolve({ kind: 'enter' as const, messages: [] as [] }))
    await expect(preStep?.(
      { agent: child, turn: turns, step: turns === 1 ? 3 : 2, signal: new AbortController().signal },
      downstream,
    )).resolves.toEqual({ kind: 'reject' })
    expect(downstream).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })

    events.push(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'step/start', data: { turn: 1, step: 2 } },
      { type: 'step/end', data: { turn: 1, step: 2 } },
      {
        type: 'turn/end',
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent' } } },
      },
    )
    for (const event of events) {
      if (typeof event === 'object' && event !== null && 'type' in event && event.type !== 'step/start') {
        sessionEvent?.(session, event)
      }
    }
    resolveIdle?.()

    await expect(run).resolves.toMatchObject({ stopReason: 'max_turns', steps: 2 })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
