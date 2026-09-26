import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { installPythonTool, PythonSession, resolvePythonOptions, type PythonConfig } from '../src/python-runtime.js'

const executable = process.env.ALPHASOLVE_TEST_PYTHON ?? resolvePythonOptions().executable
if (process.env.ALPHASOLVE_TEST_PYTHON && !existsSync(executable)) throw new Error(`Missing configured Python: ${executable}`)
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(config: PythonConfig = {}) {
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalSandboxProvider, {})
  const options = resolvePythonOptions({ executable, timeoutMs: 30_000, ...config })
  const session = new PythonSession(ctx.subprocess, ctx.sandbox, options)
  cleanup.push(() => session.dispose())
  const run = (code: string, signal = new AbortController().signal) => session.execute(code, signal)
  return { ctx, session, options, run }
}

describe.skipIf(!existsSync(executable))('Python through the real Harness subprocess and sandbox', () => {
  it('executes SymPy and preserves helper variables while emitting canonical tool output', async () => {
    const { ctx, options } = await fixture()
    cleanup.push(installPythonTool(ctx, options))
    const call = (code: string, id: string) => ctx.tools.execute({ name: 'alphasolve_python', arguments: { code }, callId: ToolCallId(id), signal: new AbortController().signal })
    const first = await call("x = sp.symbols('x')\nprint('精确计算')\nsp.integrate(x**2, (x, 0, 1))", 'symbolic')
    expect(first.isError, JSON.stringify(first.content)).toBe(false)
    expect(first.content).toMatchInlineSnapshot(`
      [
        {
          "text": "{
        \"stdout\": \"精确计算\\n\",
        \"stderr\": \"\",
        \"result\": \"1/3\",
        \"truncated\": false,
        \"sympyVersion\": \"1.14.0\"
      }",
          "type": "text",
        },
      ]
    `)
    expect((await call('sp.factor(x**4 - 1)', 'persistent')).value).toMatchObject({ result: '(x - 1)*(x + 1)*(x**2 + 1)' })
    expect((await call('sp.Matrix([[1,2],[3,4]]).det()', 'matrix')).value).toMatchObject({ result: '-2' })
    expect((await call('sp.Rational(1, 3) + sp.Rational(1, 6)', 'rational')).value).toMatchObject({ result: '1/2' })
  }, 60_000)

  it('retains prior variables after Python errors but keeps sibling helpers separate', async () => {
    const { run, ctx, options } = await fixture()
    await expect(run('retained = 19\n1 / 0')).rejects.toThrow('ZeroDivisionError')
    await expect(run('raise SystemExit(7)')).rejects.toThrow('SystemExit: 7')
    expect((await run('retained + 1')).result).toBe('20')
    const sibling = new PythonSession(ctx.subprocess, ctx.sandbox, options)
    cleanup.push(() => sibling.dispose())
    await expect(sibling.execute('retained', new AbortController().signal)).rejects.toThrow('NameError')
  }, 60_000)

  it('preserves Unicode output within the combined budget without resetting the namespace', async () => {
    const { run } = await fixture({ maxOutputChars: 1024 })
    const reply = await run("saved = 73\nprint('😀' * 2000)")
    expect([...reply.stdout]).toHaveLength(1024)
    expect(reply.truncated).toBe(true)
    expect((await run('saved')).result).toBe('73')
    await expect(run("print('a' * 2000)\n1/0")).rejects.toThrow('ZeroDivisionError')
  }, 60_000)

  it('denies project reads, file writes, sockets and subprocesses without altering project files', async () => {
    const { run } = await fixture()
    const root = await mkdtemp(path.join(tmpdir(), 'alphasolve-python-canary-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const canary = path.join(root, 'canary.txt')
    await writeFile(canary, 'project-secret')
    for (const expression of [
      `__import__('builtins').open(${JSON.stringify(canary)}).read()`,
      `__import__('builtins').open(${JSON.stringify(canary)}, 'w')`,
      "__import__('socket').socket()",
      "__import__('os').system('echo forbidden')",
    ]) await expect(run(`sp.sympify(${JSON.stringify(expression)})`)).rejects.toThrow('PermissionError')
    expect(await readFile(canary, 'utf8')).toBe('project-secret')
    expect((await run('sp.factorint(60)')).result).toBe('{2: 2, 3: 1, 5: 1}')
  }, 60_000)

  it('cancels a running calculation, resets variables, and can start a fresh interpreter', async () => {
    const { run } = await fixture()
    await run('previous = 42')
    const controller = new AbortController()
    const pending = run('while True:\n    pass', controller.signal)
    const rejected = expect(pending).rejects.toThrow('Python session reset; previous variables are lost')
    controller.abort(new Error('Cancelled by test'))
    await rejected
    await expect(run('previous')).rejects.toThrow('NameError')
    expect((await run('sp.factorial(5)')).result).toBe('120')
  }, 60_000)

  it('joins a running interpreter on disposal and rejects subsequent calls', async () => {
    const { run, session } = await fixture()
    await run('marker = 1')
    const pending = run('while True:\n    pass')
    const rejected = expect(pending).rejects.toThrow('disposed')
    await session.dispose()
    await rejected
    await session.dispose()
    await expect(run('2+2')).rejects.toThrow('disposed')
  }, 60_000)

  it('gives an installation action for a missing runtime', async () => {
    const { run } = await fixture({ executable: path.join(tmpdir(), 'alphasolve-missing-interpreter', 'python.exe') })
    await expect(run('2+2')).rejects.toThrow('Run node scripts/setup-python.mjs')
  })
})
