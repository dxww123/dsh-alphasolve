import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Context } from 'cordis'
import {
  installAgentLlmTarget,
  type Agent,
  type AgentHandle,
  type AgentLlmTarget,
  type AgentOptions,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import {
  installRolePermissionBoundary,
  isForbiddenRoleTool,
  type RoleKind,
  type RolePermissionPolicy,
} from './permissions.js'

export type RoleRunStopReason =
  | 'completed'
  | 'max_turns'
  | 'max_tokens'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'disposed'
  | 'interrupted'

export interface RoleRunResult {
  readonly agentId: ReturnType<typeof SessionId>
  readonly role: RoleKind
  /** Last complete assistant message; empty when the role never produced one. */
  readonly output: readonly ContentBlock[]
  /** Text blocks from output joined for AlphaSolve's verdict parsers. */
  readonly text: string
  readonly stopReason: RoleRunStopReason
  readonly steps: number
  readonly turnEndReason?: TurnEndReason
}

/** Report observable work in a nested helper to its owning role watchdog. */
export type RoleActivityReporter = () => void

export type RoleRunFailurePhase = 'create' | 'run' | 'inactivity' | 'dispose'

/** Best-effort snapshot emitted before a runner rejects. The original error is rethrown unchanged. */
export interface RoleRunFailure {
  readonly agentId: string
  readonly role: RoleKind
  readonly phase: RoleRunFailurePhase
  readonly output: readonly ContentBlock[]
  readonly text: string
  readonly steps: number
  readonly error: unknown
  readonly cleanupError?: unknown
  readonly turnEndReason?: TurnEndReason
}

/** Register role-local helper tools or result-capture listeners before publication. */
export type RoleHelperSetup = (
  childCtx: Context,
  child: Agent,
  reportActivity: RoleActivityReporter,
) => void | Promise<void>

export interface RunRoleAgentOptions {
  readonly parent: Agent
  readonly role: RoleKind
  /** Absolute workspace/cwd for the fresh child session. */
  readonly cwd: string
  readonly persona: string
  readonly prompt: string | readonly ContentBlock[]
  /** AlphaSolve turns map to DSH model-request steps. */
  readonly maxTurns: number
  readonly signal: AbortSignal
  readonly permissionPolicy: RolePermissionPolicy
  /** Complete resolved route; omit only when reasoning-effort inheritance is irrelevant. */
  readonly modelTarget?: AgentLlmTarget
  readonly maxTokens?: number
  /** Global tools retained by tools.restrict; scoped helpers are registered separately. */
  readonly allowedGlobalTools?: readonly string[]
  readonly setupHelpers?: RoleHelperSetup
  /** Propagate nested-role activity to an owning role's inactivity watchdog. */
  readonly onActivity?: RoleActivityReporter
  /** Internal diagnostic handoff used to persist partial traces on rejection. */
  readonly onFailure?: (failure: RoleRunFailure) => void
  /** Technical bounds only; they do not impose a total worker wall-clock limit. */
  readonly createTimeoutMs?: number
  readonly inactivityTimeoutMs?: number
  /** @deprecated Use inactivityTimeoutMs. Retained for local API compatibility. */
  readonly idleTimeoutMs?: number
  readonly disposeTimeoutMs?: number
}

export const ROLE_CREATE_TIMEOUT_MS = 60_000
/** Abort only after one hour without any observable role or nested-helper activity. */
export const ROLE_INACTIVITY_TIMEOUT_MS = 60 * 60_000
/** @deprecated Use ROLE_INACTIVITY_TIMEOUT_MS. */
export const ROLE_IDLE_TIMEOUT_MS = ROLE_INACTIVITY_TIMEOUT_MS
export const ROLE_DISPOSE_TIMEOUT_MS = 15_000

export class RoleTechnicalTimeoutError extends Error {
  constructor(readonly phase: 'create' | 'inactivity' | 'dispose', milliseconds: number) {
    super(phase === 'inactivity'
      ? `AlphaSolve role Agent had no observable activity for ${milliseconds}ms`
      : `AlphaSolve role Agent ${phase} timed out after ${milliseconds}ms`)
    this.name = 'RoleTechnicalTimeoutError'
  }
}

const STANDARD_ROLE_GLOBAL_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit', 'glob', 'grep'])

function technicalTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return result
}

