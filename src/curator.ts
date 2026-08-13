/** Durable, single-consumer curator queue. */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, DurableDataError, readJson } from './atomic.js'
import {
  createCuratorKnowledgeTools,
  type CuratorKnowledgeTools,
} from './curator-tools.js'
import {
  STATE_VERSION,
  type CuratorTask,
  type CuratorTaskKind,
} from './types.js'
import {
  canonicalWorkspace,
  isContained,
  normalizeRelativePath,
  resolveWorkspacePath,
  WorkspaceError,
} from './workspace.js'

const QUEUE_RELATIVE_PATH = '.alphasolve/curator/queue.json'
const HEALTH_CHECK_INTERVAL = 4

interface CuratorQueueFile {
  readonly version: typeof STATE_VERSION
  readonly tasks: readonly CuratorTask[]
}

export interface CuratorTaskInput {
  /** Optional caller-owned idempotency key. Generated once when omitted. */
  readonly id?: string
  readonly kind: CuratorTaskKind
  readonly sourceWorkerId?: string
  readonly tracePath?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

export interface CuratorRunnerContext {
  readonly task: CuratorTask
  readonly tools: CuratorKnowledgeTools
  /** Aborted only when the bounded shutdown drain expires. */
  readonly signal: AbortSignal
}

export type CuratorRunner = (context: CuratorRunnerContext) => Promise<void>

export interface DurableCuratorOptions {
  readonly workspaceRoot: string
  /** Creates one fresh curator role-agent invocation for each durable task. */
  readonly runner: CuratorRunner
  readonly idFactory?: () => string
  readonly now?: () => Date
  /** Surface a durable task failure to the owning orchestrator. */
  readonly onTaskFailure?: (task: CuratorTask, error: unknown) => void
  /** Defaults to the AlphaSolve shutdown contract of sixty seconds. */
  readonly drainTimeoutMs?: number
}

export interface CuratorStopResult {
  readonly drained: boolean
  readonly pending: number
  readonly active: number
  readonly failed: number
}

type WaitToken = {
  readonly kind: 'wait'
  readonly promise: Promise<void>
}

type DispatchToken = {
  readonly kind: 'task'
  readonly task: CuratorTask
  readonly controller: AbortController
  readonly generation: symbol
}

type NextAction = WaitToken | DispatchToken | { readonly kind: 'stop' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

function requireTracePath(value: string, queuePath?: string): string {
  let normalized: string
  try {
    normalized = normalizeRelativePath(value)
  } catch (error) {
    if (queuePath !== undefined) throw new DurableDataError('invalid curator trace path', queuePath, { cause: error })
    throw new TypeError(`curator trace path must be canonical below .alphasolve/traces/: ${value}`, { cause: error })
  }
  const prefix = '.alphasolve/traces/'
  const basename = normalized.slice(prefix.length)
  if (normalized !== value || !normalized.startsWith(prefix) || basename.length === 0
    || basename.includes('/') || path.extname(basename) !== '.json') {
    if (queuePath !== undefined) throw new DurableDataError('invalid curator trace path', queuePath)
    throw new TypeError(`curator trace path must be one canonical JSON file below .alphasolve/traces/: ${value}`)
  }
  return normalized
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0)
}

function parseTask(value: unknown, queuePath: string): CuratorTask {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['version', 'id', 'kind', 'createdAt', 'status', 'attempts'],
    ['sourceWorkerId', 'tracePath', 'metadata', 'lastError'],
  )) throw new DurableDataError('curator task must be an exact-schema object', queuePath)
  const kinds: readonly CuratorTaskKind[] = ['digest', 'verifier_final', 'health_check']
  const statuses: readonly CuratorTask['status'][] = ['pending', 'active', 'completed', 'failed']
  if (value.version !== STATE_VERSION
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.kind !== 'string' || !kinds.includes(value.kind as CuratorTaskKind)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.status !== 'string' || !statuses.includes(value.status as CuratorTask['status'])
    || !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0
    || !validOptionalString(value.sourceWorkerId)
    || !validOptionalString(value.tracePath)
    || !validOptionalString(value.lastError)) {
    throw new DurableDataError('invalid curator task', queuePath)
  }
  let metadata: Readonly<Record<string, string | number | boolean>> | undefined
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)
      || Object.values(value.metadata).some(item => typeof item !== 'string'
        && typeof item !== 'number' && typeof item !== 'boolean')) {
      throw new DurableDataError('invalid curator task metadata', queuePath)
    }
    metadata = Object.freeze({ ...value.metadata }) as Readonly<Record<string, string | number | boolean>>
  }
  const tracePath = value.tracePath === undefined
    ? undefined
    : requireTracePath(value.tracePath as string, queuePath)
  return Object.freeze({
    version: STATE_VERSION,
    id: value.id,
    kind: value.kind as CuratorTaskKind,
    createdAt: value.createdAt,
    ...(value.sourceWorkerId === undefined ? {} : { sourceWorkerId: value.sourceWorkerId as string }),
    ...(tracePath === undefined ? {} : { tracePath }),
    ...(metadata === undefined ? {} : { metadata }),
    status: value.status as CuratorTask['status'],
    attempts: value.attempts as number,
    ...(value.lastError === undefined ? {} : { lastError: value.lastError as string }),
  })
}

