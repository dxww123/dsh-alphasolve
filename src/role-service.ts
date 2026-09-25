/** Production bridge from the fixed AlphaSolve workflow to fresh DSH role Agents. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  JsonSchemaNode,
  ToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'

import {
  CALCULATOR_TOOL_NAME,
  createCalculatorTool,
} from './calculator.js'
import type {
  CuratorRunner,
  CuratorRunnerContext,
} from './curator.js'
import type {
  CuratorKnowledgeTools,
  ReferencePart,
} from './curator-tools.js'
import { resolveRoleModelSelection } from './model-config.js'
import {
  createRolePolicy,
  type RoleKind,
  type RolePermissionPolicy,
  type RolePolicyScope,
} from './permissions.js'
import {
  ROLE_MAX_TURNS,
  ROLE_SUBAGENTS,
  buildCuratorDigestTask,
  buildCuratorHealthCheckTask,
  loadRolePrompt,
} from './prompts.js'
import {
  runRoleAgent,
  type RoleActivityReporter,
  type RoleRunFailure,
  type RoleRunFailurePhase,
  type RoleRunResult,
  type RunRoleAgentOptions,
} from './role-runner.js'
import {
  createResearchReviewTools,
  RESEARCH_REVIEW_TOOL_NAMES,
  type ResearchReviewTools,
} from './research-tools.js'
import type {
  AlphaSolveConfig,
  CuratorTask,
  ModelRole,
} from './types.js'
import type {
  PropositionFilenameBuilder,
  PropositionFilenameRequest,
  RoleInvocation,
  RoleInvocationResult,
  RoleInvoker,
  WorkflowRole,
} from './workflow.js'
import { resolveWorkspacePath } from './workspace.js'

export const SUBAGENT_TOOL_NAME = 'alphasolve_subagent'

export const CURATOR_TOOL_NAMES = Object.freeze({
  read: 'alphasolve_curator_read',
  write: 'alphasolve_curator_write',
  edit: 'alphasolve_curator_edit',
  mkdir: 'alphasolve_curator_mkdir',
  rename: 'alphasolve_curator_rename',
  move: 'alphasolve_curator_move',
  splitReference: 'alphasolve_curator_split_reference',
  delete: 'alphasolve_curator_delete',
  list: 'alphasolve_curator_list',
  glob: 'alphasolve_curator_glob',
  grep: 'alphasolve_curator_grep',
} as const)

type SubagentType = 'compute' | 'numerical_experiment' | 'research_reviewer' | 'reasoning'

export type RoleAgentRunner = (options: RunRoleAgentOptions) => Promise<RoleRunResult>

export interface RoleTraceEvent {
  readonly kind: 'workflow_role' | 'subagent' | 'research_review'
  readonly role: WorkflowRole | RoleKind
  readonly task: string
  readonly text: string
  readonly stopReason: RoleRunResult['stopReason']
  readonly steps: number
  readonly agentId: string
  readonly workerId?: string
  readonly parentRole?: WorkflowRole | 'curator'
  /** Present when the runner rejected before producing an ordinary result. */
  readonly phase?: RoleRunFailurePhase
  readonly error?: RoleTraceError
  readonly cleanupError?: RoleTraceError
  readonly turnEndReason?: RoleRunFailure['turnEndReason']
}

export interface RoleTraceError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

/** Persist a trace and optionally return its workspace-relative artifact path. */
export type RoleTraceHandler = (
  event: RoleTraceEvent,
) => string | undefined | Promise<string | undefined>

export interface AlphaSolveRoleServiceOptions {
  /** The interactive DSH session Agent which owns this AlphaSolve runtime. */
  readonly parent: Agent
  /** Absolute activated workspace. */
  readonly workspace: string
  /** Read at every fresh invocation so prompt-time configuration changes apply. */
  readonly getConfig: () => AlphaSolveConfig
  /** Optional durable trace handoff (normally a curator-queue submitter). */
  readonly onTrace?: RoleTraceHandler
  /** Test seam; production uses runRoleAgent. */
  readonly runner?: RoleAgentRunner
}

export interface ResearchReviewRequest {
  readonly signal: AbortSignal
  readonly prompt?: string
  readonly workerId?: string
}

export class RoleAgentDidNotCompleteError extends Error {
  constructor(
    public readonly label: string,
    public readonly result: RoleRunResult,
  ) {
    super(`AlphaSolve ${label} Agent stopped with ${result.stopReason}`)
    this.name = 'RoleAgentDidNotCompleteError'
  }
}