async function withTechnicalTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  phase: RoleTechnicalTimeoutError['phase'],
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new RoleTechnicalTimeoutError(phase, milliseconds))
    }, milliseconds)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

interface InactivityWatchdog {
  readonly expired: Promise<never>
  readonly refresh: RoleActivityReporter
  readonly stop: () => void
}

function inactivityWatchdog(
  milliseconds: number,
  onTimeout: () => void,
): InactivityWatchdog {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let rejectExpired: ((error: RoleTechnicalTimeoutError) => void) | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject
  })
  const refresh = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      stopped = true
      rejectExpired?.(new RoleTechnicalTimeoutError('inactivity', milliseconds))
      onTimeout()
    }, milliseconds)
    timer.unref?.()
  }
  const stop = (): void => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  refresh()
  return { expired, refresh, stop }
}

function assertRunOptions(options: RunRoleAgentOptions): void {
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new TypeError('maxTurns must be a positive safe integer')
  }
  if (!path.isAbsolute(options.cwd)) throw new TypeError('role Agent cwd must be absolute')
  if (path.resolve(options.cwd) !== path.resolve(options.permissionPolicy.cwd)) {
    throw new TypeError('role Agent cwd and permission policy cwd must identify the same lexical path')
  }
  if (options.role !== options.permissionPolicy.role) {
    throw new TypeError(`role Agent "${options.role}" cannot use a "${options.permissionPolicy.role}" permission policy`)
  }
  if (options.persona.trim().length === 0) throw new TypeError('role Agent persona must not be empty')
  if (typeof options.prompt === 'string' && options.prompt.trim().length === 0) {
    throw new TypeError('role Agent prompt must not be empty')
  }
  for (const name of options.allowedGlobalTools ?? []) {
    if (!STANDARD_ROLE_GLOBAL_TOOLS.has(name)) {
      throw new TypeError(`global tool "${name}" is not a standard AlphaSolve role filesystem tool`)
    }
    if (!options.permissionPolicy.allowedTools.has(name)) {
      throw new TypeError(`global tool "${name}" is not admitted by the ${options.role} permission policy`)
    }
    if (isForbiddenRoleTool(name)) throw new TypeError(`global tool "${name}" is forbidden for role Agents`)
  }
}

function childAgentOptions(options: RunRoleAgentOptions): AgentOptions {
  const inherited = options.parent.options
  const provider = options.modelTarget?.provider ?? inherited.provider
  const model = options.modelTarget?.model ?? inherited.model
  const maxTokens = options.maxTokens ?? inherited.maxTokens
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

function promptBlocks(prompt: RunRoleAgentOptions['prompt']): ContentBlock[] {
  return typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : [...prompt]
}

function mapStopReason(
  reason: TurnEndReason | undefined,
  hitMaxTurns: boolean,
  externallyAborted: boolean,
): RoleRunStopReason {
  if (hitMaxTurns) return 'max_turns'
  if (externallyAborted && reason?.kind !== 'completed') return 'aborted'
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
      return reason.reason.kind === 'disposed' ? 'disposed' : 'aborted'
    case 'blocked':
      return 'blocked'
    case 'interrupted':
      return 'interrupted'
    case 'error':
    default:
      return 'error'
  }
}

