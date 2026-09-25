/** AlphaSolve notices and resumable state derived from committed Session events. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

const stateSchema = z.object({
  pendingCalls: z.record(z.string(), z.object({
    name: z.enum(['alphasolve_activate', 'alphasolve_wait']),
    sequence: z.number().int().nonnegative(),
  })),
  latestActivation: z.number().int().min(-1),
  latestStop: z.number().int().min(-1),
  successfulWaitCallIds: z.array(z.string()),
})

/** Activation ordering and durable acknowledgements needed after a process restart. */
export type AlphaSolveSessionState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    alphasolve: { readonly kind: 'alphasolve' } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    alphasolve: AlphaSolveSessionState
  }
}

function activated(event: SessionEvent<'tool/result'>): boolean {
  const text = event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  try {
    const result: unknown = JSON.parse(text)
    return typeof result === 'object' && result !== null && 'activated' in result && result.activated === true
  } catch (_error) {
    // A non-JSON tool result cannot establish AlphaSolve activation.
    return false
  }
}

/** Session fold for activation authorization and successful wait delivery. */
export const alphaSolveSessionProjection = {
  key: 'alphasolve',
  stateSchema,
  stateVersion: 1,
  init: () => ({ pendingCalls: {}, latestActivation: -1, latestStop: -1, successfulWaitCallIds: [] }),
  apply: (state, event) => {
    if (event.type === 'tool/call') {
      const { name, callId } = event.data
      if (name === 'alphasolve_stop') return { ...state, latestStop: event.seq }
      if (name !== 'alphasolve_activate' && name !== 'alphasolve_wait') return state
      return {
        ...state,
        pendingCalls: { ...state.pendingCalls, [callId]: { name, sequence: event.seq } },
      }
    }
    if (event.type !== 'tool/result') return state
    const callId = event.data.message.toolCallId
    const call = Object.hasOwn(state.pendingCalls, callId) ? state.pendingCalls[callId] : undefined
    if (call === undefined) return state
    const pendingCalls = { ...state.pendingCalls }
    delete pendingCalls[callId]
    if (event.data.message.isError === true) return { ...state, pendingCalls }
    if (call.name === 'alphasolve_wait') {
      return { ...state, pendingCalls, successfulWaitCallIds: [...state.successfulWaitCallIds, callId] }
    }
    return {
      ...state,
      pendingCalls,
      latestActivation: activated(event) ? Math.max(state.latestActivation, call.sequence) : state.latestActivation,
    }
  },
} satisfies ProjectionDefinition<'alphasolve'>

/** Read the registered AlphaSolve state at this Agent's committed Session cursor.
 * @param agent - live Agent whose Session owns the runtime.
 * @returns current activation and delivery state.
 */
export function alphaSolveSessionState(agent: Agent): AlphaSolveSessionState {
  const state = agent.ctx.sessionProjections.stateOf(agent.session, 'alphasolve')
  if (state === undefined) throw new Error('AlphaSolve Session projection is not registered')
  return state
}

/** Decide whether a successful activation has a later explicit stop.
 * @param state - current AlphaSolve Session projection.
 * @returns whether the runtime may attempt same-session restoration.
 */
export function hasDurableAlphaSolveResumeIntent(state: AlphaSolveSessionState): boolean {
  return state.latestActivation >= 0 && state.latestActivation > state.latestStop
}
