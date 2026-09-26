/** Persistent mathematical Python sessions owned by individual AlphaSolve helpers. */
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Native tool exposed only to AlphaSolve computation helpers. */
export const PYTHON_TOOL_NAME = 'alphasolve_python'

/** Deployment-owned Python limits; model calls supply only code. */
export interface PythonOptions {
  readonly executable: string
  readonly timeoutMs: number
  readonly maxOutputChars: number
  readonly maxCodeChars: number
  readonly graceMs: number
}

/** Optional deployment overrides resolved before a helper starts. */
export type PythonConfig = Partial<PythonOptions>

/**
 * Resolve the dedicated venv and validate every configured execution limit.
 * @param input Deployment overrides; omission selects the managed Python environment.
 * @returns Fully specified executable and bounded execution limits.
 */
export function resolvePythonOptions(input: PythonConfig = {}): PythonOptions {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  const options = {
    executable: path.join(home, 'runtimes', 'alphasolve-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    timeoutMs: 300_000, maxOutputChars: 65_536, maxCodeChars: 200_000, graceMs: 1_000,
    ...input,
  }
  if (typeof options.executable !== 'string' || options.executable.trim().length === 0) throw new TypeError('python.executable must be a non-empty executable path or PATH name')
  for (const name of ['timeoutMs', 'maxOutputChars', 'maxCodeChars', 'graceMs'] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1 || options[name] > 2_147_483_647) throw new TypeError(`python.${name} must be a positive integer at most 2147483647`)
  }
  if (options.maxOutputChars < 1024) throw new TypeError('python.maxOutputChars must be at least 1024')
  return Object.freeze(options)
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

interface PythonReply {
  readonly type: 'result'
  readonly id: number
  readonly stdout: string
  readonly stderr: string
  readonly result: string
  readonly error: string | null
  readonly truncated: boolean
}

interface Kernel {
  readonly directory: string
  readonly handle: SubprocessHandle
  readonly ready: Deferred<string>
  readonly lifetime: AbortController
  buffer: string
  bytes: number
  version?: string
  pending?: { id: number; result: Deferred<PythonReply> }
  failure?: Error
  stopping?: Promise<void>
}

/** Canonical text produced by one Python call; values remain inside the interpreter. */
export interface PythonResult {
  readonly stdout: string
  readonly stderr: string
  readonly result: string
  readonly truncated: boolean
  readonly sympyVersion: string
}

class PythonCodeError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Python protocol expected an object')
  return value as Record<string, unknown>
}

function codeArgument(raw: unknown, maxChars: number): string {
  const args = object(raw)
  if (Object.keys(args).some(key => key !== 'code') || typeof args.code !== 'string' || !args.code.trim()) throw new TypeError('alphasolve_python requires one non-empty code string')
  if (args.code.length > maxChars) throw new TypeError(`Python code exceeds ${maxChars} characters; split the calculation across calls`)
  return args.code
}

function childEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive']) {
    const key = Object.keys(process.env).find(candidate => candidate.toLowerCase() === name.toLowerCase())
    if (key !== undefined) env[key] = process.env[key]
  }
  // The Windows sandbox runner uses the host executable in Electron Node mode.
  if (process.versions.electron !== undefined) env.ELECTRON_RUN_AS_NODE = '1'
  return { ...env, TEMP: directory, TMP: directory, TMPDIR: directory }
}