interface RunWithTraceResult {
  readonly result: RoleRunResult
  readonly trace: RoleTraceEvent
}

const SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  'compute',
  'numerical_experiment',
  'research_reviewer',
  'reasoning',
])

const CURATOR_TOOLS = Object.freeze(Object.values(CURATOR_TOOL_NAMES))

const PATH_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { path: { type: 'string' } },
  required: ['path'],
} as const satisfies JsonSchemaNode

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('role call cancelled', 'AbortError')
}

function argumentRecord(args: unknown, tool: string): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new TypeError(`${tool} arguments must be an object`)
  }
  return args as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(record).filter(key => !allowedSet.has(key))
  if (unexpected.length > 0) throw new TypeError(`${tool} received unexpected argument ${unexpected[0]}`)
}

function stringArgument(record: Record<string, unknown>, field: string, tool: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new TypeError(`${tool}.${field} must be a string`)
  return value
}

function optionalStringArgument(record: Record<string, unknown>, field: string, tool: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${tool}.${field} must be a string`)
  return value
}

function optionalIntegerArgument(record: Record<string, unknown>, field: string, tool: string): number | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) throw new TypeError(`${tool}.${field} must be a safe integer`)
  return value as number
}

function optionalBooleanArgument(record: Record<string, unknown>, field: string, tool: string): boolean | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${tool}.${field} must be a boolean`)
  return value
}

function jsonTool(options: {
  readonly name: string
  readonly description: string
  readonly parameters: ToolDefinition['parameters']
  readonly outputSchema: JsonSchemaNode
  readonly execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
}): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: options.execute,
  }
}

function workflowRoleKind(role: WorkflowRole): RoleKind {
  switch (role) {
    case 'generator': return 'generator'
    case 'verifier_citation': return 'verifier_citation'
    case 'verifier_format_references':
    case 'verifier_failure_modes':
    case 'verifier_stepwise':
    case 'verifier_premise_chain':
    case 'review_verdict_judge': return 'verifier'
    case 'reviser': return 'reviser'
    case 'theorem_checker': return 'theorem_checker'
  }
}

function modelRole(role: WorkflowRole | RoleKind): ModelRole {
  switch (role) {
    case 'generator': return 'generator'
    case 'verifier':
    case 'verifier_citation': return 'verifier'
    case 'reviser': return 'reviser'
    case 'theorem_checker': return 'theorem_checker'
    case 'curator':
    case 'curator_helper': return 'curator'
    case 'compute': return 'compute'
    case 'numerical_experiment': return 'numerical_experiment'
    case 'research_reviewer': return 'research_reviewer'
    case 'reasoning': return 'reasoning'
    case 'verifier_format_references':
    case 'verifier_failure_modes':
    case 'verifier_stepwise':
    case 'verifier_premise_chain':
    case 'review_verdict_judge': return 'verifier'
    case 'orchestrator': throw new TypeError('the orchestrator is not a role-service child route')
  }
}

function allowedSubagents(role: WorkflowRole | 'curator'): readonly SubagentType[] {
  return ROLE_SUBAGENTS[role] as readonly SubagentType[]
}

function readRoots(policy: RolePermissionPolicy): string[] {
  return [...new Set(policy.paths
    .filter(rule => (rule.effect ?? 'allow') === 'allow' && rule.access.includes('read'))
    .map(rule => rule.root))]
}

function completed(result: RoleRunResult, label: string): RoleRunResult {
  if (result.stopReason !== 'completed') throw new RoleAgentDidNotCompleteError(label, result)
  return result
}

function traceEvent(
  kind: RoleTraceEvent['kind'],
  role: RoleTraceEvent['role'],
  task: string,
  result: RoleRunResult,
  context: { readonly workerId?: string; readonly parentRole?: WorkflowRole | 'curator' } = {},
): RoleTraceEvent {
  return Object.freeze({
    kind,
    role,
    task,
    text: result.text,
    stopReason: result.stopReason,
    steps: result.steps,
    agentId: String(result.agentId),
    ...(context.workerId === undefined ? {} : { workerId: context.workerId }),
    ...(context.parentRole === undefined ? {} : { parentRole: context.parentRole }),
  })
}

function traceError(error: unknown): RoleTraceError {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return Object.freeze({
      name: error.name || 'Error',
      message: error.message,
      ...(code === undefined ? {} : { code }),
    })
  }
  return Object.freeze({ name: typeof error, message: String(error) })
}

