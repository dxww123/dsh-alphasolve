#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const packageRequire = createRequire(import.meta.url)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const timeoutMs = 120_000
const corepackHome = process.env.COREPACK_HOME ?? path.join(
  process.env.XDG_CACHE_HOME
    ?? process.env.LOCALAPPDATA
    ?? path.join(homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'),
  'node/corepack',
)

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
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: path.join(home, '.dsh'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9/',
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    CI: 'true',
    FORCE_COLOR: '0',
  }
  for (const key of Object.keys(env)) {
    if (/^(?:npm|node)_.*(?:token|auth)|^npm_config_(?:userconfig|globalconfig|proxy|https_proxy)$/i.test(key)) {
      delete env[key]
    }
  }
  delete env.NODE_PATH
  return env
}

async function run(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const output = Buffer.concat(stdout).toString('utf8')
    const errorOutput = Buffer.concat(stderr).toString('utf8')
    if (code !== 0) {
      throw new Error([
        `${command} ${args.join(' ')} failed with ${signal === null ? `exit code ${String(code)}` : `signal ${signal}`}`,
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
  await run(pnpm, ['pack', '--out', destination], { cwd: source, env })
}

async function writeStub(root, name, version, source = 'export {}\n') {
  const directory = path.join(root, ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name,
      version,
      type: 'module',
      exports: {
        '.': './index.js',
        './package.json': './package.json',
      },
    }, null, 2)}\n`),
    writeFile(path.join(directory, 'index.js'), source),
  ])
  return `file:./${path.relative(path.dirname(root), directory).split(path.sep).join('/')}`
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-packed-install-'))
try {
  const home = path.join(temporaryRoot, 'home')
  const consumer = path.join(temporaryRoot, 'consumer')
  const artifacts = path.join(consumer, 'artifacts')
  const stubs = path.join(consumer, 'stubs')
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(artifacts, { recursive: true }),
    mkdir(stubs, { recursive: true }),
  ])
  const env = isolatedEnvironment(home)

  const schemasteryDirectory = await packageDirectory('@deepseek-ai/schemastery')
  const schemasteryRequire = createRequire(path.join(schemasteryDirectory, 'package.json'))
  const cosmokitDirectory = await packageDirectory('@deepseek-ai/cosmokit', schemasteryRequire)
  const standardSchemaDirectory = await packageDirectory('@standard-schema/spec', schemasteryRequire)

  const alphaSolveTarball = path.join(artifacts, 'dsh-alphasolve.tgz')
  const schemasteryTarball = path.join(artifacts, 'schemastery.tgz')
  const cosmokitTarball = path.join(artifacts, 'cosmokit.tgz')
  const standardSchemaTarball = path.join(artifacts, 'standard-schema-spec.tgz')
  await Promise.all([
    pack(packageRoot, alphaSolveTarball, env),
    pack(schemasteryDirectory, schemasteryTarball, env),
    pack(cosmokitDirectory, cosmokitTarball, env),
    pack(standardSchemaDirectory, standardSchemaTarball, env),
  ])

  const stubDependencies = Object.fromEntries(await Promise.all([
    ['@deepseek-ai/cordis', '4.0.1-rc.1', 'export class Context {}\n'],
    ['@deepseek-ai/dsh-agent', '0.0.1-rc.2', [
      'export const assembleContextFor = () => ({})',
      'export const installModelSelection = () => () => {}',
      '',
    ].join('\n')],
    ['@deepseek-ai/dsh-atomic-write', '0.0.1-rc.2', [
      'export const withFileLock = async (_path, callback) => await callback()',
      'export const writeFileAtomic = async () => {}',
      '',
    ].join('\n')],
    ['@deepseek-ai/dsh-llm', '0.0.1-rc.2', 'export const createUserMessage = value => value\n'],
    ['@deepseek-ai/dsh-session', '0.0.1-rc.2', 'export const SessionId = value => value\n'],
    ['@deepseek-ai/dsh-system-prompt', '0.0.1-rc.2'],
    ['@deepseek-ai/dsh-tools', '0.0.1-rc.2'],
  ].map(async ([name, version, source]) => [
    name,
    await writeStub(stubs, name, version, source),
  ])))

  await Promise.all([
    writeFile(path.join(consumer, 'package.json'), `${JSON.stringify({
      name: 'dsh-alphasolve-packed-install-probe',
      private: true,
      type: 'module',
      dependencies: {
        '@dsh-external/dsh-alphasolve': 'file:./artifacts/dsh-alphasolve.tgz',
        ...stubDependencies,
      },
    }, null, 2)}\n`),
    writeFile(path.join(consumer, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      'nodeLinker: isolated',
      'autoInstallPeers: false',
      'strictPeerDependencies: false',
      'storeDir: .pnpm-store',
      'overrides:',
      "  '@deepseek-ai/schemastery': file:./artifacts/schemastery.tgz",
      "  '@deepseek-ai/cosmokit': file:./artifacts/cosmokit.tgz",
      "  '@standard-schema/spec': file:./artifacts/standard-schema-spec.tgz",
      '',
    ].join('\n')),
  ])

  await run(pnpm, [
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--reporter=append-only',
  ], { cwd: consumer, env })

  const cordisEntry = packageRequire.resolve('@deepseek-ai/cordis')
  const loaderEntry = packageRequire.resolve('@deepseek-ai/cordis-plugin-loader')
  const probePath = path.join(consumer, 'probe.mjs')
  await writeFile(probePath, `
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const consumer = ${JSON.stringify(consumer)}
const pluginManifestPath = fileURLToPath(import.meta.resolve('@dsh-external/dsh-alphasolve/package.json'))
const pluginManifest = JSON.parse(await readFile(pluginManifestPath, 'utf8'))
assert.equal(
  pluginManifest.dependencies?.['@deepseek-ai/schemastery'],
  '3.18.1-rc.1',
  'the packed plugin must install @deepseek-ai/schemastery as its own runtime dependency',
)
assert.equal(
  pluginManifest.peerDependencies?.['@deepseek-ai/schemastery'],
  undefined,
  '@deepseek-ai/schemastery must not remain a peer dependency',
)

const fromPlugin = createRequire(pluginManifestPath)
const schemasteryManifestPath = fromPlugin.resolve('@deepseek-ai/schemastery/package.json')
const relativeSchemasteryPath = path.relative(
  await realpath(consumer),
  await realpath(schemasteryManifestPath),
)
assert.ok(
  relativeSchemasteryPath !== '..'
    && !relativeSchemasteryPath.startsWith(\`..\${path.sep}\`)
    && !path.isAbsolute(relativeSchemasteryPath),
  \`schemastery escaped the isolated consumer: \${schemasteryManifestPath}\`,
)
const schemasteryManifest = JSON.parse(await readFile(schemasteryManifestPath, 'utf8'))
assert.equal(schemasteryManifest.version, '3.18.1-rc.1')

const pluginEntry = path.join(path.dirname(pluginManifestPath), 'lib', 'index.js')
const plugin = await import(pathToFileURL(pluginEntry).href)
assert.equal(plugin.name, 'dsh-alphasolve')
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.Config({}), {
  defaultCapacity: 2,
  defaultDetailedTrace: true,
})
assert.throws(
  () => plugin.Config({ defaultCapacity: 0 }),
  /defaultCapacity expected number >= 1/,
)

const [{ Context }, { default: Loader }] = await Promise.all([
  import(${JSON.stringify(pathToFileURL(cordisEntry).href)}),
  import(${JSON.stringify(pathToFileURL(loaderEntry).href)}),
])
const ctx = new Context()
for (const service of ['agents', 'tools', 'systemPrompt']) ctx.provide(service, {})
await ctx.plugin(Loader, { baseUrl: pathToFileURL(consumer + path.sep).href })
const id = await ctx.loader.create({ name: pathToFileURL(pluginEntry).href })
await ctx.loader.await()
assert.equal(ctx.loader.resolve(id).fiber?.state, 2, 'Loader did not activate the packed plugin')
await ctx.fiber.dispose()
`)

  await run(process.execPath, [probePath], { cwd: consumer, env })
  console.log('packed-install-ok')
} finally {
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  })
}