/** One process and namespace per helper; cancellation and disposal await process-range exit. */
export class PythonSession {
  private current: Kernel | undefined
  private closed = false
  private busy = false
  private nextId = 0
  private active: Promise<PythonResult> | undefined
  private abortActive: AbortController | undefined
  private disposing: Promise<void> | undefined

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly sandbox: SandboxProvider,
    private readonly options: PythonOptions,
  ) {}

  private fail(kernel: Kernel, error: Error): void {
    kernel.failure ??= error
    kernel.ready.reject(error)
    kernel.pending?.result.reject(error)
    kernel.lifetime.abort(error)
  }

  private receive(kernel: Kernel, text: string): void {
    if (kernel.failure !== undefined) return
    kernel.buffer += text
    kernel.bytes += Buffer.byteLength(text)
    const frameLimit = this.options.maxOutputChars * 12 + 4096
    if (kernel.bytes > frameLimit) { this.fail(kernel, new Error('Python response exceeded its protocol limit')); return }
    while (kernel.buffer.includes('\n')) {
      const end = kernel.buffer.indexOf('\n')
      const line = kernel.buffer.slice(0, end)
      kernel.buffer = kernel.buffer.slice(end + 1)
      kernel.bytes = Buffer.byteLength(kernel.buffer)
      try {
        const value = object(JSON.parse(line))
        const pending = kernel.pending
        if (value.type === 'ready' && kernel.version === undefined && typeof value.sympyVersion === 'string') {
          kernel.version = value.sympyVersion
          kernel.ready.resolve(value.sympyVersion)
        } else if (value.type === 'result' && pending !== undefined && value.id === pending.id
          && typeof value.stdout === 'string' && typeof value.stderr === 'string' && typeof value.result === 'string'
          && (value.error === null || typeof value.error === 'string') && typeof value.truncated === 'boolean') {
          const reply: PythonReply = { type: 'result', id: pending.id, stdout: value.stdout, stderr: value.stderr, result: value.result, error: value.error, truncated: value.truncated }
          pending.result.resolve(reply)
          delete kernel.pending
        } else throw new Error('Unexpected Python protocol response')
      } catch (error) {
        this.fail(kernel, new Error(`Invalid Python response: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
    }
  }

  private async start(signal: AbortSignal): Promise<Kernel> {
    if (this.current !== undefined) return this.current
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-python-'))
    let kernel: Kernel | undefined
    try {
      signal.throwIfAborted()
      let executable: string
      try { executable = await this.subprocess.resolveExecutable(this.options.executable, {}, signal) } catch (error) {
        throw new Error(`AlphaSolve Python is unavailable. Run node scripts/setup-python.mjs from the plugin directory, or configure python.executable with a SymPy 1.14.0 environment. ${error instanceof Error ? error.message : String(error)}`)
      }
      const bootstrap = fileURLToPath(new URL('../python/kernel.py', import.meta.url))
      const confined = await this.sandbox.confine([executable, '-I', '-B', '-u', '-X', 'utf8', bootstrap, String(this.options.maxOutputChars)], { mode: 'read-only', workspaceRoot: directory }, signal)
      signal.throwIfAborted()
      const lifetime = new AbortController()
      const handle = this.subprocess.spawn({ argv: confined.argv, cwd: directory, env: childEnvironment(directory),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.options.maxOutputChars } }, graceMs: this.options.graceMs, signal: lifetime.signal })
      kernel = { directory, handle, lifetime, ready: deferred<string>(), buffer: '', bytes: 0 }
      this.current = kernel
      const owned = kernel
      void handle.done.then(outcome => {
        const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
        this.fail(owned, new Error(`Python interpreter exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)}). ${stderr}`))
      }, error => this.fail(owned, error instanceof Error ? error : new Error(String(error))))
      if (handle.stdin === undefined || handle.stdout === undefined) throw new Error('Python subprocess did not provide its protocol pipes')
      handle.stdout.setEncoding('utf8')
      handle.stdout.on('data', (chunk: string) => this.receive(owned, chunk))
      handle.stdout.on('error', (error: Error) => this.fail(owned, error))
      handle.stdin.on('error', (error: Error) => this.fail(owned, error))
      return kernel
    } catch (error) {
      if (kernel !== undefined) await this.stop(kernel)
      else await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private stop(kernel: Kernel): Promise<void> {
    if (this.current === kernel) this.current = undefined
    return kernel.stopping ??= (async () => {
      kernel.lifetime.abort(new Error('Python session closed'))
      kernel.handle.terminate()
      await kernel.handle.done.catch(() => undefined)
      await kernel.handle.waitForExit()
      await rm(kernel.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    })()
  }

  /**
   * Run one snippet; ordinary Python exceptions retain variables, infrastructure failures reset them.
   * @param code Python source evaluated in this helper's persistent namespace.
   * @param signal Cancellation ends the interpreter and discards its namespace.
   * @returns Bounded captured text and the final expression; Python errors reject.
   */
  execute(code: string, signal: AbortSignal): Promise<PythonResult> {
    signal.throwIfAborted()
    if (this.closed) return Promise.reject(new Error('Python helper session is disposed'))
    if (this.busy) return Promise.reject(new Error('This Python helper already has a running call; wait for its result'))
    if (!code.trim() || code.length > this.options.maxCodeChars) return Promise.reject(new TypeError('Python code is empty or exceeds the configured limit'))
    this.busy = true
    this.active = this.run(code, signal).finally(() => { this.busy = false; this.active = undefined })
    return this.active
  }

  private async run(code: string, callerSignal: AbortSignal): Promise<PythonResult> {
    const abort = new AbortController()
    this.abortActive = abort
    const signal = AbortSignal.any([callerSignal, abort.signal])
    const timer = setTimeout(() => abort.abort(new Error(`Python call exceeded ${this.options.timeoutMs} ms`)), this.options.timeoutMs)
    timer.unref()
    const cancelled = deferred<never>()
    const onAbort = (): void => cancelled.reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'Python call cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    let kernel: Kernel | undefined
    try {
      kernel = await this.start(signal)
      const version = await Promise.race([kernel.ready.promise, cancelled.promise])
      signal.throwIfAborted()
      if (kernel.failure !== undefined) throw kernel.failure
      const id = ++this.nextId
      const result = deferred<PythonReply>()
      kernel.pending = { id, result }
      const input = kernel.handle.stdin
      if (input === undefined) throw new Error('Python input pipe is unavailable')
      await Promise.race([
        new Promise<void>((resolve, reject) => input.write(JSON.stringify({ id, code }) + '\n', error => error ? reject(error) : resolve())),
        cancelled.promise,
        result.promise.then(() => undefined),
      ])
      const reply = await Promise.race([result.promise, cancelled.promise])
      signal.throwIfAborted()
      if (reply.error !== null) throw new PythonCodeError([reply.stdout, reply.stderr, reply.error, reply.truncated ? '[Output truncated]' : ''].filter(Boolean).join('\n'))
      return { stdout: reply.stdout, stderr: reply.stderr, result: reply.result, truncated: reply.truncated, sympyVersion: version }
    } catch (error) {
      if (error instanceof PythonCodeError) throw error
      if (kernel !== undefined) await this.stop(kernel)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPython session reset; previous variables are lost. Recreate imports and definitions before retrying.`)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (this.abortActive === abort) this.abortActive = undefined
    }
  }

  /**
   * Close idle or running Python and wait for its process and temporary directory cleanup.
   * @returns A shared promise that settles after cleanup.
   */
  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true
      this.abortActive?.abort(new Error('Python helper session disposed'))
      await this.active?.catch(() => undefined)
      if (this.current !== undefined) await this.stop(this.current)
    })()
  }
}

