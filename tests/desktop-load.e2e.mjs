#!/usr/bin/env node

/** Load the built plugin against an installed Windows desktop's real host libraries. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

if (process.platform !== 'win32') throw new Error('This smoke supports an installed Windows desktop.')
const desktopDirectory = process.argv[2]
if (desktopDirectory === undefined) throw new Error('Usage: pnpm run test:desktop-load <desktop-install-directory>')
const desktopRoot = path.resolve(desktopDirectory)
const executable = path.join(desktopRoot, 'DeepSeek Harness.exe')
const fuseWire = await getCurrentFuseWire(executable)
// Electron encodes FuseState.ENABLE as the ASCII byte for "1".
assert.equal(fuseWire[FuseV1Options.RunAsNode], 49, 'Desktop must enable RunAsNode; refusing to launch its GUI')

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const pluginUrl = pathToFileURL(path.join(packageRoot, 'lib', 'index.js')).href
const pluginPythonUrl = pathToFileURL(createRequire(path.join(packageRoot, 'package.json')).resolve(pluginManifest.name + '/python')).href
const pythonExecutable = process.env.ALPHASOLVE_TEST_PYTHON?.trim() || path.join(
  path.resolve(process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')),
  'runtimes', 'alphasolve-python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
assert.ok(path.isAbsolute(pythonExecutable), 'ALPHASOLVE_TEST_PYTHON must name an absolute dedicated Python executable')
const hostRoot = path.join(desktopRoot, 'resources', 'app.asar', 'dsh')
const timeoutMs = 120_000
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-desktop-load-'))
try {
  const home = path.join(temporaryRoot, 'home')
  await mkdir(home)
  const probe = path.join(temporaryRoot, 'probe.mjs')
  await writeFile(probe, `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const hostRoot = ${JSON.stringify(hostRoot)}
const expectedPeers = ${JSON.stringify(pluginManifest.peerDependencies)}
for (const [name, version] of Object.entries(expectedPeers)) {
  const manifest = JSON.parse(await readFile(path.join(hostRoot, 'node_modules', name, 'package.json'), 'utf8'))
  assert.equal(manifest.version, version, name + ' does not match the supported desktop version')
}
const hostBase = pathToFileURL(path.join(hostRoot, 'probe.mjs')).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod') {
      return nextResolve(specifier, { ...context, parentURL: hostBase })
    }
    return nextResolve(specifier, context)
  },
})
try {
  const [{ Context }, { default: AgentRegistry }, { default: SystemPrompt }, { default: ToolRuntime }, { default: SessionProjectionRegistry }, { default: Loader }, { default: ClientModuleRegistry }, { default: LocalSubprocess }, { default: LocalSandbox }, { PythonSession, resolvePythonOptions }, plugin] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-agent'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/cordis-plugin-loader'),
    import('@deepseek-ai/dsh-client-modules'),
    import('@deepseek-ai/dsh-subprocess-local'),
    import('@deepseek-ai/dsh-sandbox-local'),
    import(${JSON.stringify(pluginPythonUrl)}),
    import(${JSON.stringify(pluginUrl)}),
  ])
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(LocalSandbox)
    await ctx.plugin(Loader, { baseUrl: ${JSON.stringify(pathToFileURL(packageRoot + path.sep).href)} })
    const before = await ctx.systemPrompt.assemble()
    const id = await ctx.loader.create({ name: ${JSON.stringify(pluginUrl)} })
    await ctx.loader.await()
    assert.equal(ctx.loader.resolve(id).fiber?.state, 2, 'Desktop Loader did not activate AlphaSolve')
    assert.deepEqual(ctx.tools.schemas(), [], 'Dormant AlphaSolve must not expose global tools')
    assert.deepEqual(await ctx.systemPrompt.assemble(), before, 'Dormant AlphaSolve must not change the global prompt')
    assert.equal(plugin.name, 'dsh-alphasolve')
    await ctx.plugin(ClientModuleRegistry)
    const clientEntry = ctx.clientModules.graph().entries.find(entry => entry.id === ${JSON.stringify(pluginManifest.name)})
    assert.ok(clientEntry, 'Desktop must discover the AlphaSolve client declaration from the active loader entry')
    assert.equal(ctx.clientModules.clientPath(clientEntry.id), ${JSON.stringify(path.join(packageRoot, 'lib', 'client.js'))})
    const clientResponse = await ctx.clientModules.fetchBundle(new Request(new URL(clientEntry.url, 'http://desktop.test/')))
    assert.equal(clientResponse.status, 200, 'Desktop must serve the advertised client bundle')
    const registrations = []
    runInNewContext(await clientResponse.text(), {
      window: { __ModuleLoader__: { load(registration) { registrations.push(registration) } } },
    }, { timeout: 1000 })
    assert.equal(registrations.length, 1, 'Client artifact must register one lazy module factory')
    assert.equal(registrations[0].id, clientEntry.id)
    assert.equal(typeof registrations[0].factory, 'function')
    const pythonOptions = resolvePythonOptions({ executable: ${JSON.stringify(pythonExecutable)}, timeoutMs: 30_000 })
    const python = new PythonSession(ctx.subprocess, ctx.sandbox, pythonOptions)
    const independent = new PythonSession(ctx.subprocess, ctx.sandbox, pythonOptions)
    const pythonSignal = new AbortController().signal
    try {
      const factorization = await python.execute(["x = sp.symbols('x')", "sp.factor(x**4 - 1)"].join('\\n'), pythonSignal)
      assert.equal(factorization.result, '(x - 1)*(x + 1)*(x**2 + 1)')
      assert.equal(factorization.sympyVersion, '1.14.0')
      assert.equal(factorization.truncated, false)
      const retained = await python.execute('sp.expand((x + 1)**3)', pythonSignal)
      assert.equal(retained.result, 'x**3 + 3*x**2 + 3*x + 1', 'Python variables must survive between calls')
      await assert.rejects(independent.execute('x', pythonSignal), /NameError/, 'Python helpers must not share variables')
      const recovered = await independent.execute('sp.Rational(1, 3) + sp.Rational(1, 6)', pythonSignal)
      assert.equal(recovered.result, '1/2', 'Ordinary Python errors must leave the interpreter usable')
      console.log('python-sympy-smoke-ok; SymPy ' + factorization.sympyVersion)
    } finally {
      await Promise.all([python.dispose(), independent.dispose()])
    }
    console.log('desktop-client-discovery-ok')
    console.log('desktop-host-load-ok; Node ' + process.versions.node + '; Electron ' + process.versions.electron)
  } finally {
    await ctx.fiber.dispose()
  }
} finally {
  hooks.deregister()
}
`)
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/key|secret|token|password|auth/i.test(key)
      || /^(?:home|userprofile|appdata|localappdata|dsh_home|node_options|node_path|cordis_shared)$/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(home, '.dsh'),
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
  })
  const child = spawn(executable, [probe], { cwd: temporaryRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(timedOut, false, 'Desktop load exceeded ' + timeoutMs + ' ms\n' + output)
    assert.equal(result.signal, null, 'Desktop load terminated by ' + String(result.signal) + '\n' + output)
    assert.equal(result.code, 0, output)
    process.stdout.write(output)
  } finally {
    clearTimeout(timer)
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
