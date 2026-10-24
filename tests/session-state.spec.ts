import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

import { AlphaSolveSessionStateService, hasDurableAlphaSolveResumeIntent } from '../src/session-state.js'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(register = true): Promise<{ ctx: Context; session: Session; owner: Fiber | undefined }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  const owner = register ? ctx.plugin(AlphaSolveSessionStateService) : undefined
  if (owner !== undefined) await owner
  return { ctx, session: ctx.sessions.create(SessionId('projection-source')), owner }
}

function call(session: Session, id: string, name: string): void {
  session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: '{}' })
}

function result(session: Session, id: string, value: unknown, isError = false): void {
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(id),
      content: [{ type: 'text', text: JSON.stringify(value) }],
      isError,
    }),
  }, { surfaceOp: 'append' })
}

describe('AlphaSolve Session projection', () => {
  it('restores activation and only successful wait acknowledgements from the committed log', async () => {
    const { ctx, session } = await harness()
    const events: SessionEvent[] = []
    ctx.on('session/event', (owner, event) => { if (owner === session) events.push(event) })
    call(session, 'activate', 'alphasolve_activate')
    result(session, 'activate', { activated: true })
    call(session, 'wait-ok', 'alphasolve_wait')
    result(session, 'wait-ok', { completed: [] })
    call(session, 'wait-failed', 'alphasolve_wait')
    result(session, 'wait-failed', { message: 'cancelled' }, true)
    const restored = ctx.sessions.create(SessionId('projection-restored'), { seed: events })
    const state = ctx.alphaSolveSessions.stateOf(restored)
    expect(state).toEqual(ctx.alphaSolveSessions.stateOf(session))
    expect(state).toMatchObject({ pendingCalls: {}, successfulWaitCallIds: ['wait-ok'] })
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(true)
  })

  it('keeps a later stop authoritative when an earlier activation completes afterward', async () => {
    const { ctx, session } = await harness()
    call(session, 'activate', 'alphasolve_activate')
    call(session, 'stop', 'alphasolve_stop')
    result(session, 'activate', { activated: true })
    const state = ctx.alphaSolveSessions.stateOf(session)
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(false)
  })

  it('does not establish activation from failed calls or malformed results', async () => {
    const { ctx, session } = await harness()
    call(session, 'failed', 'alphasolve_activate')
    result(session, 'failed', { activated: true }, true)
    call(session, 'malformed', 'alphasolve_activate')
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('malformed'), content: [{ type: 'text', text: 'invalid json' }], isError: false,
      }),
    }, { surfaceOp: 'append' })
    const state = ctx.alphaSolveSessions.stateOf(session)
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(false)
    expect(state.pendingCalls).toEqual({})
  })
})

/** Hold only AlphaSolve registration delivery, retaining the real fiber-owned acquisition. */
function holdRegistration(): { entered: Promise<void>; release: () => void } {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const register = SessionProjections.prototype.register
  vi.spyOn(SessionProjections.prototype, 'register').mockImplementation(async function (definition) {
    const handle = await register.call(this, definition)
    if (definition.key === 'alphasolve') {
      entered.resolve()
      await released.promise
    }
    return handle
  })
  return { entered: entered.promise, release: () => released.resolve() }
}

describe('AlphaSolve projection ownership', () => {
  it('finishes registration before the owner becomes ready and preserves events committed during the wait', async () => {
    const { ctx, session } = await harness(false)
    const barrier = holdRegistration()
    const owner = ctx.plugin(AlphaSolveSessionStateService)
    let ready = false
    const initialized = Promise.resolve(owner).then(() => { ready = true })
    await barrier.entered
    expect(ready).toBe(false)
    call(session, 'activate-during-registration', 'alphasolve_activate')
    result(session, 'activate-during-registration', { activated: true })
    barrier.release()
    await initialized
    expect(hasDurableAlphaSolveResumeIntent(ctx.alphaSolveSessions.stateOf(session))).toBe(true)
  })

  it('releases checkpoint participation and reconstructs durable intent after owner replacement', async () => {
    const { ctx, session, owner } = await harness()
    const events: SessionEvent[] = []
    ctx.on('session/event', (current, event) => { if (current === session) events.push(event) })
    call(session, 'activate-before-dispose', 'alphasolve_activate')
    result(session, 'activate-before-dispose', { activated: true })
    expect(ctx.sessionProjections.checkpoint(session)).toHaveProperty('alphasolve')
    await owner!.dispose()
    expect(ctx.get('alphaSolveSessions')).toBeUndefined()
    expect(ctx.sessionProjections.checkpoint(session)).not.toHaveProperty('alphasolve')
    call(session, 'wait-while-unloaded', 'alphasolve_wait')
    result(session, 'wait-while-unloaded', { completed: [] })
    await ctx.plugin(AlphaSolveSessionStateService)
    const restored = ctx.sessions.create(SessionId('replaced-owner-restore'), { seed: events })
    const state = ctx.alphaSolveSessions.stateOf(restored)
    expect(state).toEqual(ctx.alphaSolveSessions.stateOf(session))
    expect(state.successfulWaitCallIds).toEqual(['wait-while-unloaded'])
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(true)
  })

  it('fails owner activation when another projection version already owns the key', async () => {
    const { ctx, session } = await harness(false)
    await ctx.sessionProjections.register({
      key: 'alphasolve', stateSchema: z.number(), stateVersion: 2,
      init: () => 0, apply: state => state,
    })
    const owner = ctx.plugin(AlphaSolveSessionStateService)
    await expect(Promise.resolve(owner)).rejects.toThrow('already registered at stateVersion 2')
    expect(ctx.get('alphaSolveSessions')).toBeUndefined()
    expect(ctx.sessionProjections.checkpoint(session).alphasolve?.ver).toBe(2)
  })

  it('does not publish its reader when disposed during asynchronous registration', async () => {
    const { ctx, session } = await harness(false)
    const barrier = holdRegistration()
    const owner = ctx.plugin(AlphaSolveSessionStateService)
    const rejected = expect(Promise.resolve(owner)).rejects.toThrow()
    await barrier.entered
    const disposed = owner.dispose()
    barrier.release()
    await disposed
    await rejected
    expect(ctx.get('alphaSolveSessions')).toBeUndefined()
    expect(ctx.sessionProjections.checkpoint(session)).not.toHaveProperty('alphasolve')
  })
})
