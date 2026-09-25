#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageRequire = createRequire(import.meta.url)
const timeoutMs = 120_000
const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined || !/[\\/]pnpm\.(?:c?js|mjs)$/.test(pnpmCli)) {
  throw new Error('Run this smoke through pnpm run test:packed so the installed pnpm CLI is available.')
}
const sourceManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))

async function packageDirectory(specifier, from = packageRequire) {
  try {
    return path.dirname(from.resolve(`${specifier}/package.json`))
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
  let directory = path.dirname(from.resolve(specifier))
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
      if (manifest.name === specifier) return directory
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`could not locate package root for ${specifier}`)
    directory = parent
  }
}

function isolatedEnvironment(home) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/key|secret|token|password|auth/i.test(key)
      || /^(?:node_path|node_options|npm_config_(?:userconfig|globalconfig|proxy|https_proxy))$/i.test(key)) {
      delete env[key]
    }
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(home, '.dsh'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_ignore_scripts: 'true',
    COREPACK_ENABLE_NETWORK: '0',
    CI: 'true',
    FORCE_COLOR: '0',
  }
}

async function run(args, options) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const output = Buffer.concat(stdout).toString('utf8')
    const errorOutput = Buffer.concat(stderr).toString('utf8')
    assert.equal(timedOut, false, `subprocess exceeded ${timeoutMs} ms: ${args.join(' ')}\n${output}\n${errorOutput}`)
    assert.equal(signal, null, `subprocess terminated by ${String(signal)}: ${args.join(' ')}`)
    if (code !== 0) {
      throw new Error([
        `${args.join(' ')} failed with exit code ${String(code)}`,
        output,
        errorOutput,
      ].filter(Boolean).join('\n'))
    }
    return { stdout: output, stderr: errorOutput }
  } finally {
    clearTimeout(timer)
  }
}

async function pack(source, destination, env) {
  await run([pnpmCli, 'pack', '--out', destination], { cwd: source, env })
}

// Remove junctions before deleting this test's private directory on Windows.
async function unlinkInstalledLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) await unlink(child)
    else if (entry.isDirectory()) await unlinkInstalledLinks(child)
  }
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-packed-install-'))
try {
  const home = path.join(temporaryRoot, 'home')
  const consumer = path.join(temporaryRoot, 'consumer')
  const artifacts = path.join(consumer, 'artifacts')
  await Promise.all([mkdir(home), mkdir(artifacts, { recursive: true })])
  const env = isolatedEnvironment(home)

  const ownedPackages = new Map()
  async function collectDependencies(dependencies, from) {
    for (const name of Object.keys(dependencies ?? {})) {
      const directory = await packageDirectory(name, from)
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
      if (ownedPackages.has(name)) {
        assert.equal(ownedPackages.get(name).version, manifest.version, `${name} has conflicting runtime versions`)
        continue
      }
      const filename = `${name.replace(/[^a-zA-Z0-9.-]/g, '-')}.tgz`
      ownedPackages.set(name, { directory, version: manifest.version, filename })
      await collectDependencies(manifest.dependencies, createRequire(path.join(directory, 'package.json')))
    }
  }
  await collectDependencies(sourceManifest.dependencies, packageRequire)
  const packing = await Promise.allSettled([
    pack(packageRoot, path.join(artifacts, 'dsh-alphasolve.tgz'), env),
    ...[...ownedPackages.values()].map(pkg => pack(pkg.directory, path.join(artifacts, pkg.filename), env)),
  ])
  const packFailures = packing.filter(result => result.status === 'rejected').map(result => result.reason)
  if (packFailures.length > 0) throw new AggregateError(packFailures, 'Failed to pack runtime dependencies')

  // The plugin and owned dependencies are installed tarballs. Harness peers use
  // the current checkout's real built exports and existing dependency graph.
  const harnessDependencies = {}
  for (const name of [...Object.keys(sourceManifest.peerDependencies), '@deepseek-ai/cordis-plugin-loader']) {
    const directory = await packageDirectory(name)
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    if (sourceManifest.peerDependencies[name] !== undefined) {
      assert.equal(manifest.version, sourceManifest.peerDependencies[name], `${name} must match the supported Harness version`)
    }
    harnessDependencies[name] = `link:${directory.split(path.sep).join('/')}`
  }
  await Promise.all([
    writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
      name: 'dsh-alphasolve-packed-install-probe',
      private: true,
      type: 'module',
      dependencies: {
        [sourceManifest.name]: 'file:./artifacts/dsh-alphasolve.tgz',
        ...harnessDependencies,
      },
    }, null, 2)}\n`),
    writeFile(path.join(consumer, 'pnpm-workspace.yaml'), `${JSON.stringify({
      packages: ['.'],
      nodeLinker: 'isolated',
      autoInstallPeers: false,
      strictPeerDependencies: false,
      storeDir: '.pnpm-store',
      overrides: Object.fromEntries([...ownedPackages].map(([name, pkg]) => [name, `file:./artifacts/${pkg.filename}`])),
    }, null, 2)}\n`),
  ])
  await run([pnpmCli, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile', '--reporter=append-only'], { cwd: consumer, env })

  const probePath = path.join(consumer, 'probe.mjs')
  await writeFile(probePath, `
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '${sourceManifest.name}'

