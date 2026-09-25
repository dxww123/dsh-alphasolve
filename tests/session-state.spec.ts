import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'

import { alphaSolveSessionProjection, hasDurableAlphaSolveResumeIntent } from '../src/session-state.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  ctx.sessionProjections.register(alphaSolveSessionProjection)
  return { ctx, session: ctx.sessions.create(SessionId('projection-source')) }
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
    const state = ctx.sessionProjections.stateOf(restored, 'alphasolve')
    expect(state).toEqual(ctx.sessionProjections.stateOf(session, 'alphasolve'))
    expect(state).toMatchObject({ pendingCalls: {}, successfulWaitCallIds: ['wait-ok'] })
    if (state === undefined) throw new Error('projection missing')
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(true)
  })

  it('keeps a later stop authoritative when an earlier activation completes afterward', async () => {
    const { ctx, session } = await harness()
    call(session, 'activate', 'alphasolve_activate')
    call(session, 'stop', 'alphasolve_stop')
    result(session, 'activate', { activated: true })
    const state = ctx.sessionProjections.stateOf(session, 'alphasolve')
    if (state === undefined) throw new Error('projection missing')
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
    const state = ctx.sessionProjections.stateOf(session, 'alphasolve')
    if (state === undefined) throw new Error('projection missing')
    expect(hasDurableAlphaSolveResumeIntent(state)).toBe(false)
    expect(state.pendingCalls).toEqual({})
  })
})
