/** Dormant global controller and one-turn, session-scoped AlphaSolve preflight. */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'

import {
  activateAlphaSolveRuntime,
  type AlphaSolveRuntime,
  type AlphaSolveRuntimeDefaults,
  type RuntimeActivationRequest,
  type RuntimeActivationResult,
} from './runtime.js'

export const ACTIVATE_TOOL_NAME = 'alphasolve_activate'

const PREFLIGHT_PROMPT = `A direct user message mentioned AlphaSolve. Decide from that direct message whether the user affirmatively asks you to solve the current workspace's problem.md in the AlphaSolve way.

This is only a one-turn preflight; do not activate for explanations, comparisons, quoted text, negation, or discussion about AlphaSolve itself. If there is no affirmative solve intent, answer normally and do not call alphasolve_activate.

For an affirmative solve request:
1. Check problem.md in the session workspace. It must exist, be a non-empty ordinary UTF-8 file, and stay inside the selected workspace. hint.md is optional. If problem.md is absent or invalid, explain that directly and do not activate.
2. Check whether solution.md already exists. Even if you inspect it first, call alphasolve_activate once with overwriteSolution=false so the plugin can perform the authoritative race-safe check. If it reports solution_exists_confirmation_required, ask the user whether this activation may back up and overwrite solution.md. Do not infer authorization from an earlier activation or from vague agreement.
3. Pass a positive integer capacity only when this direct request explicitly specifies the maximum worker count. Otherwise omit it; project/user/default precedence applies.
4. After the user explicitly authorizes overwrite, call alphasolve_activate with overwriteSolution=true. The confirmation turn does not need to repeat the AlphaSolve keyword.

Never use bash or arbitrary code to perform these checks.`

export interface ControllerOptions extends AlphaSolveRuntimeDefaults {
  /** Test seam; production mounts the real runtime. */
  readonly activate?: typeof activateAlphaSolveRuntime
}

interface PreflightState {
  readonly kind: 'preflight'
  readonly dispose: () => void
  awaitingConfirmation: boolean
  confirmationResponseStarted: boolean
}

interface RuntimeState {
  readonly kind: 'runtime'
  readonly runtime: AlphaSolveRuntime
}

type ControllerState = PreflightState | RuntimeState

function messageText(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Strict dormant trigger: direct human source plus whole ASCII word, case-insensitive. */
export function requestsAlphaSolvePreflight(message: UserMessage): boolean {
  return message.source.kind === 'user' && /\balphasolve\b/i.test(messageText(message))
}

/** Subagent/fork sessions never receive the dormant trigger controller. */
export function isTopLevelAgent(agent: Agent): boolean {
  return agent.session.header.parentSession === undefined
    && agent.session.header.origin !== 'subagent'
}

function argumentRecord(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(`${ACTIVATE_TOOL_NAME} arguments must be an object`)
  }
  return args as Record<string, unknown>
}

function activationRequest(args: unknown): RuntimeActivationRequest {
  const record = argumentRecord(args)
  const unexpected = Object.keys(record).filter(key => key !== 'capacity' && key !== 'overwriteSolution')
  if (unexpected.length > 0) throw new TypeError(`${ACTIVATE_TOOL_NAME} received unexpected argument ${unexpected[0]}`)
  const capacity = record.capacity
  if (capacity !== undefined
    && (typeof capacity !== 'number' || !Number.isSafeInteger(capacity) || capacity < 1)) {
    throw new TypeError('alphasolve_activate.capacity must be a positive safe integer')
  }
  if (record.overwriteSolution !== undefined && typeof record.overwriteSolution !== 'boolean') {
    throw new TypeError('alphasolve_activate.overwriteSolution must be a boolean')
  }
  return {
    ...(capacity === undefined ? {} : { capacity: capacity as number }),
    ...(record.overwriteSolution === undefined ? {} : {
      overwriteSolution: record.overwriteSolution as boolean,
    }),
  }
}

function publicActivationResult(result: RuntimeActivationResult): Record<string, unknown> {
  return {
    activated: result.activated,
    workspace: result.workspace,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.capacity === undefined ? {} : { capacity: result.capacity }),
    ...(result.resumed === undefined ? {} : { resumed: result.resumed }),
  }
}

/** Owns every dynamic child fiber created by the otherwise dormant plugin. */
export class AlphaSolveController {
  private readonly states = new Map<Agent, ControllerState>()
  private readonly activate: typeof activateAlphaSolveRuntime

  constructor(
    private readonly ctx: Context,
    private readonly options: ControllerOptions = {},
  ) {
    this.activate = options.activate ?? activateAlphaSolveRuntime
  }