function parseQueueFile(value: unknown, queuePath: string): CuratorQueueFile {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'tasks'])
    || value.version !== STATE_VERSION || !Array.isArray(value.tasks)) {
    throw new DurableDataError('invalid curator queue file', queuePath)
  }
  const tasks = value.tasks.map(task => parseTask(task, queuePath))
  const ids = new Set<string>()
  for (const task of tasks) {
    if (ids.has(task.id)) throw new DurableDataError('duplicate curator task id', queuePath)
    ids.add(task.id)
  }
  return { version: STATE_VERSION, tasks }
}

async function validateTraceArtifact(workspaceRoot: string, tracePath: string): Promise<void> {
  const normalized = requireTracePath(tracePath)
  const tracesDirectory = await resolveWorkspacePath(workspaceRoot, '.alphasolve/traces', { mustExist: true })
  const canonicalTraces = await realpath(tracesDirectory)
  const expectedTraces = path.join(workspaceRoot, '.alphasolve', 'traces')
  if (canonicalTraces !== expectedTraces || !isContained(workspaceRoot, canonicalTraces)) {
    throw new WorkspaceError('curator trace directory escapes workspace', '.alphasolve/traces')
  }
  const absolute = path.join(workspaceRoot, ...normalized.split('/'))
  let info
  try {
    info = await lstat(absolute)
  } catch (error) {
    throw new WorkspaceError('curator trace does not exist', normalized, { cause: error })
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkspaceError('curator trace must be an ordinary non-symlink JSON file', normalized)
  }
  const canonical = await realpath(absolute)
  if (path.dirname(canonical) !== canonicalTraces || !isContained(canonicalTraces, canonical)) {
    throw new WorkspaceError('curator trace escapes its canonical directory', normalized)
  }
  await readJson(canonical)
}