/**
 * Register Python only in the caller's helper scope; the returned disposer owns its interpreter.
 * @param ctx Helper context with Harness tool, subprocess, and sandbox services.
 * @param options Fully resolved deployment limits.
 * @returns Disposer that unregisters the tool and joins its interpreter.
 */
export function installPythonTool(ctx: Context, options: PythonOptions): () => Promise<void> {
  const subprocess = ctx.get('subprocess')
  const sandbox = ctx.get('sandbox')
  if (subprocess === undefined || sandbox === undefined) throw new Error('AlphaSolve Python requires Harness subprocess and sandbox services')
  const session = new PythonSession(subprocess, sandbox, options)
  const tool: ToolDefinition = {
    name: PYTHON_TOOL_NAME,
    description: 'Run Python with SymPy for symbolic and numerical mathematics. Variables persist within this helper; other helpers have separate interpreters. Returns stdout, stderr, and the last expression. Read project inputs with the file tools.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', maxLength: options.maxCodeChars, description: `Python code; SymPy is available as sp, or import sympy. Assignments, loops, functions, matrices and exact arithmetic are supported. Use sp.Rational for exact fractions. Each call has ${options.timeoutMs} ms including startup; output is capped at ${options.maxOutputChars} characters. After a reported session reset, recreate imports and variables. Filesystem writes, project-file reads, network, and subprocesses are unavailable.` },
    }, required: ['code'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      stdout: { type: 'string' }, stderr: { type: 'string' }, result: { type: 'string' }, truncated: { type: 'boolean' }, sympyVersion: { type: 'string' },
    }, required: ['stdout', 'stderr', 'result', 'truncated', 'sympyVersion'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    execute: (args, exec) => session.execute(codeArgument(args, options.maxCodeChars), exec.signal),
  }
  const unregister = ctx.tools.register(tool)
  return async () => { unregister(); await session.dispose() }
}
