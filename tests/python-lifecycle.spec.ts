import { access } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'

import { Context } from '@deepseek-ai/cordis'
import SandboxProvider, { type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, {
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installPythonTool, PythonSession, resolvePythonOptions } from '../src/python-runtime.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

interface Request { id: number; code: string }

class ProtocolProcess implements SubprocessHandle {
  readonly stdout = new Readable({ read() {} })
  readonly stderr = undefined
  readonly control = undefined
  readonly collected = {}
  readonly request = deferred<Request>()
  readonly rangeWaitStarted = deferred<void>()
  private readonly outcome = deferred<SubprocessOutcome>()
  private readonly rangeExit = deferred<boolean>()
  readonly done = this.outcome.promise
  blockRangeExit = false
  private ended = false
  private readonly onAbort = (): void => this.exit({ exitCode: null, signal: 'SIGTERM' })
  readonly stdin = new Writable({
    // A writable can accept data while never acknowledging its callback.
    write: (chunk: Buffer, _encoding, _callback): void => {
      const request: Request = JSON.parse(chunk.toString('utf8'))
      this.request.resolve(request)
    },
  })

  constructor(readonly spec: SubprocessSpawnSpec) {
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  send(value: object): void { this.stdout.push(JSON.stringify(value) + '\n') }
  sendRaw(value: string): void { this.stdout.push(value) }
  ready(): void { this.send({ type: 'ready', sympyVersion: '1.14.0' }) }

  exit(outcome: SubprocessOutcome): void {
    if (this.ended) return
    this.ended = true
    this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.stdin.destroy()
    this.stdout.push(null)
    this.outcome.resolve(outcome)
    if (!this.blockRangeExit) this.rangeExit.resolve(true)
  }

  releaseRange(): void { this.rangeExit.resolve(true) }
  readonly terminate = vi.fn((): void => this.exit({ exitCode: null, signal: 'SIGTERM' }))
  readonly waitForExit = vi.fn(async (): Promise<boolean> => {
    this.rangeWaitStarted.resolve()
    return this.rangeExit.promise
  })
}

class ProtocolSubprocess extends SubprocessRuntime {
  readonly processes: ProtocolProcess[] = []
  private readonly waiting: Array<ReturnType<typeof deferred<ProtocolProcess>>> = []
  private readonly unclaimed: ProtocolProcess[] = []

  override async resolveExecutable(command: string): Promise<string> { return command }
  override terminalEnvironment(): never { throw new Error('No terminal requested') }
  override spawnTerminal(): never { throw new Error('No terminal requested') }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = new ProtocolProcess(spec)
    this.processes.push(child)
    const waiter = this.waiting.shift()
    if (waiter === undefined) this.unclaimed.push(child)
    else waiter.resolve(child)
    return child
  }

  nextProcess(): Promise<ProtocolProcess> {
    const child = this.unclaimed.shift()
    if (child !== undefined) return Promise.resolve(child)
    const waiter = deferred<ProtocolProcess>()
    this.waiting.push(waiter)
    return waiter.promise
  }
}

class ProtocolSandbox extends SandboxProvider {
  readonly policies: SandboxPolicy[] = []
  override async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    this.policies.push(policy)
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

const contexts: Context[] = []
const sessions: PythonSession[] = []
const subprocesses: ProtocolSubprocess[] = []

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ProtocolSubprocess)
  await ctx.plugin(ProtocolSandbox)
  const subprocess = ctx.subprocess
  if (!(subprocess instanceof ProtocolSubprocess)) throw new Error('Missing protocol fixture')
  subprocesses.push(subprocess)
  const session = new PythonSession(subprocess, ctx.sandbox, resolvePythonOptions({
    executable: 'fixture-python', timeoutMs: 10_000, maxOutputChars: 1024,
  }))
  sessions.push(session)
  return { ctx, subprocess, session }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const subprocess of subprocesses.splice(0)) {
    for (const child of subprocess.processes) child.releaseRange()
  }
  await Promise.all(sessions.splice(0).map(session => session.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function recover(session: PythonSession, subprocess: ProtocolSubprocess): Promise<void> {
  const execution = session.execute('sp.factor(sp.Symbol("x")**2 - 1)', new AbortController().signal)
  const child = await subprocess.nextProcess()
  child.ready()
  const request = await child.request.promise
  child.send({ type: 'result', id: request.id, stdout: '', stderr: '', result: '(x - 1)*(x + 1)', error: null, truncated: false })
  await expect(execution).resolves.toMatchObject({ result: '(x - 1)*(x + 1)', sympyVersion: '1.14.0' })
}

describe('Python process ownership', () => {
  it.each(['timeout', 'dispose', 'cancel'] as const)('settles %s while stdin acknowledgement is blocked and awaits the process range', async kind => {
    if (kind === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { session, subprocess } = await fixture()
    const abort = new AbortController()
    const execution = session.execute('while True: pass', abort.signal)
    const failed = expect(execution).rejects.toThrow(/Python session reset/)
    const child = await subprocess.nextProcess()
    child.ready()
    await child.request.promise
    child.blockRangeExit = true
    let settled = false
    void execution.then(() => { settled = true }, () => { settled = true })
    let disposal: Promise<void> | undefined

    if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_001)
    else if (kind === 'dispose') disposal = session.dispose()
    else abort.abort(new Error('fixture cancellation'))

    await child.done
    await child.rangeWaitStarted.promise
    expect(settled).toBe(false)
    expect(child.terminate).toHaveBeenCalledOnce()
    child.releaseRange()
    await failed
    await disposal
    expect(child.waitForExit).toHaveBeenCalledOnce()
    await expect(access(child.spec.cwd)).rejects.toMatchObject({ code: 'ENOENT' })

    if (kind === 'dispose') {
      await expect(session.execute('1', new AbortController().signal)).rejects.toThrow(/disposed/)
      await session.dispose()
      expect(subprocess.processes).toHaveLength(1)
    } else {
      await recover(session, subprocess)
      expect(subprocess.processes).toHaveLength(2)
    }
  })

  it.each([
    ['invalid JSON', 'not-json\n', /Invalid Python response/],
    ['wrong result fields', '{"type":"result","id":1,"stdout":7}\n', /Invalid Python response/],
    ['oversized frame', 'x'.repeat(1024 * 12 + 4097), /protocol limit/],
  ] as const)('resets after %s even when the request write callback never returns', async (_label, payload, message) => {
    const { session, subprocess } = await fixture()
    const execution = session.execute('1 + 1', new AbortController().signal)
    const failed = expect(execution).rejects.toThrow(message)
    const child = await subprocess.nextProcess()
    child.ready()
    await child.request.promise
    child.sendRaw(payload)
    await failed
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
    await expect(access(child.spec.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    await recover(session, subprocess)
    expect(subprocess.processes).toHaveLength(2)
  })

  it('reports interpreter exit and creates a fresh process for a later call', async () => {
    const { session, subprocess } = await fixture()
    const execution = session.execute('1 + 1', new AbortController().signal)
    const failed = expect(execution).rejects.toThrow(/interpreter exited \(code 9.*Python session reset/s)
    const child = await subprocess.nextProcess()
    child.ready()
    await child.request.promise
    child.exit({ exitCode: 9, signal: null })
    await failed
    expect(child.waitForExit).toHaveBeenCalledOnce()
    await recover(session, subprocess)
    expect(subprocess.processes).toHaveLength(2)
  })

  it('rejects pre-aborted execution before allocating a subprocess', async () => {
    const { session, subprocess } = await fixture()
    const reason = new Error('already cancelled')
    const signal = AbortSignal.abort(reason)
    expect(() => session.execute('1 + 1', signal)).toThrow(reason)
    expect(subprocess.processes).toHaveLength(0)
  })

  it('refuses tool setup without a sandbox before launching Python', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ProtocolSubprocess)
    const subprocess = ctx.subprocess
    if (!(subprocess instanceof ProtocolSubprocess)) throw new Error('Missing protocol fixture')
    expect(() => installPythonTool(ctx, resolvePythonOptions())).toThrow(/requires Harness subprocess and sandbox services/)
    expect(subprocess.processes).toHaveLength(0)
  })
})
