#!/usr/bin/env node

/** Load the built plugin against an installed Windows desktop's real host libraries. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
const hostRoot = path.join(desktopRoot, 'resources', 'app.asar', 'dsh')
const timeoutMs = 30_000
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
  const [{ Context }, { default: AgentRegistry }, { default: SystemPrompt }, { default: ToolRuntime }, { default: SessionProjectionRegistry }, { default: Loader }, plugin] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-agent'),
    import('@deepseek-ai/dsh-system-prompt'),
    import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-session-projection'),
    import('@deepseek-ai/cordis-plugin-loader'),
    import(${JSON.stringify(pluginUrl)}),
  ])
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Loader)
    const before = await ctx.systemPrompt.assemble()
    const id = await ctx.loader.create({ name: ${JSON.stringify(pluginUrl)} })
    await ctx.loader.await()
    assert.equal(ctx.loader.resolve(id).fiber?.state, 2, 'Desktop Loader did not activate AlphaSolve')
    assert.deepEqual(ctx.tools.schemas(), [], 'Dormant AlphaSolve must not expose global tools')
    assert.deepEqual(await ctx.systemPrompt.assemble(), before, 'Dormant AlphaSolve must not change the global prompt')
    assert.equal(plugin.name, 'dsh-alphasolve')
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