function taskCopy(task: CuratorTask): CuratorTask {
  return {
    ...task,
    ...(task.metadata === undefined ? {} : { metadata: { ...task.metadata } }),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function readQueueFromCanonicalDirectory(
  workspaceRoot: string,
  canonicalDirectory: string,
  queuePath: string,
): Promise<CuratorQueueFile | undefined> {
  let info
  try {
    info = await lstat(queuePath)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new DurableDataError('curator queue must be an ordinary non-symlink file', queuePath)
  }
  const canonicalQueue = await realpath(queuePath)
  if (path.dirname(canonicalQueue) !== canonicalDirectory
    || !isContained(workspaceRoot, canonicalQueue)) {
    throw new WorkspaceError('curator queue escapes its state directory', QUEUE_RELATIVE_PATH)
  }
  return parseQueueFile(await readJson(canonicalQueue), canonicalQueue)
}

function timeoutPromise(milliseconds: number): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<void>(resolve => {
    timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/**
 * A durable FIFO which serializes curator role invocations.
 *
 * `open()` immediately starts the consumer. A process restart converts any
 * persisted `active` item back to `pending`, so that the whole idempotent task
 * is replayed from its beginning.
 */
export class DurableCurator {
  public readonly workspaceRoot: string
  public readonly queuePath: string

  private tasks: CuratorTask[]
  private readonly runner: CuratorRunner
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly onTaskFailure: (task: CuratorTask, error: unknown) => void
  private readonly drainTimeoutMs: number
  private mutationTail: Promise<void> = Promise.resolve()
  private accepting = true
  private timedOut = false
  private waiter: (() => void) | undefined
  private activeDispatch: DispatchToken | undefined
  private readonly idleWaiters = new Set<() => void>()
  private readonly loopPromise: Promise<void>
  private stopPromise: Promise<CuratorStopResult> | undefined

  private constructor(
    workspaceRoot: string,
    queuePath: string,
    tasks: CuratorTask[],
    options: DurableCuratorOptions,
  ) {
    this.workspaceRoot = workspaceRoot
    this.queuePath = queuePath
    this.tasks = tasks
    this.runner = options.runner
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.now = options.now ?? (() => new Date())
    this.onTaskFailure = options.onTaskFailure ?? (() => undefined)
    this.drainTimeoutMs = options.drainTimeoutMs ?? 60_000
    if (!Number.isSafeInteger(this.drainTimeoutMs) || this.drainTimeoutMs < 0) {
      throw new TypeError('drainTimeoutMs must be a non-negative safe integer')
    }
    this.loopPromise = this.consume()
  }

  static async open(options: DurableCuratorOptions): Promise<DurableCurator> {
    const workspaceRoot = await canonicalWorkspace(options.workspaceRoot)
    const curatorDirectory = await resolveWorkspacePath(workspaceRoot, '.alphasolve/curator', { mustExist: false })
    await mkdir(curatorDirectory, { recursive: true, mode: 0o700 })
    const canonicalDirectory = await realpath(curatorDirectory)
    if (canonicalDirectory !== path.join(workspaceRoot, '.alphasolve', 'curator')
      || !isContained(workspaceRoot, canonicalDirectory)) {
      throw new WorkspaceError('curator state directory escapes workspace', '.alphasolve/curator')
    }
    const queuePath = path.join(curatorDirectory, 'queue.json')
    let tasks: CuratorTask[] = []
    const queue = await readQueueFromCanonicalDirectory(workspaceRoot, canonicalDirectory, queuePath)
    if (queue !== undefined) {
      tasks = queue.tasks.map(task => (
        task.status === 'active'
          ? { ...task, status: 'pending' as const }
          : taskCopy(task)
      ))
      // Rewrite after validation so a crashed `active` task is durably pending
      // before this process begins a fresh attempt.
      await atomicWriteJson(queuePath, { version: STATE_VERSION, tasks })
    } else {
      await atomicWriteJson(queuePath, { version: STATE_VERSION, tasks })
    }
    return new DurableCurator(workspaceRoot, queuePath, tasks, options)
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private persist(): Promise<void> {
    return atomicWriteJson(this.queuePath, { version: STATE_VERSION, tasks: this.tasks })
  }

  private generateId(prefix = 'curator'): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = this.idFactory()
      if (typeof value !== 'string' || value.length === 0) throw new TypeError('idFactory must return a non-empty string')
      const id = `${prefix}-${value}`
      if (!this.tasks.some(task => task.id === id)) return id
    }
    throw new Error('unable to generate a unique curator task id')
  }

  private wakeConsumer(): void {
    const wake = this.waiter
    this.waiter = undefined
    wake?.()
  }

  private notifyIdleIfNeeded(): void {
    if (this.tasks.some(task => task.status === 'pending' || task.status === 'active')) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private digestCountSinceHealthCheck(): number {
    let count = 0
    for (let index = this.tasks.length - 1; index >= 0; index -= 1) {
      const task = this.tasks[index]
      if (task?.kind === 'health_check') break
      if (task?.kind === 'digest') count += 1
    }
    return count
  }

  async submit(input: CuratorTaskInput): Promise<CuratorTask> {
    return this.exclusive(async () => {
      if (!this.accepting) throw new Error('curator queue is frozen and does not accept new tasks')
      const tracePath = input.tracePath === undefined ? undefined : requireTracePath(input.tracePath)
      if (input.id !== undefined) {
        if (input.id.length === 0) throw new TypeError('task id must not be empty')
        const existing = this.tasks.find(task => task.id === input.id)
        if (existing !== undefined) {
          if (existing.kind !== input.kind
            || existing.sourceWorkerId !== input.sourceWorkerId
            || existing.tracePath !== tracePath
            || JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(input.metadata ?? {})) {
            throw new Error(`curator task id conflicts with a different task: ${input.id}`)
          }
          return taskCopy(existing)
        }
      }
      if (input.metadata !== undefined
        && Object.values(input.metadata).some(value => typeof value !== 'string'
          && typeof value !== 'number' && typeof value !== 'boolean')) {
        throw new TypeError('curator task metadata values must be strings, numbers, or booleans')
      }
      const task: CuratorTask = {
        version: STATE_VERSION,
        id: input.id ?? this.generateId(),
        kind: input.kind,
        createdAt: this.now().toISOString(),
        ...(input.sourceWorkerId === undefined ? {} : { sourceWorkerId: input.sourceWorkerId }),
        ...(tracePath === undefined ? {} : { tracePath }),
        ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        status: 'pending',
        attempts: 0,
      }
      this.tasks.push(task)
      if (task.kind === 'digest' && this.digestCountSinceHealthCheck() >= HEALTH_CHECK_INTERVAL) {
        this.tasks.push({
          version: STATE_VERSION,
          id: this.generateId('curator-health'),
          kind: 'health_check',
          createdAt: this.now().toISOString(),
          status: 'pending',
          attempts: 0,
        })
      }
      await this.persist()
      this.wakeConsumer()
      return taskCopy(task)
    })
  }

  private acquireNext(): Promise<NextAction> {
    return this.exclusive(async () => {
      if (this.timedOut) return { kind: 'stop' }
      const index = this.tasks.findIndex(task => task.status === 'pending')
      if (index >= 0) {
        const pending = this.tasks[index]
        if (pending === undefined) throw new Error('curator queue index disappeared')
        const active: CuratorTask = {
          ...pending,
          status: 'active',
          attempts: pending.attempts + 1,
          ...(pending.lastError === undefined ? {} : { lastError: pending.lastError }),
        }
        this.tasks[index] = active
        await this.persist()
        const dispatch: DispatchToken = {
          kind: 'task',
          task: taskCopy(active),
          controller: new AbortController(),
          generation: Symbol(active.id),
        }
        this.activeDispatch = dispatch
        return dispatch
      }
      this.notifyIdleIfNeeded()
      if (!this.accepting) return { kind: 'stop' }
      let wake: (() => void) | undefined
      const promise = new Promise<void>(resolve => { wake = resolve })
      this.waiter = wake
      return { kind: 'wait', promise }
    })
  }

  private async settle(dispatch: DispatchToken, failure?: unknown): Promise<void> {
    await this.exclusive(async () => {
      if (this.timedOut || this.activeDispatch?.generation !== dispatch.generation) return
      const index = this.tasks.findIndex(task => task.id === dispatch.task.id)
      const active = this.tasks[index]
      if (index < 0 || active === undefined || active.status !== 'active') {
        throw new Error(`active curator task disappeared: ${dispatch.task.id}`)
      }
      this.tasks[index] = failure === undefined
        ? {
            ...active,
            status: 'completed',
          }
        : {
            ...active,
            status: 'failed',
            lastError: errorMessage(failure),
          }
      this.activeDispatch = undefined
      await this.persist()
      this.notifyIdleIfNeeded()
    })
  }

  private async consume(): Promise<void> {
    for (;;) {
      const action = await this.acquireNext()
      if (action.kind === 'stop') return
      if (action.kind === 'wait') {
        await action.promise
        continue
      }
      let failure: unknown
      try {
        if (action.task.tracePath !== undefined) {
          await validateTraceArtifact(this.workspaceRoot, action.task.tracePath)
        }
        const tools = await createCuratorKnowledgeTools(this.workspaceRoot, action.task.kind, action.task.id)
        await this.runner({ task: taskCopy(action.task), tools, signal: action.controller.signal })
        await tools.finalizeMetadata()
      } catch (error) {
        failure = error
      }
      await this.settle(action, failure)
      if (failure !== undefined) {
        try {
          this.onTaskFailure(taskCopy(action.task), failure)
        } catch {
          // A diagnostic callback must not stop the durable FIFO consumer.
        }
      }
      if (this.timedOut) return
    }
  }

  /** Return a detached immutable view in durable FIFO order. */
  snapshot(): Promise<readonly CuratorTask[]> {
    return this.exclusive(() => this.tasks.map(taskCopy))
  }

  /** Wait until the current queue has neither pending nor active work. */
  async waitForIdle(): Promise<void> {
    const wait = await this.exclusive(() => {
      if (!this.tasks.some(task => task.status === 'pending' || task.status === 'active')) return undefined
      let wake: (() => void) | undefined
      const promise = new Promise<void>(resolve => { wake = resolve })
      if (wake !== undefined) this.idleWaiters.add(wake)
      // Wrap the promise so the serialization chain is not held while waiting
      // for the consumer, which itself must acquire that chain to settle.
      return { promise }
    })
    await wait?.promise
  }

  /** Freeze submissions immediately, then drain FIFO work for at most the configured bound. */
  stop(options: { readonly timeoutMs?: number } = {}): Promise<CuratorStopResult> {
    this.stopPromise ??= this.stopOnce(options.timeoutMs ?? this.drainTimeoutMs)
    return this.stopPromise
  }

  private async stopOnce(timeoutMs: number): Promise<CuratorStopResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative safe integer')
    await this.exclusive(() => {
      this.accepting = false
      this.wakeConsumer()
    })
    const timeout = timeoutPromise(timeoutMs)
    const drained = await Promise.race([
      this.loopPromise.then(() => true),
      timeout.promise.then(() => false),
    ])
    timeout.cancel()
    if (!drained) {
      this.timedOut = true
      this.activeDispatch?.controller.abort(new Error('curator drain timeout expired'))
      await this.exclusive(async () => {
        const activeId = this.activeDispatch?.task.id
        if (activeId !== undefined) {
          const index = this.tasks.findIndex(task => task.id === activeId)
          const active = this.tasks[index]
          if (index >= 0 && active?.status === 'active') {
            this.tasks[index] = { ...active, status: 'pending' }
          }
        }
        this.activeDispatch = undefined
        await this.persist()
        this.notifyIdleIfNeeded()
        this.wakeConsumer()
      })
    }
    const tasks = await this.snapshot()
    return {
      drained,
      pending: tasks.filter(task => task.status === 'pending').length,
      active: tasks.filter(task => task.status === 'active').length,
      failed: tasks.filter(task => task.status === 'failed').length,
    }
  }
}

/** Strict read-only recovery probe used before terminal-session teardown. */
export async function hasRecoverableCuratorTasks(workspace: string): Promise<boolean> {
  const workspaceRoot = await canonicalWorkspace(workspace)
  let curatorDirectory: string
  try {
    curatorDirectory = await resolveWorkspacePath(workspaceRoot, '.alphasolve/curator', { mustExist: true })
  } catch (error) {
    if (error instanceof WorkspaceError && error.message.startsWith('required path does not exist')) return false
    throw error
  }
  const canonicalDirectory = await realpath(curatorDirectory)
  if (canonicalDirectory !== path.join(workspaceRoot, '.alphasolve', 'curator')
    || !isContained(workspaceRoot, canonicalDirectory) || !(await lstat(canonicalDirectory)).isDirectory()) {
    throw new WorkspaceError('curator state directory escapes workspace', '.alphasolve/curator')
  }
  const queuePath = path.join(canonicalDirectory, 'queue.json')
  const queue = await readQueueFromCanonicalDirectory(workspaceRoot, canonicalDirectory, queuePath)
  return queue?.tasks.some(task => task.status === 'pending' || task.status === 'active') ?? false
}