function readRoleResult(
  child: Agent,
  role: RoleKind,
  steps: number,
  hitMaxTurns: boolean,
  externallyAborted: boolean,
): RoleRunResult {
  const events = child.session.events
  // whenIdle() follows an automatic retry chain through its terminal turn.
  // The last turn/end is therefore authoritative; restricting the assistant
  // message to that same turn avoids reusing output from an earlier failed
  // retry attempt.
  const turnEnd = events.findLast(
    (event): event is SessionEvent<'turn/end'> => event.type === 'turn/end',
  )
  const lastMessage = turnEnd === undefined
    ? undefined
    : events.findLast(
        (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message'
          && event.data.turn === turnEnd.data.turn,
      )
  const output = [...(lastMessage?.data.message.content ?? [])]
  return {
    agentId: child.id,
    role,
    output,
    text: output
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n'),
    stopReason: mapStopReason(turnEnd?.data.reason, hitMaxTurns, externallyAborted),
    steps,
    ...(turnEnd === undefined ? {} : { turnEndReason: turnEnd.data.reason }),
  }
}

function failurePhase(error: unknown): RoleRunFailurePhase {
  return error instanceof RoleTechnicalTimeoutError ? error.phase : 'run'
}

function reportFailure(
  options: RunRoleAgentOptions,
  agentId: ReturnType<typeof SessionId>,
  phase: RoleRunFailurePhase,
  error: unknown,
  child: Agent | undefined,
  steps: number,
  cleanupError?: unknown,
): void {
  const partial = child === undefined
    ? undefined
    : readRoleResult(child, options.role, steps, false, options.signal.aborted)
  const unterminatedMessage = child !== undefined && partial?.turnEndReason === undefined
    ? child.session.events.findLast(
        (event): event is SessionEvent<'assistant/message'> => event.type === 'assistant/message',
      )
    : undefined
  const output = partial?.output.length === 0 && unterminatedMessage !== undefined
    ? [...unterminatedMessage.data.message.content]
    : (partial?.output ?? [])
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  try {
    options.onFailure?.({
      agentId: String(agentId),
      role: options.role,
      phase,
      output,
      text,
      steps,
      error,
      ...(cleanupError === undefined ? {} : { cleanupError }),
      ...(partial?.turnEndReason === undefined ? {} : { turnEndReason: partial.turnEndReason }),
    })
  } catch {
    // Diagnostics must never replace the operational error.
  }
}

function deriveGlobalAllowlist(childCtx: Context, policy: RolePermissionPolicy): string[] {
  return [...STANDARD_ROLE_GLOBAL_TOOLS]
    .filter(name => policy.allowedTools.has(name) && childCtx.tools.get(name) !== undefined)
}

/**
 * Run one fresh, single-turn DSH Agent with role-scoped prompt, route, tools,
 * path policy, cancellation, and an AlphaSolve max-step boundary.
 */
export async function runRoleAgent(options: RunRoleAgentOptions): Promise<RoleRunResult> {
  assertRunOptions(options)

  const createTimeoutMs = technicalTimeout(options.createTimeoutMs, ROLE_CREATE_TIMEOUT_MS, 'createTimeoutMs')
  if (options.inactivityTimeoutMs !== undefined && options.idleTimeoutMs !== undefined) {
    throw new TypeError('specify only inactivityTimeoutMs (idleTimeoutMs is its deprecated alias)')
  }
  const inactivityTimeoutMs = technicalTimeout(
    options.inactivityTimeoutMs ?? options.idleTimeoutMs,
    ROLE_INACTIVITY_TIMEOUT_MS,
    'inactivityTimeoutMs',
  )
  const disposeTimeoutMs = technicalTimeout(options.disposeTimeoutMs, ROLE_DISPOSE_TIMEOUT_MS, 'disposeTimeoutMs')

  const childId = SessionId(randomUUID())
  let hitMaxTurns = false
  let observedSteps = 0
  let handle: AgentHandle | undefined
  const lifetime = new AbortController()
  const creationSignal = AbortSignal.any([options.signal, lifetime.signal])
  let refreshInactivity: RoleActivityReporter = () => undefined
  const reportActivity = (): void => {
    refreshInactivity()
    options.onActivity?.()
  }

  const creation = options.parent.ctx.agents.create({
    sessionId: childId,
    meta: {
      cwd: path.resolve(options.cwd),
      parentSession: options.parent.id,
      origin: 'subagent',
      delegationDepth: (options.parent.session.header.delegationDepth ?? 0) + 1,
    },
    agentOptions: childAgentOptions(options),
    signal: creationSignal,
    setup: async (childCtx): Promise<void> => {
      const child = childCtx.agent
      if (child === undefined) throw new Error('Agent factory did not associate the unpublished child context')

      childCtx.systemPrompt.section({
        name: 'deployment:persona',
        order: 0,
        text: options.persona,
      })

      if (options.modelTarget !== undefined) {
        installAgentLlmTarget(childCtx, {
          current: options.modelTarget,
          assembled: undefined,
        })
      }

      installRolePermissionBoundary(childCtx, options.permissionPolicy)
      const allowedGlobals = options.allowedGlobalTools === undefined
        ? deriveGlobalAllowlist(childCtx, options.permissionPolicy)
        : [...options.allowedGlobalTools]
      childCtx.tools.restrict({ allow: allowedGlobals })

      // This agent-scoped session firehose covers message/chunk, durable step
      // boundaries, tool calls/results, retry records, and terminal turn
      // events. Step counts come from the durable boundary rather than a
      // removed live agent/step mirror.
      childCtx.on('session/event', (session, event) => {
        if (session !== child.session) return
        reportActivity()
        if (event.type === 'step/start') {
          observedSteps = Math.max(observedSteps, event.data.step)
        }
      })

      // The latest Agent API exposes the proposed step as a scoped payload.
      // Intercepting before admission keeps maxTurns a hard model-request cap:
      // the over-limit step never reaches the durable step/start boundary.
      childCtx.on('agent/pre-step', ({ agent, step }, next) => {
        reportActivity()
        if (step > options.maxTurns) {
          hitMaxTurns = true
          agent.cancel({ kind: 'parent' })
          return Promise.resolve({ kind: 'reject' })
        }
        return next()
      })

      await options.setupHelpers?.(childCtx, child, reportActivity)
    },
  })
  try {
    handle = await withTechnicalTimeout(creation, createTimeoutMs, 'create', () => {
      lifetime.abort(new RoleTechnicalTimeoutError('create', createTimeoutMs))
    })
  } catch (error) {
    // A broken factory may ignore cancellation and resolve late. Dispose that
    // late handle without keeping this worker or process alive.
    void creation.then(late => late.dispose()).catch(() => undefined)
    reportFailure(options, childId, 'create', error, undefined, observedSteps)
    throw error
  }

  const child = handle.agent
  let externallyAborted = options.signal.aborted
  const onAbort = (): void => {
    externallyAborted = true
    child.cancel({ kind: 'parent' })
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  // create() deliberately detaches its creation-only signal before returning.
  if (options.signal.aborted) onAbort()

  let result: RoleRunResult | undefined
  let primaryError: unknown
  let primaryPhase: RoleRunFailurePhase | undefined
  let cleanupError: unknown
  try {
    const watchdog = inactivityWatchdog(inactivityTimeoutMs, () => {
      lifetime.abort(new RoleTechnicalTimeoutError('inactivity', inactivityTimeoutMs))
      child.cancel({ kind: 'parent' })
    })
    refreshInactivity = watchdog.refresh
    if (!externallyAborted) {
      reportActivity()
      child.followup(createUserMessage({
        content: promptBlocks(options.prompt),
        source: { kind: 'user' },
      }))
    }
    try {
      await Promise.race([child.whenIdle(), watchdog.expired])
    } finally {
      watchdog.stop()
      refreshInactivity = () => undefined
    }
    result = readRoleResult(
      child,
      options.role,
      hitMaxTurns ? options.maxTurns : observedSteps,
      hitMaxTurns,
      externallyAborted,
    )
  } catch (error) {
    primaryError = error
    primaryPhase = failurePhase(error)
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    lifetime.abort(new Error('AlphaSolve role invocation finished'))
    try {
      const disposal = handle.dispose()
      try {
        await withTechnicalTimeout(disposal, disposeTimeoutMs, 'dispose', () => {
          child.cancel({ kind: 'parent' })
        })
      } catch (error) {
        void disposal.catch(() => undefined)
        cleanupError = error
      }
    } catch (error) {
      cleanupError = error
    }
  }

  if (primaryError !== undefined) {
    reportFailure(
      options,
      child.id,
      primaryPhase ?? failurePhase(primaryError),
      primaryError,
      child,
      hitMaxTurns ? options.maxTurns : observedSteps,
      cleanupError,
    )
    throw primaryError
  }
  if (cleanupError !== undefined) {
    reportFailure(
      options,
      child.id,
      'dispose',
      cleanupError,
      child,
      hitMaxTurns ? options.maxTurns : observedSteps,
    )
    throw cleanupError
  }
  if (result === undefined) throw new Error('AlphaSolve role runner ended without a result')
  return result
}
