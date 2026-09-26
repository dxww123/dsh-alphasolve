/** Session-owned AlphaSolve runtime: durable state, workers, tools, and teardown. */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { Context, Fiber } from '@deepseek-ai/cordis'

import { atomicWriteJson, readJsonObject } from './atomic.js'
import { alphaSolveSessionState, hasDurableAlphaSolveResumeIntent } from './session-state.js'
import { loadAlphaSolveConfig } from './config.js'
import { DurableCurator, hasRecoverableCuratorTasks } from './curator.js'
import { acquireWorkspaceLock, type WorkspaceLock } from './lock.js'
import {
  createRolePolicy,
  installRolePermissionBoundary,
  ORCHESTRATOR_INDEX_PATH_PATTERN,
} from './permissions.js'
import {
  createProjectTools,
  PROJECT_TOOL_NAMES,
  type AlphaSolveProjectTools,
  VERIFIED_DIRECTORY_PATH_PATTERN,
  VERIFIED_MARKDOWN_PATH_PATTERN,
  VERIFIED_RENAME_NAME_PATTERN,
  VERIFIED_SUBDIRECTORY_PATH_PATTERN,
} from './project-tools.js'
import { ORCHESTRATOR_PROMPT } from './prompts.js'
import type { PythonOptions } from './python-runtime.js'
import {
  AlphaSolveRoleService,
  type RoleTraceEvent,
} from './role-service.js'
import { RuntimeStore, parseSessionState } from './store.js'
import {
  STATE_VERSION,
  type ActivateResult,
  type AlphaSolveConfig,
  type SessionState,
  type WorkspaceSnapshot,
} from './types.js'
import { WorkerManager } from './worker-manager.js'
import { createFixedWorkerExecutor } from './workflow.js'
import { AlphaSolveWorkflowObserver } from './workflow-observation.js'
import {
  backupSolution,
  canonicalWorkspace,
  initializeWorkspace,
  readWorkspaceInput,
  resolveWorkspacePath,
  snapshotWorkspace,
} from './workspace.js'

export const RUNTIME_TOOL_NAMES = Object.freeze({
  worker: 'alphasolve_worker',
  wait: 'alphasolve_wait',
  configure: 'alphasolve_configure',
  researchReview: 'alphasolve_research_review',
  stop: 'alphasolve_stop',
} as const)

export const ALPHASOLVE_REQUIRED_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep'] as const
const WEB_TOOLS = ['web', 'web_search', 'web_fetch'] as const

export const AGENT_PRESET_MISSING_TOOLS_REASON = 'agent_preset_missing_required_tools' as const
export const AGENT_PRESET_BLOCKS_PROMPT_REASON = 'agent_preset_blocks_alphasolve_prompt' as const

export interface AlphaSolveAgentCapabilities {
  readonly agentPreset?: string
  readonly missingTools: readonly string[]
}

/** Inspect the complete inherited catalog for this exact live Agent scope. */
export function inspectAlphaSolveAgentCapabilities(agent: Agent): AlphaSolveAgentCapabilities {
  const agentPreset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx)
  const missingTools = ALPHASOLVE_REQUIRED_FILE_TOOLS
    .filter(name => agent.ctx.tools.get(name, agent) === undefined)
  return Object.freeze({
    ...(agentPreset === undefined ? {} : { agentPreset }),
    missingTools: Object.freeze(missingTools),
  })
}

/** Curator-helper output is already part of its parent task and must not self-enqueue. */
export function shouldEnqueueCuratorTrace(
  event: Pick<RoleTraceEvent, 'parentRole'>,
): boolean {
  return event.parentRole !== 'curator'
}

export interface AlphaSolveRuntimeDefaults {
  readonly defaultCapacity?: number
  readonly defaultDetailedTrace?: boolean
  /** Deployment-owned Python execution settings. */
  readonly python?: PythonOptions
}

export interface RuntimeActivationRequest {
  readonly capacity?: number
  readonly overwriteSolution?: boolean
}

export type RuntimeActivationResult =
  | (ActivateResult & { readonly activated: false })
  | (ActivateResult & {
      readonly activated: true
      readonly runtime: AlphaSolveRuntime
    })

/** Cold-resume outcome. An absent reason means this session has no live AlphaSolve intent. */
export type RuntimeRestoreResult =
  | {
      readonly restored: false
      readonly workspace: string
      readonly reason?: string
      readonly agentPreset?: string
      readonly missingTools?: readonly string[]
    }
  | {
      readonly restored: true
      readonly workspace: string
      readonly capacity: number
      readonly runtime: AlphaSolveRuntime
    }

type ActivationMode = 'explicit' | 'session-resume'