  install(): () => Promise<void> {
    // Claiming happens immediately before prompt/tool assembly. Install the
    // scoped preflight synchronously here so its section and activation tool
    // are present in the frozen assembly for the triggering step. pre-step
    // below remains the authoritative decision/lifecycle seam.
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (this.states.has(agent)) return
      if (!isTopLevelAgent(agent) || !requestsAlphaSolvePreflight(message)) return
      this.mountPreflight(agent)
    })

    this.ctx.on('agent/pre-step', async (
      { agent, messages, signal },
      next,
    ): Promise<PreStepDecision> => {
      const current = this.states.get(agent)
      if (current?.kind === 'runtime') return next()
      if (current?.kind === 'preflight') {
        if (current.awaitingConfirmation && messages.some(message => message.source.kind === 'user')) {
          current.confirmationResponseStarted = true
        }
        try {
          const decision = await next()
          signal.throwIfAborted()
          if (decision.kind === 'reject') await this.disposePreflight(agent, current)
          return decision
        } catch (error) {
          await this.disposePreflight(agent, current)
          throw error
        }
      }
      return next()
    })

    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const state = this.states.get(agent)
      if (state?.kind !== 'preflight') return
      if (!state.awaitingConfirmation || state.confirmationResponseStarted) {
        void this.disposePreflight(agent, state)
      }
    })

    this.ctx.on('agent/disposed', ({ agent }) => {
      const state = this.states.get(agent)
      this.states.delete(agent)
      if (state?.kind === 'preflight') state.dispose()
      else if (state?.kind === 'runtime') void state.runtime.dispose()
    })

    return async () => {
      const states = [...this.states.entries()]
      this.states.clear()
      await Promise.allSettled(states.map(([, state]) => state.kind === 'preflight'
        ? state.dispose()
        : state.runtime.dispose()))
    }
  }

  private mountPreflight(agent: Agent): PreflightState {
    const disposers: Array<() => void> = []
    let disposed = false
    const state: PreflightState = {
      kind: 'preflight',
      awaitingConfirmation: false,
      confirmationResponseStarted: false,
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const dispose of disposers.splice(0).reverse()) dispose()
      },
    }
    this.states.set(agent, state)
    try {
      const ctx = agent.ctx
      disposers.push(ctx.systemPrompt.section({
        name: 'alphasolve:preflight',
        order: 50,
        text: PREFLIGHT_PROMPT,
      }))
      disposers.push(ctx.tools.register(this.activationTool(agent, state)))
      const allowedGlobals = ['read'].filter(name => ctx.tools.get(name) !== undefined)
      disposers.push(ctx.tools.restrict({ allow: allowedGlobals }))
      const allowed = new Set([ACTIVATE_TOOL_NAME, ...allowedGlobals])
      disposers.push(ctx.tools.guard(execution => allowed.has(execution.name)
        ? undefined
        : `tool "${execution.name}" is unavailable during AlphaSolve preflight`))
      return state
    } catch (error) {
      if (this.states.get(agent) === state) this.states.delete(agent)
      try {
        state.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'AlphaSolve preflight setup and rollback failed')
      }
      throw error
    }
  }

  private activationTool(agent: Agent, state: PreflightState): ToolDefinition {
    return {
      name: ACTIVATE_TOOL_NAME,
      description: 'Activate the full session-scoped AlphaSolve runtime after affirmative solve-intent and workspace preflight checks.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          capacity: { type: 'integer', minimum: 1 },
          overwriteSolution: { type: 'boolean' },
        },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args: unknown, exec: ToolRunContext): Promise<unknown> => {
        if (exec.signal.aborted) {
          throw exec.signal.reason ?? new DOMException('AlphaSolve activation cancelled', 'AbortError')
        }
        if (this.states.get(agent) !== state) throw new Error('AlphaSolve preflight is no longer active')
        const request = activationRequest(args)
        if (request.overwriteSolution === true
          && (!state.awaitingConfirmation || !state.confirmationResponseStarted)) {
          return {
            activated: false,
            workspace: agent.session.header.cwd ?? '',
            reason: 'overwrite_confirmation_not_established',
          }
        }
        let runtimeRef: AlphaSolveRuntime | undefined
        const result = await this.activate(
          agent,
          request,
          {
            ...(this.options.defaultCapacity === undefined ? {} : {
              defaultCapacity: this.options.defaultCapacity,
            }),
            ...(this.options.defaultDetailedTrace === undefined ? {} : {
              defaultDetailedTrace: this.options.defaultDetailedTrace,
            }),
          },
          () => {
            const current = this.states.get(agent)
            if (current?.kind === 'runtime' && current.runtime === runtimeRef) this.states.delete(agent)
          },
          exec.signal,
        )
        if (exec.signal.aborted) {
          if (result.activated) await result.runtime.dispose()
          throw exec.signal.reason ?? new DOMException('AlphaSolve activation cancelled', 'AbortError')
        }
        if (!result.activated) {
          if (result.reason === 'solution_exists_confirmation_required') {
            state.awaitingConfirmation = true
            state.confirmationResponseStarted = false
          }
          return publicActivationResult(result)
        }

        runtimeRef = result.runtime
        this.states.set(agent, { kind: 'runtime', runtime: result.runtime })
        state.dispose()
        return publicActivationResult(result)
      },
    }
  }

  private async disposePreflight(agent: Agent, state: PreflightState): Promise<void> {
    if (this.states.get(agent) !== state) return
    this.states.delete(agent)
    state.dispose()
  }
}
