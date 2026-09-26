import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const kernelPath = fileURLToPath(new URL('../python/kernel.py', import.meta.url))
const setupPath = fileURLToPath(new URL('../scripts/setup-python.mjs', import.meta.url))
const runtimeRoot = path.join(path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')), 'runtimes', 'alphasolve-python')
const python = process.env.ALPHASOLVE_TEST_PYTHON ?? path.join(runtimeRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const probe = spawnSync(python, ['-I', '-B', '-c', 'import sys,sympy,mpmath; assert sys.version_info >= (3,10); assert sys.prefix != sys.base_prefix; assert sympy.__version__ == "1.14.0" and mpmath.__version__ == "1.3.0"; print(sys.executable)'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
const hasPython = probe.status === 0 && probe.signal === null && !probe.error

type Response = {
  type: 'result'
  id: number
  stdout: string
  stderr: string
  result: string
  error: string | null
  truncated: boolean
}

// Each call owns one interpreter and waits for close, including deadline termination.
function run(command: string, args: string[], input = '', env = process.env) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, 30_000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.stdin.on('error', () => { /* Startup rejection can close stdin before a request is written. */ })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, timedOut, stdout, stderr }) })
    child.stdin.end(input)
  })
}

async function requests(codes: string[], maxOutputChars = 10_000): Promise<Response[]> {
  const outcome = await run(python, ['-I', '-B', '-u', '-X', 'utf8', kernelPath, String(maxOutputChars)], codes.map((code, id) => JSON.stringify({ id, code })).join('\n') + '\n')
  expect(outcome.timedOut).toBe(false)
  expect(outcome.signal).toBeNull()
  expect(outcome.code, outcome.stderr).toBe(0)
  const records = outcome.stdout.trim().split('\n').map(line => JSON.parse(line))
  expect(records[0]).toEqual({ type: 'ready', sympyVersion: '1.14.0' })
  expect(records.length).toBe(codes.length + 1)
  return records.slice(1)
}

describe.skipIf(!hasPython)('persistent Python kernel with pinned SymPy', () => {
  it('supports symbolic computation, functions, loops, and persistent variables', async () => {
    const result = await requests([
      "import sympy as sp\nx = sp.symbols('x')\nsp.integrate(sp.sin(x), x)",
      'sp.factor(x**4 - 1)',
      'sp.solve(x**2 - 2, x)',
      'sp.Matrix([[1, 2], [3, 4]]).det()',
      'def triangular(n):\n    total = 0\n    for value in range(n + 1):\n        total += value\n    return total\ntriangular(10)',
      "sp.lambdify(x, sp.sin(x), 'math')(0)",
    ])
    expect(result.map(item => item.error)).toEqual(Array(6).fill(null))
    expect(result.map(item => item.result)).toEqual(['-cos(x)', '(x - 1)*(x + 1)*(x**2 + 1)', '[-sqrt(2), sqrt(2)]', '-2', '55', '0.0'])
  }, 60_000)

  it('supports ordinary Python classes for mathematical helpers', async () => {
    const result = await requests(['class Affine:\n    def __init__(self, slope, intercept):\n        self.slope = slope\n        self.intercept = intercept\n    def at(self, x):\n        return self.slope*x + self.intercept\nf = Affine(2, 3)\nf.at(5)'])
    expect(result[0]!.result).toBe('13')
    expect(result[0]!.error).toBeNull()
  }, 60_000)

  it('reports Python failures and preserves variables across subsequent requests', async () => {
    const result = await requests(['kept = 41\n1/0', 'broken =', 'raise SystemExit(7)', 'kept + 1'])
    expect(result[0]!.error).toContain('ZeroDivisionError')
    expect(result[1]!.error).toContain('SyntaxError')
    expect(result[2]!.error).toContain('SystemExit: 7')
    expect(result[3]!.result).toBe('42')
    expect(result[3]!.error).toBeNull()
  }, 60_000)

  it('keeps independent interpreter namespaces', async () => {
    const [first, second] = await Promise.all([requests(['private_value = 17\nprivate_value']), requests(['private_value'])])
    expect(first[0]!.result).toBe('17')
    expect(second[0]!.error).toContain('NameError')
  }, 60_000)

  it('bounds combined output and retains the error after excessive printing', async () => {
    const result = await requests(["print('a' * 100000)\n1/0", "'b' * 100000"], 128)
    expect(result[0]!.error).toContain('ZeroDivisionError')
    expect(result[0]!.truncated).toBe(true)
    expect(result[1]!.truncated).toBe(true)
    for (const item of result) {
      expect(item.stdout.length + item.stderr.length + item.result.length + (item.error?.length ?? 0)).toBeLessThanOrEqual(128)
    }
  }, 60_000)

  it('rejects unsafe imports and private reflection while permitting supported modules', async () => {
    const result = await requests(['import os', 'x = sp\nx.__dict__', 'from sympy import __builtins__', 'from fractions import Fraction\nFraction(1, 3) + Fraction(1, 6)'])
    expect(result.slice(0, 3).every(item => item.error?.includes('PermissionError'))).toBe(true)
    expect(result[3]!.result).toBe('Fraction(1, 2)')
  }, 60_000)

  it('denies indirect file access and process operations without modifying host files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'alphasolve-python-policy-'))
    try {
      const privateFile = path.join(root, 'private.txt')
      const writeFilePath = path.join(root, 'write.txt')
      await writeFile(privateFile, 'private-content')
      await writeFile(writeFilePath, 'unchanged')
      const expressions = [
        `__import__('builtins').open(${JSON.stringify(privateFile)}).read()`,
        `__import__('builtins').open(${JSON.stringify(writeFilePath)}, 'w')`,
        "__import__('socket').socket()",
        "__import__('os').system('echo forbidden')",
      ]
      const result = await requests(expressions.map(expression => `sp.sympify(${JSON.stringify(expression)})`))
      expect(result.every(item => item.error?.includes('PermissionError'))).toBe(true)
      expect(result.every(item => !JSON.stringify(item).includes('private-content'))).toBe(true)
      expect(await readFile(writeFilePath, 'utf8')).toBe('unchanged')
      expect(await readFile(privateFile, 'utf8')).toBe('private-content')
    } finally {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('alphasolve-python-')) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses to replace a directory that is not a dedicated virtual environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'alphasolve-python-setup-'))
    try {
      const target = path.join(root, 'runtimes', 'alphasolve-python')
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'sentinel'), 'unchanged')
      const outcome = await run(process.execPath, [setupPath, '--python', probe.stdout.trim()], '', { ...process.env, DSH_HOME: root })
      expect(outcome.timedOut).toBe(false)
      expect(outcome.signal).toBeNull()
      expect(outcome.code).toBe(1)
      expect(outcome.stderr).toContain('AlphaSolve Python setup failed')
      expect(await readFile(path.join(target, 'sentinel'), 'utf8')).toBe('unchanged')
    } finally {
      if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('alphasolve-python-')) throw new Error('Unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