function failedTraceEvent(
  kind: RoleTraceEvent['kind'],
  role: RoleTraceEvent['role'],
  task: string,
  failure: RoleRunFailure,
  context: { readonly workerId?: string; readonly parentRole?: WorkflowRole | 'curator' } = {},
): RoleTraceEvent {
  return Object.freeze({
    kind,
    role,
    task,
    text: failure.text,
    stopReason: 'error',
    steps: failure.steps,
    agentId: failure.agentId,
    phase: failure.phase,
    error: traceError(failure.error),
    ...(failure.cleanupError === undefined ? {} : { cleanupError: traceError(failure.cleanupError) }),
    ...(failure.turnEndReason === undefined ? {} : { turnEndReason: failure.turnEndReason }),
    ...(context.workerId === undefined ? {} : { workerId: context.workerId }),
    ...(context.parentRole === undefined ? {} : { parentRole: context.parentRole }),
  })
}

function subagentArguments(args: unknown): { readonly type: SubagentType; readonly task: string } {
  const record = argumentRecord(args, SUBAGENT_TOOL_NAME)
  exactKeys(record, ['type', 'task'], SUBAGENT_TOOL_NAME)
  const type = stringArgument(record, 'type', SUBAGENT_TOOL_NAME)
  const task = stringArgument(record, 'task', SUBAGENT_TOOL_NAME)
  if (!SUBAGENT_TYPES.has(type)) throw new TypeError(`unsupported AlphaSolve subagent type: ${type}`)
  if (task.trim().length === 0) throw new TypeError('alphasolve_subagent.task must not be empty')
  return { type: type as SubagentType, task }
}

function safeWorkerId(workerId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workerId)) {
    throw new TypeError(`unsafe AlphaSolve worker id: ${workerId}`)
  }
  return workerId
}

/**
 * Session-owned implementation of RoleInvoker and the auxiliary AlphaSolve
 * Agent routes. No Agent or scoped tool is shared between calls.
 */
export class AlphaSolveRoleService implements RoleInvoker {
  private readonly parent: Agent
  private readonly workspace: string
  private readonly getConfig: () => AlphaSolveConfig
  private readonly onTrace: RoleTraceHandler | undefined
  private readonly runner: RoleAgentRunner
  private readonly workerArtifactPaths = new Map<string, Set<string>>()

  constructor(options: AlphaSolveRoleServiceOptions) {
    if (!path.isAbsolute(options.workspace)) throw new TypeError('AlphaSolve role-service workspace must be absolute')
    this.parent = options.parent
    this.workspace = path.resolve(options.workspace)
    this.getConfig = options.getConfig
    this.onTrace = options.onTrace
    this.runner = options.runner ?? runRoleAgent
  }