type ShutdownKind = 'cancelled' | 'interrupted' | 'solved'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    || ((error as Error | undefined)?.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function argumentRecord(args: unknown, tool: string): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError(`${tool} arguments must be an object`)
  }
  return args as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${tool} received unexpected argument ${unexpected[0]}`)
}

function requiredString(record: Record<string, unknown>, field: string, tool: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new TypeError(`${tool}.${field} must be a string`)
  return value
}

function optionalString(record: Record<string, unknown>, field: string, tool: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${tool}.${field} must be a string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

function throwIfActivationCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new DOMException('AlphaSolve activation cancelled', 'AbortError')
}

function jsonTool(options: {
  readonly name: string
  readonly description: string
  readonly parameters: ToolDefinition['parameters']
  readonly outputSchema?: JsonSchemaNode
  readonly execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
  readonly concurrencySafe?: boolean
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema ?? { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    ...(options.concurrencySafe === true ? { isConcurrencySafe: () => true } : {}),
    execute: options.execute,
  }
}

/** Shadow a standard DSH write/edit tool with AlphaSolve main's index-only schema. */
function narrowedIndexTool(definition: ToolDefinition): ToolDefinition {
  const parameters = structuredClone(definition.parameters)
  const parameterRecord = argumentRecord(parameters, `${definition.name} schema`)
  const properties = argumentRecord(parameterRecord.properties, `${definition.name} schema.properties`)
  const filePath = argumentRecord(properties.file_path, `${definition.name} schema.properties.file_path`)
  filePath.pattern = ORCHESTRATOR_INDEX_PATH_PATTERN
  return {
    ...definition,
    description: `${definition.description}\n\nDuring AlphaSolve this tool is restricted to verified_propositions/**/index.md; it cannot create or edit a proposition proof.`,
    parameters,
  }
}

function successfulToolResult(event: SessionEvent<'tool/result'>): boolean {
  return event.data.message.isError !== true
}

type RestoreProbe =
  | { readonly candidate: false; readonly workspace: string; readonly reason?: string }
  | { readonly candidate: true; readonly workspace: string }

/** Read-only, fail-closed eligibility check before taking a workspace lock. */
async function probeRuntimeRestore(agent: Agent): Promise<RestoreProbe> {
  const workspace = agent.session.header.cwd ?? ''
  if (!hasDurableAlphaSolveResumeIntent(alphaSolveSessionState(agent))) {
    return { candidate: false, workspace }
  }
  let canonical: string
  try {
    canonical = await canonicalWorkspace(agent.session.header.cwd)
  } catch (error) {
    return { candidate: false, workspace, reason: errorMessage(error) }
  }

  const statePath = await resolveWorkspacePath(canonical, '.alphasolve/state.json', { mustExist: false })
  let state: SessionState
  try {
    state = parseSessionState(await readJsonObject(statePath), statePath)
  } catch (error) {
    if (isMissing(error)) {
      return {
        candidate: false,
        workspace: canonical,
        reason: 'persisted AlphaSolve activation exists but .alphasolve/state.json is missing',
      }
    }
    return { candidate: false, workspace: canonical, reason: errorMessage(error) }
  }

  // A different durable session never inherits activation merely because the
  // user selected the same directory. It remains dormant and may use the
  // ordinary explicit preflight, which will report workspace ownership.
  if (state.sessionId !== String(agent.id)) return { candidate: false, workspace: canonical }
  if (state.workspace !== canonical) {
    return {
      candidate: false,
      workspace: canonical,
      reason: 'persisted AlphaSolve workspace does not match this session workspace',
    }
  }

  let snapshot: WorkspaceSnapshot
  try {
    snapshot = await snapshotWorkspace(canonical)
  } catch (error) {
    return { candidate: false, workspace: canonical, reason: errorMessage(error) }
  }
  if (snapshot.problem.digest !== state.problemDigest) {
    return {
      candidate: false,
      workspace: canonical,
      reason: 'problem.md changed since AlphaSolve was active; request AlphaSolve explicitly to begin a new generation',
    }
  }

  if (state.status === 'solved') {
    try {
      const completions = await new RuntimeStore(canonical).listCompletions()
      const undeliveredSolved = completions.some(completion => (
        completion.solved
        && completion.problemDigest === state.problemDigest
        && completion.deliveredByCallId === undefined
      ))
      const curatorNeedsRecovery = await hasRecoverableCuratorTasks(canonical)
      if (!undeliveredSolved && !curatorNeedsRecovery) {
        return { candidate: false, workspace: canonical }
      }
    } catch (error) {
      return { candidate: false, workspace: canonical, reason: errorMessage(error) }
    }
  }
  return { candidate: true, workspace: canonical }
}

function committedToolCallIds(agent: Agent): Set<string> {
  return new Set(alphaSolveSessionState(agent).successfulWaitCallIds)
}

async function optionalLstat(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** Atomic publication means a present, ordinary non-empty AlphaSolve header is complete. */
async function hasCompleteSolution(snapshot: WorkspaceSnapshot): Promise<boolean> {
  if (!snapshot.solutionExists) return false
  const solution = await readWorkspaceInput(snapshot.root, 'solution.md', { nonEmpty: true })
  return /^# Solution(?:\r?\n|$)/.test(solution.content)
}

/**
 * Preserve a completed or different-problem state before beginning a new
 * explicit AlphaSolve request. Research files remain in place; only runtime
 * metadata whose delivery/winner semantics cannot cross generations moves.
 */
export type ArchiveGenerationPhase = 'completions' | 'workers' | 'curator' | 'metadata' | 'committed'

export interface ArchiveGenerationOptions {
  /** Failure-injection/observability seam; production leaves it unset. */
  readonly afterPhase?: (phase: ArchiveGenerationPhase, backup: string) => Promise<void> | void
}

export async function archivePreviousGeneration(
  workspace: string,
  problemDigest: string,
  options: ArchiveGenerationOptions = {},
): Promise<boolean> {
  const statePath = await resolveWorkspacePath(workspace, '.alphasolve/state.json', { mustExist: false })
  const stateInfo = await optionalLstat(statePath)
  if (stateInfo === undefined) return false
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) {
    throw new Error(`AlphaSolve state is not an ordinary file: ${statePath}`)
  }
  const prior = parseSessionState(await readJsonObject(statePath), statePath)
  if (prior.problemDigest === problemDigest && prior.status !== 'solved') return false

  // Validate every durable document before the first rename. Archival is not
  // a corruption-recovery mechanism: bad state remains in place for diagnosis.
  const validationStore = new RuntimeStore(workspace)
  await validationStore.listCompletions()
  await validationStore.validateWorkers()
  await hasRecoverableCuratorTasks(workspace)

  const suffix = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
  const backupRelative = `.alphasolve/backups/generation-${suffix}`
  const backup = await resolveWorkspacePath(workspace, backupRelative, { mustExist: false })
  await mkdir(backup, { mode: 0o700 })

  const completions = await resolveWorkspacePath(workspace, '.alphasolve/completions', { mustExist: true })
  await rename(completions, path.join(backup, 'completions'))
  await mkdir(completions, { mode: 0o700 })
  await options.afterPhase?.('completions', backup)
  const workers = await resolveWorkspacePath(workspace, '.alphasolve/workers', { mustExist: true })
  await rename(workers, path.join(backup, 'workers'))
  await mkdir(workers, { mode: 0o700 })
  await options.afterPhase?.('workers', backup)

  const queue = await resolveWorkspacePath(workspace, '.alphasolve/curator/queue.json', { mustExist: false })
  if (await optionalLstat(queue) !== undefined) await rename(queue, path.join(backup, 'curator-queue.json'))
  await options.afterPhase?.('curator', backup)
  await atomicWriteJson(path.join(backup, 'generation.json'), {
    archivedAt: new Date().toISOString(),
    previousProblemDigest: prior.problemDigest,
    nextProblemDigest: problemDigest,
    previousStatus: prior.status,
  })
  await options.afterPhase?.('metadata', backup)

  // state.json is the archive commit marker. Until this final rename succeeds,
  // recovery still sees the prior generation and can never treat old ledgers as
  // belonging to a freshly initialized state.
  await rename(statePath, path.join(backup, 'state.json'))
  await options.afterPhase?.('committed', backup)
  return true
}

function initialState(
  agent: Agent,
  snapshot: WorkspaceSnapshot,
  config: AlphaSolveConfig,
): SessionState {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    sessionId: String(agent.id),
    workspace: snapshot.root,
    activatedAt: now,
    updatedAt: now,
    status: 'active',
    problemDigest: snapshot.problem.digest,
    ...(snapshot.hint === undefined ? {} : { hintDigest: snapshot.hint.digest }),
    capacity: config.capacity,
    detailedTrace: config.detailedTrace,
    modelOverrides: config.models,
    nextCompletionSequence: 1,
  }
}

/** One locked, session-isolated AlphaSolve runtime. */
export class AlphaSolveRuntime {
  readonly workspace: string
  readonly store: RuntimeStore
  readonly manager: WorkerManager

  private fiber: Fiber | undefined
  private readonly waitCalls = new Set<string>()
  private readonly solvedWaitCalls = new Set<string>()
  private solvedResultCommitted = false
  private stopCallId: string | undefined
  private stopResultCommitted = false
  private turnSettled = false
  private readonly pendingSessionCommits = new Set<Promise<void>>()
  private readonly pendingSessionCommitErrors: unknown[] = []
  private readonly completionsSinceResearchReview = new Set<string>()
  private shutdownPromise: Promise<void> | undefined
  private disposed = false

  private constructor(
    private readonly agent: Agent,
    private readonly lock: WorkspaceLock,
    store: RuntimeStore,
    private config: AlphaSolveConfig,
    private readonly curator: DurableCurator,
    private readonly roleService: AlphaSolveRoleService,
    manager: WorkerManager,
    private readonly projectTools: AlphaSolveProjectTools,
    private readonly replaceExistingSolution: boolean,
    private readonly terminalRecovery: boolean,
    private readonly onDisposed: () => void,
  ) {
    this.workspace = store.workspace
    this.store = store
    this.manager = manager
  }

  private static async prepare(
    agent: Agent,
    request: RuntimeActivationRequest,
    defaults: AlphaSolveRuntimeDefaults,
    onDisposed: () => void,
    signal?: AbortSignal,
    mode: ActivationMode = 'explicit',
  ): Promise<{ readonly runtime: AlphaSolveRuntime; readonly resumed: boolean }> {
    throwIfActivationCancelled(signal)
    if (request.capacity !== undefined) positiveInteger(request.capacity, 'capacity')
    const snapshot = await snapshotWorkspace(agent.session.header.cwd)
    throwIfActivationCancelled(signal)
    const loaded = mode === 'explicit'
      ? await loadAlphaSolveConfig(snapshot.root, {
          ...(request.capacity === undefined ? {} : { promptCapacity: request.capacity }),
          ...(defaults.defaultCapacity === undefined ? {} : { defaultCapacity: defaults.defaultCapacity }),
          ...(defaults.defaultDetailedTrace === undefined ? {} : {
            defaultDetailedTrace: defaults.defaultDetailedTrace,
          }),
        })
      : undefined
    throwIfActivationCancelled(signal)

    await initializeWorkspace(snapshot.root)
    throwIfActivationCancelled(signal)
    const lock = await acquireWorkspaceLock(snapshot.root, String(agent.id))
    let curator: DurableCurator | undefined
    try {
      throwIfActivationCancelled(signal)
      const latest = await snapshotWorkspace(snapshot.root)
      throwIfActivationCancelled(signal)
      if (latest.problem.digest !== snapshot.problem.digest) {
        throw new Error('problem.md changed while AlphaSolve activation was being prepared; retry explicitly')
      }
      let recoveredConfig: AlphaSolveConfig | undefined
      if (mode === 'session-resume') {
        const statePath = await resolveWorkspacePath(snapshot.root, '.alphasolve/state.json', { mustExist: true })
        const persisted = parseSessionState(await readJsonObject(statePath), statePath)
        if (persisted.sessionId !== String(agent.id)) {
          throw new Error('persisted AlphaSolve state belongs to a different session')
        }
        if (persisted.workspace !== latest.root) {
          throw new Error('persisted AlphaSolve workspace changed during session recovery')
        }
        if (persisted.problemDigest !== latest.problem.digest) {
          throw new Error('problem.md changed during AlphaSolve session recovery')
        }
        recoveredConfig = {
          capacity: persisted.capacity,
          detailedTrace: persisted.detailedTrace,
          models: persisted.modelOverrides,
        }
      }
      const activationConfig = recoveredConfig ?? loaded?.resolved
      if (activationConfig === undefined) throw new Error('AlphaSolve activation configuration is unavailable')
      let store = new RuntimeStore(snapshot.root)
      let opened = await store.open(initialState(agent, latest, activationConfig))
      if (mode === 'session-resume') {
        if (!opened.resumed) throw new Error('persisted AlphaSolve state disappeared during session recovery')
      }
      // Validate first, then recover crash-left terminal worker snapshots. The
      // archive path below is allowed only after all ledgers and the curator
      // queue have passed their strict parsers.
      await store.validateWorkers()
      await store.recoverInterruptedWorkers()
      await store.recoverReservations(committedToolCallIds(agent))
      const completeSolution = await hasCompleteSolution(latest)
      const terminalCompletion = await store.reconcileSolvedTerminal(completeSolution)
      const curatorNeedsRecovery = await hasRecoverableCuratorTasks(snapshot.root)
      const sameProblem = store.currentState().problemDigest === latest.problem.digest
      const terminalRecovery = sameProblem
        && terminalCompletion !== undefined
        && (terminalCompletion.deliveredByCallId === undefined || curatorNeedsRecovery)
      let preservePersistedConfig = opened.resumed
        && store.currentState().sessionId === String(agent.id)
        && store.currentState().workspace === latest.root
        && sameProblem

      let resumed = opened.resumed
      if (mode === 'session-resume') {
        if (store.currentState().status === 'solved' && !terminalRecovery) {
          throw new Error('completed AlphaSolve session has no undelivered recovery work')
        }
        if (latest.solutionExists && !terminalRecovery) {
          throw new Error('solution.md appeared while AlphaSolve was interrupted; request AlphaSolve explicitly to resolve it')
        }
      } else if (!terminalRecovery) {
        if (latest.solutionExists && request.overwriteSolution !== true) {
          throw new ExistingSolutionConfirmationError(snapshot.root)
        }
        if (latest.solutionExists) await backupSolution(snapshot.root)
        const archived = await archivePreviousGeneration(snapshot.root, latest.problem.digest)
        if (archived) {
          store = new RuntimeStore(snapshot.root)
          opened = await store.open(initialState(agent, latest, activationConfig))
          resumed = false
          preservePersistedConfig = false
        }
      }
      throwIfActivationCancelled(signal)
      if (store.currentState().problemDigest !== latest.problem.digest) {
        throw new Error('persisted AlphaSolve state belongs to a different problem generation')
      }
      const persistedConfig = store.currentState()
      const runtimeConfig: AlphaSolveConfig = preservePersistedConfig
        ? {
            capacity: request.capacity ?? persistedConfig.capacity,
            detailedTrace: persistedConfig.detailedTrace,
            models: persistedConfig.modelOverrides,
          }
        : activationConfig
      await store.updateState(state => {
        const next: SessionState = {
          ...state,
          sessionId: String(agent.id),
          workspace: latest.root,
          status: terminalRecovery ? 'solved' : 'active',
          capacity: runtimeConfig.capacity,
          detailedTrace: runtimeConfig.detailedTrace,
          modelOverrides: runtimeConfig.models,
          ...(latest.hint === undefined ? {} : { hintDigest: latest.hint.digest }),
        }
        if (latest.hint !== undefined) return next
        const { hintDigest: _hint, ...withoutHint } = next
        return withoutHint
      })
      throwIfActivationCancelled(signal)

      const observer = await AlphaSolveWorkflowObserver.open(snapshot.root, String(agent.id), error => {
        agent.ctx.logger.warn(`AlphaSolve workflow overview write failed: ${errorMessage(error)}`)
      })
      for (const worker of await store.validateWorkers()) await observer.worker(worker)
      const roleService = new AlphaSolveRoleService({
        observer,
        ...(defaults.python === undefined ? {} : { python: defaults.python }),
        parent: agent,
        workspace: snapshot.root,
        getConfig: () => ({
          capacity: store.currentState().capacity,
          detailedTrace: store.currentState().detailedTrace,
          models: store.currentState().modelOverrides,
        }),
        onTrace: async (event): Promise<string | undefined> => {
          if (!store.currentState().detailedTrace) return undefined
          if (curator === undefined) throw new Error('curator is not ready for AlphaSolve traces')
          const traceId = `${event.kind}-${event.agentId}-${randomUUID().slice(0, 8)}`
          const traceRelative = `.alphasolve/traces/${traceId}.json`
          const tracePath = await resolveWorkspacePath(snapshot.root, traceRelative, { mustExist: false })
          await atomicWriteJson(tracePath, event)
          if (event.workerId !== undefined) {
            await store.appendWorkerTracePath(event.workerId, traceRelative)
          }
          // A curator helper is part of the task already being digested. Its
          // trace remains durable, but enqueueing it would let curator tasks
          // recursively manufacture more curator tasks without bound.
          if (shouldEnqueueCuratorTrace(event)) {
            await curator.submit({
              id: `trace-${traceId}`,
              kind: event.kind === 'workflow_role' && event.role === 'verifier_premise_chain'
                ? 'verifier_final'
                : 'digest',
              ...(event.workerId === undefined ? {} : { sourceWorkerId: event.workerId }),
              tracePath: traceRelative,
              metadata: {
                traceKind: event.kind,
                role: String(event.role),
              },
            })
          }
          return traceRelative
        },
      })
      curator = await DurableCurator.open({
        workspaceRoot: snapshot.root,
        runner: roleService.runCurator,
        onTaskFailure: (task, error) => {
          const conciseError = errorMessage(error).replaceAll(/\s+/g, ' ').slice(0, 500)
          agent.inject(createUserMessage({
            content: [{
              type: 'text',
              text: `AlphaSolve curator task failed and needs orchestrator attention: id=${task.id}, kind=${task.kind}, error=${conciseError}`,
            }],
            source: { kind: 'alphasolve', form: 'notice', summary: 'AlphaSolve curator task failed' },
          }))
        },
        drainTimeoutMs: 60_000,
      })
      throwIfActivationCancelled(signal)
      const projectTools = await createProjectTools(snapshot.root)
      const executor = createFixedWorkerExecutor({
        workspace: snapshot.root,
        invoker: roleService,
        filenameBuilder: roleService.buildPropositionFilename,
        replaceExistingSolution: request.overwriteSolution === true,
      })

      let runtime: AlphaSolveRuntime | undefined
      const manager = new WorkerManager(
        store,
        executor,
        message => {
          agent.inject(createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'alphasolve', form: 'notice', summary: 'AlphaSolve worker update' },
          }))
        },
        error => {
          agent.ctx.logger.warn(`AlphaSolve background error: ${errorMessage(error)}`)
        },
        () => lock.assertOwned(),
        async () => {
          await curator?.stop()
        },
        record => observer.worker(record),
      )
      runtime = new AlphaSolveRuntime(
        agent,
        lock,
        store,
        runtimeConfig,
        curator,
        roleService,
        manager,
        projectTools,
        request.overwriteSolution === true,
        terminalRecovery,
        onDisposed,
      )
      throwIfActivationCancelled(signal)
      return { runtime, resumed }
    } catch (error) {
      const cleanupErrors: unknown[] = []
      try {
        await curator?.stop()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      try {
        await lock.release()
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          'AlphaSolve runtime preparation failed and rollback was incomplete',
          { cause: error },
        )
      }
      throw error
    }
  }

  /** Prepare resources, then publish all tools/prompt in one agent child fiber. */
  static async activate(
    agent: Agent,
    request: RuntimeActivationRequest,
    defaults: AlphaSolveRuntimeDefaults,
    onDisposed: () => void,
    signal?: AbortSignal,
    mode: ActivationMode = 'explicit',
  ): Promise<{ readonly runtime: AlphaSolveRuntime; readonly resumed: boolean }> {
    const prepared = await AlphaSolveRuntime.prepare(agent, request, defaults, onDisposed, signal, mode)
    try {
      throwIfActivationCancelled(signal)
      const fiber = agent.ctx.plugin({
        name: 'dsh-alphasolve:session-runtime',
        inject: ['tools', 'systemPrompt'],
        apply: (ctx: Context) => prepared.runtime.install(ctx),
      })
      prepared.runtime.fiber = fiber
      await fiber
      throwIfActivationCancelled(signal)
      const assembly = await agent.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      throwIfActivationCancelled(signal)
      if (!assembly.sections.some(section => section.name === 'alphasolve:orchestrator')) {
        throw new AgentPresetPromptConflictError(
          inspectAlphaSolveAgentCapabilities(agent).agentPreset,
        )
      }
      return prepared
    } catch (error) {
      try {
        await prepared.runtime.dispose()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'AlphaSolve runtime publication failed and rollback was incomplete',
          { cause: error },
        )
      }
      throw error
    }
  }

  private visibleAllowedInheritedTools(ctx: Context): string[] {
    return [...ALPHASOLVE_REQUIRED_FILE_TOOLS, ...WEB_TOOLS]
      .filter(name => ctx.tools.get(name, this.agent) !== undefined)
  }

  private narrowedIndexTools(ctx: Context): ToolDefinition[] {
    return (['write', 'edit'] as const).flatMap(name => {
      const definition = ctx.tools.get(name, this.agent)
      return definition === undefined ? [] : [narrowedIndexTool(definition)]
    })
  }

  private install(ctx: Context): () => Promise<void> {
    ctx.tools.presentAs('native')
    const runtimeTools = this.createRuntimeTools().filter(tool => (
      !this.terminalRecovery
      || tool.name === RUNTIME_TOOL_NAMES.wait
      || tool.name === RUNTIME_TOOL_NAMES.stop
    ))
    const projectTools = this.terminalRecovery ? [] : this.createProjectToolDefinitions()
    const indexTools = this.terminalRecovery ? [] : this.narrowedIndexTools(ctx)
    for (const tool of [...runtimeTools, ...projectTools, ...indexTools]) ctx.tools.register(tool)

    const allowedInherited = this.terminalRecovery ? [] : this.visibleAllowedInheritedTools(ctx)
    const customNames = [...runtimeTools, ...projectTools].map(tool => tool.name)
    const policy = createRolePolicy('orchestrator', {
      workspace: this.workspace,
      extraAllowedTools: [...customNames, ...allowedInherited],
    })
    installRolePermissionBoundary(ctx, policy, this.agent)
    ctx.tools.restrict({ allow: allowedInherited })
    ctx.systemPrompt.section({
      name: 'alphasolve:orchestrator',
      order: 50,
      text: this.terminalRecovery
        ? 'AlphaSolve recovered a terminal solution. No new research or file mutation is allowed. Call alphasolve_wait with no arguments as the final action in this turn; it first lets the recovered curator queue drain, then returns any undelivered completion.'
        : `${ORCHESTRATOR_PROMPT}\n\nThe hard worker cap can be changed only with alphasolve_configure. Call alphasolve_wait with no arguments. When a solved completion is returned, that wait call must be your final action in the turn.`,
    })
    ctx.systemPrompt.context({
      name: 'alphasolve:runtime-state',
      order: 50,
      text: () => {
        const state = this.store.currentState()
        const activeWorkerIds = this.manager.activeIds()
        const activeWorkerProgress = this.manager.activeProgress()
        return [
          'AlphaSolve runtime state (authoritative for this model step):',
          `- status: ${state.status}`,
          `- capacity: ${state.capacity}`,
          `- active: ${activeWorkerIds.length}`,
          `- activeWorkerIds: ${JSON.stringify(activeWorkerIds)}`,
          `- activeWorkerProgress: ${JSON.stringify(activeWorkerProgress)}`,
          `- overCapacity: ${this.manager.overCapacity()}`,
          `- completedSinceResearchReview: ${this.completionsSinceResearchReview.size}`,
          `- researchReviewDue: ${this.completionsSinceResearchReview.size >= 4}`,
        ].join('\n')
      },
    })

    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'tool/result') return
      this.trackToolResultCommit(event)
    })
    ctx.on('session/flush', async () => {
      await this.flushToolResultCommits()
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (agent !== this.agent) return
      this.turnSettled = status === 'idle'
      if (this.turnSettled) this.maybeDisposeAfterTerminalResult()
    })

    return async () => {
      try {
        await this.flushToolResultCommits()
      } catch (error) {
        this.agent.ctx.logger.warn(`AlphaSolve completion-delivery flush failed during unload: ${errorMessage(error)}`)
      }
      await this.shutdown(this.store.currentState().status === 'solved' ? 'solved' : 'interrupted')
    }
  }

  private trackToolResultCommit(event: SessionEvent<'tool/result'>): void {
    const pending = this.onToolResultEvent(event)
    this.pendingSessionCommits.add(pending)
    void pending.then(
      () => this.pendingSessionCommits.delete(pending),
      (error: unknown) => {
        this.pendingSessionCommits.delete(pending)
        this.pendingSessionCommitErrors.push(error)
        this.agent.ctx.logger.warn(`AlphaSolve completion-delivery commit failed: ${errorMessage(error)}`)
      },
    )
  }

  private async flushToolResultCommits(): Promise<void> {
    while (this.pendingSessionCommits.size > 0) {
      await Promise.allSettled([...this.pendingSessionCommits])
    }
    const [firstError] = this.pendingSessionCommitErrors.splice(0)
    if (firstError !== undefined) throw firstError
  }

  private createRuntimeTools(): ToolDefinition[] {
    const worker = jsonTool({
      name: RUNTIME_TOOL_NAMES.worker,
      description: [
        'Start one asynchronous fixed AlphaSolve proposition worker and return immediately; it never queues or waits when capacity is full.',
        '',
        'The instruction must be one mathematical proposition target or bounded route toward a proposition. A worker may prove a final answer, bridge, auxiliary lemma, construction, obstruction, counterexample, admissible-choice classification, or exact assembly/interface result.',
        '',
        'This is not a general subagent. Never ask it to browse the Web, download literature, write knowledge/, edit verified_propositions/, write solution.md, diagnose the environment, test connectivity, choose its own output path, or bypass the fixed format/workflow.',
        '',
        'Lifecycle: generator writes one proposition.md; five independent verifier profiles must all pass; a completed mathematical failure invokes a fresh reviser and restarts all profiles for at most six rounds; five fresh theorem checks alone decide whether the verified Statement solves problem.md.',
        '',
        'The immediate result reports admission, active workers, capacity, and the worker ID. Use alphasolve_wait to collect lifecycle completions.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { instruction: { type: 'string', maxLength: 4_000 } },
        required: ['instruction'],
      },
      execute: async (args, exec) => {
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('worker start cancelled', 'AbortError')
        const record = argumentRecord(args, RUNTIME_TOOL_NAMES.worker)
        exactKeys(record, ['instruction'], RUNTIME_TOOL_NAMES.worker)
        return this.manager.start(requiredString(record, 'instruction', RUNTIME_TOOL_NAMES.worker))
      },
    })

    const wait = jsonTool({
      name: RUNTIME_TOOL_NAMES.wait,
      description: [
        'Pure wait: start no hidden worker and take no arguments. If no completion backlog exists, wait until at least one active worker completes; then return every completion not delivered by an earlier successful wait plus the current active/capacity snapshot.',
        '',
        'Interpret results by class: verified is established auxiliary progress; rejected is a completed mathematical verification failure; failed is infrastructure/protocol failure and is not evidence that the proposition is false; solved means solution.md was atomically written.',
        '',
        'The result also reports completedSinceResearchReview and researchReviewDue. Run a fresh research review after roughly three to five worker lifecycles. When a solved completion is returned, this wait call must be the final action of the turn.',
      ].join('\n'),
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: async (args, exec) => {
        const record = argumentRecord(args, RUNTIME_TOOL_NAMES.wait)
        exactKeys(record, [], RUNTIME_TOOL_NAMES.wait)
        const callId = String(exec.callId)
        this.waitCalls.add(callId)
        try {
          if (this.terminalRecovery) await this.curator.stop()
          const result = await this.manager.wait(callId, exec.signal)
          for (const completion of result.completed) {
            this.completionsSinceResearchReview.add(completion.workerId)
          }
          const enrichedResult = {
            ...result,
            completedSinceResearchReview: this.completionsSinceResearchReview.size,
            researchReviewDue: this.completionsSinceResearchReview.size >= 4,
          }
          if (result.completed.some(completion => completion.status === 'solved' && completion.solved)
            || (this.terminalRecovery && this.store.currentState().status === 'solved')) {
            this.solvedWaitCalls.add(callId)
            exec.concludeTurn()
          }
          return enrichedResult
        } catch (error) {
          await this.store.releaseReservation(callId)
          this.waitCalls.delete(callId)
          throw error
        }
      },
    })

    const configure = jsonTool({
      name: RUNTIME_TOOL_NAMES.configure,
      description: 'Change this session runtime\'s one hard worker-capacity limit. Lowering it never cancels active workers.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { capacity: { type: 'integer', minimum: 1 } }, required: ['capacity'],
      },
      execute: async (args, exec) => {
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('configuration cancelled', 'AbortError')
        const record = argumentRecord(args, RUNTIME_TOOL_NAMES.configure)
        exactKeys(record, ['capacity'], RUNTIME_TOOL_NAMES.configure)
        const capacity = positiveInteger(record.capacity, 'capacity')
        const result = await this.manager.configure(capacity)
        this.config = { ...this.config, capacity }
        return result
      },
    })

    const researchReview = jsonTool({
      name: RUNTIME_TOOL_NAMES.researchReview,
      description: [
        'Run one fresh, read-only AlphaSolve workspace research-progress reviewer over problem.md, actual verified proposition Statements, and exploratory knowledge.',
        '',
        'This is not a Web or literature-download tool and it never inspects live unverified workers. Use it every three to five worker lifecycles, after major verified growth, when routes conflict, or when the best next proposition is unclear. Its optional prompt should name routes or bottlenecks to compare, not ask it to prove or verify new mathematics.',
        '',
        'The reviewer first consumes a compact program-ranked research map, then selectively inspects exact files. It returns established progress, the precise global gap, promising knowledge claims, and one to three ranked next proposition targets.',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { prompt: { type: 'string', maxLength: 4_000 } },
      },
      execute: async (args, exec) => {
        const record = argumentRecord(args, RUNTIME_TOOL_NAMES.researchReview)
        exactKeys(record, ['prompt'], RUNTIME_TOOL_NAMES.researchReview)
        const prompt = optionalString(record, 'prompt', RUNTIME_TOOL_NAMES.researchReview)
        const review = await this.roleService.runResearchReview({
          signal: exec.signal,
          ...(prompt === undefined ? {} : { prompt }),
        })
        this.completionsSinceResearchReview.clear()
        return { review }
      },
    })

    const stop = jsonTool({
      name: RUNTIME_TOOL_NAMES.stop,
      description: 'Explicitly stop and unload AlphaSolve for this session, preserving all research and durable completion data.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: async (args, exec) => {
        const record = argumentRecord(args, RUNTIME_TOOL_NAMES.stop)
        exactKeys(record, [], RUNTIME_TOOL_NAMES.stop)
        this.stopCallId = String(exec.callId)
        await this.shutdown('cancelled', false)
        exec.concludeTurn()
        return { stopped: true, workspace: this.workspace }
      },
    })
    return [worker, wait, configure, researchReview, stop]
  }

  private createProjectToolDefinitions(): ToolDefinition[] {
    const mkdirTool = jsonTool({
      name: PROJECT_TOOL_NAMES.mkdir,
      description: 'Create one topic-directory chain below verified_propositions/.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', pattern: VERIFIED_SUBDIRECTORY_PATH_PATTERN } }, required: ['path'],
      },
      execute: async (args, exec) => {
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('mkdir cancelled', 'AbortError')
        const record = argumentRecord(args, PROJECT_TOOL_NAMES.mkdir)
        exactKeys(record, ['path'], PROJECT_TOOL_NAMES.mkdir)
        await this.lock.assertOwned()
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('mkdir cancelled', 'AbortError')
        return this.projectTools.mkdir(requiredString(record, 'path', PROJECT_TOOL_NAMES.mkdir))
      },
    })
    const renameTool = jsonTool({
      name: PROJECT_TOOL_NAMES.rename,
      description: 'Rename one verified proposition Markdown file or topic directory in place. index.md is protected and proposition references are updated atomically.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          directory: { type: 'string', pattern: VERIFIED_DIRECTORY_PATH_PATTERN },
          old_name: { type: 'string', pattern: VERIFIED_RENAME_NAME_PATTERN },
          new_name: { type: 'string', pattern: VERIFIED_RENAME_NAME_PATTERN },
        },
        required: ['directory', 'old_name', 'new_name'],
      },
      execute: async (args, exec) => {
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('rename cancelled', 'AbortError')
        const record = argumentRecord(args, PROJECT_TOOL_NAMES.rename)
        exactKeys(record, ['directory', 'old_name', 'new_name'], PROJECT_TOOL_NAMES.rename)
        await this.lock.assertOwned()
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('rename cancelled', 'AbortError')
        return this.projectTools.rename(
          requiredString(record, 'directory', PROJECT_TOOL_NAMES.rename),
          requiredString(record, 'old_name', PROJECT_TOOL_NAMES.rename),
          requiredString(record, 'new_name', PROJECT_TOOL_NAMES.rename),
        )
      },
    })
    const moveTool = jsonTool({
      name: PROJECT_TOOL_NAMES.move,
      description: 'Move one existing verified proposition Markdown file into an existing verified topic directory while preserving its file name. index.md is protected and proposition references are updated atomically.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', pattern: VERIFIED_MARKDOWN_PATH_PATTERN },
          destination_dir: { type: 'string', pattern: VERIFIED_DIRECTORY_PATH_PATTERN },
        },
        required: ['path', 'destination_dir'],
      },
      execute: async (args, exec) => {
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('move cancelled', 'AbortError')
        const record = argumentRecord(args, PROJECT_TOOL_NAMES.move)
        exactKeys(record, ['path', 'destination_dir'], PROJECT_TOOL_NAMES.move)
        await this.lock.assertOwned()
        if (exec.signal.aborted) throw exec.signal.reason ?? new DOMException('move cancelled', 'AbortError')
        return this.projectTools.moveInto(
          requiredString(record, 'path', PROJECT_TOOL_NAMES.move),
          requiredString(record, 'destination_dir', PROJECT_TOOL_NAMES.move),
        )
      },
    })
    return [mkdirTool, renameTool, moveTool]
  }

  private async onToolResultEvent(event: SessionEvent<'tool/result'>): Promise<void> {
    const callId = String(event.data.message.source.callId)
    if (this.waitCalls.has(callId)) {
      try {
        if (successfulToolResult(event)) await this.store.commitDelivery(callId)
        else await this.store.releaseReservation(callId)
        if (successfulToolResult(event) && this.solvedWaitCalls.has(callId)) {
          this.solvedResultCommitted = true
        }
      } finally {
        this.waitCalls.delete(callId)
      }
    }
    if (callId === this.stopCallId && successfulToolResult(event)) this.stopResultCommitted = true
    this.maybeDisposeAfterTerminalResult()
  }

  private maybeDisposeAfterTerminalResult(): void {
    if (!this.turnSettled || (!this.solvedResultCommitted && !this.stopResultCommitted)) return
    const fiber = this.fiber
    if (fiber !== undefined) {
      void fiber.dispose().catch((error: unknown) => {
        this.agent.ctx.logger.warn(`AlphaSolve runtime unload failed: ${errorMessage(error)}`)
      })
    }
  }

  /** Release workspace ownership and always detach this runtime from its controller. */
  private async releaseOwnership(): Promise<void> {
    try {
      await this.lock.release()
    } finally {
      // A failed unlink/assert must remain visible to the caller, but it must
      // not leave a controller pointing at a fiber whose scoped tools have
      // already been torn down.
      if (!this.disposed) {
        this.disposed = true
        this.onDisposed()
      }
    }
  }

  private async shutdown(kind: ShutdownKind, releaseLock = true): Promise<void> {
    if (this.shutdownPromise !== undefined) {
      try {
        await this.shutdownPromise
      } finally {
        // A stop tool deliberately leaves the lock held until its result is
        // durable. If that first shutdown failed, fiber disposal must still
        // get a chance to release ownership instead of being short-circuited
        // by the already-rejected promise.
        if (releaseLock) {
          await this.releaseOwnership()
        }
      }
      return
    }
    this.shutdownPromise = (async () => {
      if (this.store.currentState().status !== 'solved') {
        await this.store.updateState(state => ({ ...state, status: 'stopping' }))
      }
      await this.manager.stop(kind === 'cancelled' ? 'cancelled' : 'interrupted')
      await this.curator.stop()
      if (this.store.currentState().status !== 'solved') {
        await this.store.updateState(state => ({ ...state, status: 'interrupted' }))
      }
    })()
    try {
      await this.shutdownPromise
    } finally {
      if (releaseLock) await this.releaseOwnership()
    }
  }

  /** Dispose the published session fiber, or the prepared resources on startup failure. */
  async dispose(): Promise<void> {
    if (this.fiber !== undefined) await this.fiber.dispose()
    else await this.shutdown('interrupted')
  }
}

class ExistingSolutionConfirmationError extends Error {
  constructor(readonly workspace: string) {
    super('solution.md already exists; ask the user for explicit overwrite authorization before activating AlphaSolve')
    this.name = 'ExistingSolutionConfirmationError'
  }
}

class AgentPresetPromptConflictError extends Error {
  constructor(readonly agentPreset: string | undefined) {
    super(AGENT_PRESET_BLOCKS_PROMPT_REASON)
    this.name = 'AgentPresetPromptConflictError'
  }
}

/** Convert activation failures into a stable preflight tool result. */
export async function activateAlphaSolveRuntime(
  agent: Agent,
  request: RuntimeActivationRequest,
  defaults: AlphaSolveRuntimeDefaults,
  onDisposed: () => void,
  signal?: AbortSignal,
): Promise<RuntimeActivationResult> {
  const workspace = agent.session.header.cwd ?? ''
  try {
    throwIfActivationCancelled(signal)
    const capabilities = inspectAlphaSolveAgentCapabilities(agent)
    if (capabilities.missingTools.length > 0) {
      return {
        activated: false,
        workspace,
        reason: AGENT_PRESET_MISSING_TOOLS_REASON,
        ...(capabilities.agentPreset === undefined ? {} : { agentPreset: capabilities.agentPreset }),
        missingTools: capabilities.missingTools,
      }
    }
    const { runtime, resumed } = await AlphaSolveRuntime.activate(agent, request, defaults, onDisposed, signal)
    return {
      activated: true,
      workspace: runtime.workspace,
      capacity: runtime.store.currentState().capacity,
      resumed,
      runtime,
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (error instanceof ExistingSolutionConfirmationError) {
      return {
        activated: false,
        workspace: error.workspace,
        reason: 'solution_exists_confirmation_required',
      }
    }
    if (error instanceof AgentPresetPromptConflictError) {
      return {
        activated: false,
        workspace,
        reason: AGENT_PRESET_BLOCKS_PROMPT_REASON,
        ...(error.agentPreset === undefined ? {} : { agentPreset: error.agentPreset }),
      }
    }
    return {
      activated: false,
      workspace,
      reason: errorMessage(error),
    }
  }
}

/**
 * Reattach a runtime only when the selected workspace carries durable active
 * intent for this exact resumed session. This is recovery, never a new
 * activation: it cannot archive a generation or authorize solution overwrite.
 */
export async function restoreAlphaSolveRuntime(
  agent: Agent,
  defaults: AlphaSolveRuntimeDefaults,
  onDisposed: () => void,
  signal?: AbortSignal,
): Promise<RuntimeRestoreResult> {
  const workspace = agent.session.header.cwd ?? ''
  try {
    throwIfActivationCancelled(signal)
    const probe = await probeRuntimeRestore(agent)
    throwIfActivationCancelled(signal)
    if (!probe.candidate) {
      return {
        restored: false,
        workspace: probe.workspace,
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
      }
    }
    const capabilities = inspectAlphaSolveAgentCapabilities(agent)
    if (capabilities.missingTools.length > 0) {
      return {
        restored: false,
        workspace: probe.workspace,
        reason: AGENT_PRESET_MISSING_TOOLS_REASON,
        ...(capabilities.agentPreset === undefined ? {} : { agentPreset: capabilities.agentPreset }),
        missingTools: capabilities.missingTools,
      }
    }
    const { runtime } = await AlphaSolveRuntime.activate(
      agent,
      {},
      defaults,
      onDisposed,
      signal,
      'session-resume',
    )
    return {
      restored: true,
      workspace: runtime.workspace,
      capacity: runtime.store.currentState().capacity,
      runtime,
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (error instanceof AgentPresetPromptConflictError) {
      return {
        restored: false,
        workspace,
        reason: AGENT_PRESET_BLOCKS_PROMPT_REASON,
        ...(error.agentPreset === undefined ? {} : { agentPreset: error.agentPreset }),
      }
    }
    return { restored: false, workspace, reason: errorMessage(error) }
  }
}