const consumer = ${JSON.stringify(consumer)}
const pluginManifestPath = fileURLToPath(import.meta.resolve('${sourceManifest.name}/package.json'))
const pluginManifest = JSON.parse(await readFile(pluginManifestPath, 'utf8'))
assert.equal(pluginManifest.dependencies?.['@deepseek-ai/schemastery'], ${JSON.stringify(sourceManifest.dependencies['@deepseek-ai/schemastery'])})
assert.equal(pluginManifest.peerDependencies?.['@deepseek-ai/schemastery'], undefined)
assert.deepEqual(pluginManifest.peerDependencies, ${JSON.stringify(sourceManifest.peerDependencies)})

const fromPlugin = createRequire(pluginManifestPath)
const schemasteryManifestPath = fromPlugin.resolve('@deepseek-ai/schemastery/package.json')
const relativeSchemasteryPath = path.relative(await realpath(consumer), await realpath(schemasteryManifestPath))
assert.ok(
  relativeSchemasteryPath !== '..'
    && !relativeSchemasteryPath.startsWith('..' + path.sep)
    && !path.isAbsolute(relativeSchemasteryPath),
  'Schemastery must be installed inside the isolated consumer',
)
const schemasteryManifest = JSON.parse(await readFile(schemasteryManifestPath, 'utf8'))
assert.equal(schemasteryManifest.version, pluginManifest.dependencies['@deepseek-ai/schemastery'])
assert.equal(plugin.name, 'dsh-alphasolve')
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.Config({}), { defaultCapacity: 2, defaultDetailedTrace: true })
assert.throws(() => plugin.Config({ defaultCapacity: 0 }), /defaultCapacity expected number >= 1/)

const ctx = new Context()
try {
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(consumer + path.sep).href })
  const before = await ctx.systemPrompt.assemble()
  const id = await ctx.loader.create({ name: '${sourceManifest.name}' })
  await ctx.loader.await()
  assert.equal(ctx.loader.resolve(id).fiber?.state, 2, 'Loader did not activate the packed plugin')
  assert.deepEqual(ctx.tools.schemas(), [], 'Dormant AlphaSolve must not expose global tools')
  assert.deepEqual(await ctx.systemPrompt.assemble(), before, 'Dormant AlphaSolve must not change the global prompt')
} finally {
  await ctx.fiber.dispose()
}
`)
  await run([probePath], { cwd: consumer, env })
  console.log('packed-install-ok (real Harness peers, isolated plugin dependencies)')
} finally {
  await unlinkInstalledLinks(temporaryRoot)
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 100 })
}