  private inheritedModelSelection(): ModelSelection {
    const inherited = this.parent.session.requestHeader()?.config ?? this.parent.options
    const { provider, model, reasoningEffort } = inherited
    if (provider === undefined || provider.trim().length === 0
      || model === undefined || model.trim().length === 0) {
      throw new Error('AlphaSolve cannot inherit a model route before the main session has selected provider and model')
    }
    return Object.freeze({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
  }

  private modelSelection(role: WorkflowRole | RoleKind): ModelSelection {
    return resolveRoleModelSelection(
      modelRole(role),
      this.inheritedModelSelection(),
      this.getConfig().models,
    )
  }

  private async runWithTrace(
    options: RunRoleAgentOptions,
    trace: {
      readonly kind: RoleTraceEvent['kind']
      readonly role: RoleTraceEvent['role']
      readonly task: string
      readonly workerId?: string
      readonly parentRole?: WorkflowRole | 'curator'
    },
  ): Promise<RunWithTraceResult> {
    let reportedFailure: RoleRunFailure | undefined
    let result: RoleRunResult
    try {
      result = await this.runner({
        ...options,
        onFailure: (failure): void => {
          reportedFailure = failure
          options.onFailure?.(failure)
        },
      })
    } catch (error) {
      const failure = reportedFailure ?? {
        agentId: 'unavailable',
        role: options.role,
        phase: 'run',
        output: [],
        text: '',
        steps: 0,
        error,
      } satisfies RoleRunFailure
      const event = failedTraceEvent(trace.kind, trace.role, trace.task, failure, trace)
      try {
        await this.recordTrace(event, trace.workerId)
      } catch {
        // The operational runner error is authoritative; trace persistence is
        // best effort on this path and must never replace it.
      }
      throw error
    }
    const event = traceEvent(trace.kind, trace.role, trace.task, result, trace)
    await this.recordTrace(event, trace.workerId)
    completed(result, String(trace.role))
    return { result, trace: event }
  }

  private async recordTrace(event: RoleTraceEvent, workerId: string | undefined): Promise<void> {
    const artifactPath = await this.onTrace?.(event)
    if (artifactPath !== undefined && workerId !== undefined) {
      let paths = this.workerArtifactPaths.get(workerId)
      if (paths === undefined) {
        paths = new Set()
        this.workerArtifactPaths.set(workerId, paths)
      }
      paths.add(artifactPath)
    }
  }

  /** Durable trace paths accumulated for one worker, including helper traces. */
  artifactPaths(workerId: string): readonly string[] {
    return [...(this.workerArtifactPaths.get(workerId) ?? [])].sort()
  }

  private workflowPolicy(request: RoleInvocation, extraAllowedTools: readonly string[]): RolePermissionPolicy {
    const role = workflowRoleKind(request.role)
    const scope: RolePolicyScope = {
      workspace: request.cwd,
      knowledgeDirectory: path.join(request.workspace, 'knowledge'),
      verifiedDirectory: path.join(request.workspace, 'verified_propositions'),
      workerDirectory: request.workerDirectory,
      propositionFile: request.propositionPath,
      ...(request.theoremViewDirectory === undefined ? {} : {
        theoremViewDirectory: request.theoremViewDirectory,
      }),
      extraAllowedTools,
    }
    return createRolePolicy(role, scope)
  }

  private helperSetup(
    callerRole: WorkflowRole | 'curator',
    workerId: string | undefined,
    callerPolicy: RolePermissionPolicy,
  ): (ctx: Context, child: Agent, reportActivity: RoleActivityReporter) => void {
    const admitted = allowedSubagents(callerRole)
    return (ctx, child, reportActivity = () => undefined): void => {
      ctx.tools.register(this.createSubagentTool(
        callerRole,
        workerId,
        child,
        callerPolicy,
        admitted,
        reportActivity,
      ))
    }
  }

  private createSubagentTool(
    callerRole: WorkflowRole | 'curator',
    workerId: string | undefined,
    child: Agent,
    callerPolicy: RolePermissionPolicy,
    admitted: readonly SubagentType[],
    reportActivity: RoleActivityReporter,
  ): ToolDefinition {
    return jsonTool({
      name: SUBAGENT_TOOL_NAME,
      description: `Run one fresh, bounded AlphaSolve helper. Allowed types for this role: ${admitted.join(', ')}.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          task: { type: 'string' },
        },
        required: ['type', 'task'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          result: { type: 'string' },
        },
        required: ['type', 'result'],
      },
      execute: async (args, exec) => {
        reportActivity()
        const request = subagentArguments(args)
        if (!admitted.includes(request.type)) {
          throw new Error(`AlphaSolve role "${callerRole}" cannot launch subagent type "${request.type}"`)
        }
        throwIfAborted(exec.signal)

        const calculator = request.type === 'compute' || request.type === 'numerical_experiment'
        const helperPolicy = createRolePolicy(request.type, {
          workspace: this.workspace,
          delegatedReadRoots: readRoots(callerPolicy),
          extraAllowedTools: calculator ? [CALCULATOR_TOOL_NAME] : [],
        })
        const run = await this.runWithTrace({
          parent: child,
          role: request.type,
          cwd: this.workspace,
          persona: loadRolePrompt(request.type),
          prompt: request.task,
          maxTurns: ROLE_MAX_TURNS[request.type],
          signal: exec.signal,
          permissionPolicy: helperPolicy,
          modelSelection: this.modelSelection(request.type),
          onActivity: reportActivity,
          ...(calculator ? {
            setupHelpers: (helperCtx: Context): void => {
              helperCtx.tools.register(createCalculatorTool())
            },
          } : {}),
        }, {
          kind: 'subagent',
          role: request.type,
          task: request.task,
          ...(workerId === undefined ? {} : { workerId }),
          parentRole: callerRole,
        })
        return { type: request.type, result: run.result.text }
      },
    })
  }

  async invoke(request: RoleInvocation): Promise<RoleInvocationResult> {
    throwIfAborted(request.signal)
    const admitted = allowedSubagents(request.role)
    const helperEnabled = admitted.length > 0
    const policy = this.workflowPolicy(request, helperEnabled ? [SUBAGENT_TOOL_NAME] : [])
    const role = workflowRoleKind(request.role)
    const run = await this.runWithTrace({
      parent: this.parent,
      role,
      cwd: request.cwd,
      persona: request.persona,
      prompt: request.task,
      maxTurns: request.maxTurns,
      signal: request.signal,
      permissionPolicy: policy,
      modelSelection: this.modelSelection(request.role),
      ...(request.role === 'review_verdict_judge' ? { allowedInheritedTools: [] } : {}),
      ...(helperEnabled ? {
        setupHelpers: this.helperSetup(request.role, request.workerId, policy),
      } : {}),
    }, {
      kind: 'workflow_role',
      role: request.role,
      task: request.task,
      workerId: request.workerId,
    })
    return {
      text: run.result.text,
      ...(this.getConfig().detailedTrace ? { trace: [run.trace] } : {}),
    }
  }

  /** No-tool, one-step generator-model route used only to name a verified proposition. */
  readonly buildPropositionFilename: PropositionFilenameBuilder = async (
    request: PropositionFilenameRequest,
  ): Promise<string> => {
    throwIfAborted(request.signal)
    const workerId = safeWorkerId(request.workerId)
    const workerDirectory = path.join(this.workspace, 'unverified_propositions', `prop-${workerId}`)
    const propositionFile = path.join(workerDirectory, 'proposition.md')
    const result = await this.runner({
      parent: this.parent,
      role: 'generator',
      cwd: this.workspace,
      persona: 'You are the AlphaSolve proposition filename generator. Return only the requested filename.',
      prompt: request.prompt,
      maxTurns: 1,
      signal: request.signal,
      permissionPolicy: createRolePolicy('generator', {
        workspace: this.workspace,
        workerDirectory,
        propositionFile,
      }),
      modelSelection: this.modelSelection('generator'),
      allowedInheritedTools: [],
    })
    return completed(result, 'proposition filename generator').text
  }

  /** Fresh, read-only, non-nesting research review route for the orchestrator. */
  readonly runResearchReview = async (request: ResearchReviewRequest): Promise<string> => {
    throwIfAborted(request.signal)
    const task = request.prompt?.trim() || 'Review the current verified research progress and recommend the next best-supported directions.'
    const tools = await createResearchReviewTools(this.workspace)
    const definitions = createResearchReviewToolDefinitions(tools)
    const policy = createRolePolicy('research_reviewer', {
      workspace: this.workspace,
      extraAllowedTools: definitions.map(definition => definition.name),
    })
    const run = await this.runWithTrace({
      parent: this.parent,
      role: 'research_reviewer',
      cwd: this.workspace,
      persona: loadRolePrompt('research_reviewer'),
      prompt: task,
      maxTurns: ROLE_MAX_TURNS.research_reviewer,
      signal: request.signal,
      permissionPolicy: policy,
      modelSelection: this.modelSelection('research_reviewer'),
      setupHelpers: (ctx): void => {
        for (const definition of definitions) ctx.tools.register(definition)
      },
    }, {
      kind: 'research_review',
      role: 'research_reviewer',
      task,
      ...(request.workerId === undefined ? {} : { workerId: request.workerId }),
    })
    return run.result.text
  }

  private async curatorTaskPrompt(task: CuratorTask): Promise<string> {
    if (task.kind === 'health_check') {
      const scan = typeof task.metadata?.scanText === 'string' ? task.metadata.scanText : ''
      return buildCuratorHealthCheckTask(scan)
    }

    let trace: readonly unknown[] = task.metadata === undefined ? [] : [task.metadata]
    if (task.tracePath !== undefined) {
      const tracePath = await resolveWorkspacePath(this.workspace, task.tracePath, { mustExist: true })
      const decoded = JSON.parse(await readFile(tracePath, 'utf8')) as unknown
      trace = Array.isArray(decoded) ? decoded : [decoded]
    }
    return buildCuratorDigestTask({
      traceKind: typeof task.metadata?.traceKind === 'string' ? task.metadata.traceKind : task.kind,
      trace,
      callerContext: task.metadata ?? null,
      finalVerifierReview: task.kind === 'verifier_final',
    })
  }

  /** DurableCurator-compatible runner; it deliberately never traces itself. */
  readonly runCurator: CuratorRunner = async (context: CuratorRunnerContext): Promise<void> => {
    throwIfAborted(context.signal)
    const task = await this.curatorTaskPrompt(context.task)
    const admitted = allowedSubagents('curator')
    const extraTools = [...CURATOR_TOOLS, ...(admitted.length > 0 ? [SUBAGENT_TOOL_NAME] : [])]
    const policy = createRolePolicy('curator', {
      workspace: this.workspace,
      extraAllowedTools: extraTools,
    })
    const result = await this.runner({
      parent: this.parent,
      role: 'curator',
      cwd: this.workspace,
      persona: loadRolePrompt('curator'),
      prompt: task,
      maxTurns: ROLE_MAX_TURNS.curator,
      signal: context.signal,
      permissionPolicy: policy,
      modelSelection: this.modelSelection('curator'),
      allowedInheritedTools: [],
      setupHelpers: (ctx, child, reportActivity = () => undefined): void => {
        for (const tool of createCuratorTools(context.tools)) ctx.tools.register(tool)
        if (admitted.length > 0) {
          ctx.tools.register(this.createSubagentTool(
            'curator',
            undefined,
            child,
            policy,
            admitted,
            reportActivity,
          ))
        }
      },
    })
    completed(result, `curator ${context.task.kind}`)
  }
}

/** Build the two AlphaSolve-main research navigation tools for one reviewer. */
export function createResearchReviewToolDefinitions(
  tools: ResearchReviewTools,
): readonly ToolDefinition[] {
  const progress = jsonTool({
    name: RESEARCH_REVIEW_TOOL_NAMES.progress,
    description: [
      'Primary first-pass audit over problem.md, actual verified proposition Statements, and exploratory knowledge.',
      'Returns a program-ranked, globally budgeted research map rather than every file body: selected Statements, proof-tail conclusion signals, knowledge gaps, and suggested paths for deeper inspection.',
      'Treat verified Statements as authoritative; indexes and knowledge remain navigation or exploratory evidence. Call this before broad manual reads.',
    ].join('\n'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        maxFiles: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
    outputSchema: { type: 'object' },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, RESEARCH_REVIEW_TOOL_NAMES.progress)
      exactKeys(record, ['path', 'paths', 'maxFiles'], RESEARCH_REVIEW_TOOL_NAMES.progress)
      const requestedPath = optionalStringArgument(record, 'path', RESEARCH_REVIEW_TOOL_NAMES.progress)
      let requestedPaths: string[] | undefined
      if (record.paths !== undefined) {
        if (!Array.isArray(record.paths) || record.paths.some(item => typeof item !== 'string')) {
          throw new TypeError(`${RESEARCH_REVIEW_TOOL_NAMES.progress}.paths must be a string array`)
        }
        requestedPaths = record.paths as string[]
      }
      const maxFiles = optionalIntegerArgument(record, 'maxFiles', RESEARCH_REVIEW_TOOL_NAMES.progress)
      return tools.progressReview({
        ...(requestedPath === undefined ? {} : { path: requestedPath }),
        ...(requestedPaths === undefined ? {} : { paths: requestedPaths }),
        ...(maxFiles === undefined ? {} : { maxFiles }),
      })
    },
  })
  const inspectMarkdown = jsonTool({
    name: RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown,
    description: [
      'Deepen the compact progress map on one selected Markdown path or directory.',
      'Returns headings, the relevant Statement/progress section, and the proof tail for a small bounded set of files. Use exact Read only after this narrows the required passage.',
    ].join('\n'),
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' },
        maxFiles: { type: 'integer', minimum: 1, maximum: 100 },
        tailLines: { type: 'integer', minimum: 1, maximum: 200 },
        statementLines: { type: 'integer', minimum: 1, maximum: 300 },
      },
    },
    outputSchema: { type: 'object' },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown)
      exactKeys(
        record,
        ['path', 'maxFiles', 'tailLines', 'statementLines'],
        RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown,
      )
      const requestedPath = optionalStringArgument(record, 'path', RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown)
      const maxFiles = optionalIntegerArgument(record, 'maxFiles', RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown)
      const tailLines = optionalIntegerArgument(record, 'tailLines', RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown)
      const statementLines = optionalIntegerArgument(record, 'statementLines', RESEARCH_REVIEW_TOOL_NAMES.inspectMarkdown)
      return tools.inspectMarkdown(requestedPath, {
        ...(maxFiles === undefined ? {} : { maxFiles }),
        ...(tailLines === undefined ? {} : { tailLines }),
        ...(statementLines === undefined ? {} : { statementLines }),
      })
    },
  })
  return [progress, inspectMarkdown]
}

/** Build the no-shell, knowledge-only tool surface for one curator invocation. */
export function createCuratorTools(tools: CuratorKnowledgeTools): readonly ToolDefinition[] {
  const read = jsonTool({
    name: CURATOR_TOOL_NAMES.read,
    description: 'Read an exact line range from one file below knowledge/.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path'],
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' }, content: { type: 'string' },
        startLine: { type: 'integer' }, endLine: { type: 'integer' }, totalLines: { type: 'integer' },
      },
      required: ['path', 'content', 'startLine', 'endLine', 'totalLines'],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.read)
      exactKeys(record, ['path', 'startLine', 'endLine'], CURATOR_TOOL_NAMES.read)
      const startLine = optionalIntegerArgument(record, 'startLine', CURATOR_TOOL_NAMES.read)
      const endLine = optionalIntegerArgument(record, 'endLine', CURATOR_TOOL_NAMES.read)
      return tools.read(stringArgument(record, 'path', CURATOR_TOOL_NAMES.read), {
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine }),
      })
    },
  })

  const write = jsonTool({
    name: CURATOR_TOOL_NAMES.write,
    description: 'Create, overwrite, or append one knowledge file; references remain protected.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string' }, content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append'] },
      },
      required: ['path', 'content'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.write)
      exactKeys(record, ['path', 'content', 'mode'], CURATOR_TOOL_NAMES.write)
      const mode = optionalStringArgument(record, 'mode', CURATOR_TOOL_NAMES.write)
      if (mode !== undefined && mode !== 'overwrite' && mode !== 'append') {
        throw new TypeError(`${CURATOR_TOOL_NAMES.write}.mode is invalid`)
      }
      return tools.write(
        stringArgument(record, 'path', CURATOR_TOOL_NAMES.write),
        stringArgument(record, 'content', CURATOR_TOOL_NAMES.write),
        mode === undefined ? {} : { mode },
      )
    },
  })

  const edit = jsonTool({
    name: CURATOR_TOOL_NAMES.edit,
    description: 'Replace one unique exact text occurrence in a knowledge file.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
      required: ['path', 'oldText', 'newText'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.edit)
      exactKeys(record, ['path', 'oldText', 'newText'], CURATOR_TOOL_NAMES.edit)
      return tools.edit(
        stringArgument(record, 'path', CURATOR_TOOL_NAMES.edit),
        stringArgument(record, 'oldText', CURATOR_TOOL_NAMES.edit),
        stringArgument(record, 'newText', CURATOR_TOOL_NAMES.edit),
      )
    },
  })

  const mkdir = jsonTool({
    name: CURATOR_TOOL_NAMES.mkdir,
    description: 'Create one directory below knowledge/.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' } }, required: ['path'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.mkdir)
      exactKeys(record, ['path'], CURATOR_TOOL_NAMES.mkdir)
      return tools.mkdir(stringArgument(record, 'path', CURATOR_TOOL_NAMES.mkdir))
    },
  })

  const rename = jsonTool({
    name: CURATOR_TOOL_NAMES.rename,
    description: 'Rename one plain child name within a knowledge directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { directory: { type: 'string' }, oldName: { type: 'string' }, newName: { type: 'string' } },
      required: ['directory', 'oldName', 'newName'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.rename)
      exactKeys(record, ['directory', 'oldName', 'newName'], CURATOR_TOOL_NAMES.rename)
      return tools.rename(
        stringArgument(record, 'directory', CURATOR_TOOL_NAMES.rename),
        stringArgument(record, 'oldName', CURATOR_TOOL_NAMES.rename),
        stringArgument(record, 'newName', CURATOR_TOOL_NAMES.rename),
      )
    },
  })

  const move = jsonTool({
    name: CURATOR_TOOL_NAMES.move,
    description: 'Move one ordinary knowledge file into an existing knowledge directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, destinationDirectory: { type: 'string' } },
      required: ['path', 'destinationDirectory'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.move)
      exactKeys(record, ['path', 'destinationDirectory'], CURATOR_TOOL_NAMES.move)
      return tools.move(
        stringArgument(record, 'path', CURATOR_TOOL_NAMES.move),
        stringArgument(record, 'destinationDirectory', CURATOR_TOOL_NAMES.move),
      )
    },
  })

  const splitReference = jsonTool({
    name: CURATOR_TOOL_NAMES.splitReference,
    description: 'Split a human reference by exact inclusive line ranges without rewriting it.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        sourcePath: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } },
            required: ['path', 'startLine', 'endLine'],
          },
        },
      },
      required: ['sourcePath', 'parts'],
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'],
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.splitReference)
      exactKeys(record, ['sourcePath', 'parts'], CURATOR_TOOL_NAMES.splitReference)
      if (!Array.isArray(record.parts)) throw new TypeError(`${CURATOR_TOOL_NAMES.splitReference}.parts must be an array`)
      const parts: ReferencePart[] = record.parts.map((part, index) => {
        const value = argumentRecord(part, `${CURATOR_TOOL_NAMES.splitReference}.parts[${index}]`)
        exactKeys(value, ['path', 'startLine', 'endLine'], CURATOR_TOOL_NAMES.splitReference)
        const startLine = optionalIntegerArgument(value, 'startLine', CURATOR_TOOL_NAMES.splitReference)
        const endLine = optionalIntegerArgument(value, 'endLine', CURATOR_TOOL_NAMES.splitReference)
        if (startLine === undefined || endLine === undefined) {
          throw new TypeError(`${CURATOR_TOOL_NAMES.splitReference} part ranges are required`)
        }
        return { path: stringArgument(value, 'path', CURATOR_TOOL_NAMES.splitReference), startLine, endLine }
      })
      return tools.splitReference(stringArgument(record, 'sourcePath', CURATOR_TOOL_NAMES.splitReference), parts)
    },
  })

  const remove = jsonTool({
    name: CURATOR_TOOL_NAMES.delete,
    description: 'Delete one ordinary knowledge file or one empty knowledge directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' } }, required: ['path'],
    },
    outputSchema: PATH_RESULT_SCHEMA,
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.delete)
      exactKeys(record, ['path'], CURATOR_TOOL_NAMES.delete)
      return tools.delete(stringArgument(record, 'path', CURATOR_TOOL_NAMES.delete))
    },
  })

  const list = jsonTool({
    name: CURATOR_TOOL_NAMES.list,
    description: 'List immediate entries in one knowledge directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' } },
    },
    outputSchema: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, type: { type: 'string' } }, required: ['path', 'type'],
      },
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.list)
      exactKeys(record, ['path'], CURATOR_TOOL_NAMES.list)
      return tools.list(optionalStringArgument(record, 'path', CURATOR_TOOL_NAMES.list))
    },
  })

  const glob = jsonTool({
    name: CURATOR_TOOL_NAMES.glob,
    description: 'Find knowledge files matching a restricted glob.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { pattern: { type: 'string' } }, required: ['pattern'],
    },
    outputSchema: { type: 'array', items: { type: 'string' } },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.glob)
      exactKeys(record, ['pattern'], CURATOR_TOOL_NAMES.glob)
      return tools.glob(stringArgument(record, 'pattern', CURATOR_TOOL_NAMES.glob))
    },
  })

  const grep = jsonTool({
    name: CURATOR_TOOL_NAMES.grep,
    description: 'Search text below knowledge/ with bounded results.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string' }, path: { type: 'string' },
        caseSensitive: { type: 'boolean' }, maxResults: { type: 'integer' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, line: { type: 'integer' }, text: { type: 'string' } },
        required: ['path', 'line', 'text'],
      },
    },
    execute: async (args, exec) => {
      throwIfAborted(exec.signal)
      const record = argumentRecord(args, CURATOR_TOOL_NAMES.grep)
      exactKeys(record, ['query', 'path', 'caseSensitive', 'maxResults'], CURATOR_TOOL_NAMES.grep)
      const grepPath = optionalStringArgument(record, 'path', CURATOR_TOOL_NAMES.grep)
      const caseSensitive = optionalBooleanArgument(record, 'caseSensitive', CURATOR_TOOL_NAMES.grep)
      const maxResults = optionalIntegerArgument(record, 'maxResults', CURATOR_TOOL_NAMES.grep)
      return tools.grep(stringArgument(record, 'query', CURATOR_TOOL_NAMES.grep), {
        ...(grepPath === undefined ? {} : { path: grepPath }),
        ...(caseSensitive === undefined ? {} : { caseSensitive }),
        ...(maxResults === undefined ? {} : { maxResults }),
      })
    },
  })

  return Object.freeze([read, write, edit, mkdir, rename, move, splitReference, remove, list, glob, grep])
}
