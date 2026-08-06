import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  loadAlphaSolveConfig,
  userConfigDirectory,
  userConfigPath,
} from '../src/config.js'
import { initializeWorkspace } from '../src/workspace.js'

const roots: string[] = []

async function setup(): Promise<{ workspace: string; dshHome: string; environment: NodeJS.ProcessEnv }> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-config-workspace-'))
  const dshHome = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-config-home-'))
  roots.push(workspace, dshHome)
  await initializeWorkspace(workspace)
  return { workspace, dshHome, environment: { DSH_HOME: dshHome } }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('configuration loading', () => {
  it('resolves the fixed user path from DSH_HOME', () => {
    expect(userConfigPath({ DSH_HOME: '/tmp/custom-dsh' })).toBe('/tmp/custom-dsh/alphasolve.json')
    expect(userConfigDirectory({ DSH_HOME: '/tmp/custom-dsh' })).toBe('/tmp/custom-dsh')
  })

  it('applies prompt > project > user > built-in capacity and merges model fields', async () => {
    const fixture = await setup()
    await writeFile(path.join(fixture.dshHome, 'alphasolve.json'), `${JSON.stringify({
      capacity: 3,
      detailedTrace: true,
      models: {
        generator: { provider: 'user-provider', model: 'user-model' },
      },
    })}\n`)
    await writeFile(path.join(fixture.workspace, '.alphasolve', 'config.json'), `${JSON.stringify({
      capacity: 5,
      detailedTrace: false,
      models: {
        generator: { model: 'project-model', reasoningEffort: 'max' },
        verifier: { model: 'verifier-model' },
      },
    })}\n`)

    const loaded = await loadAlphaSolveConfig(fixture.workspace, {
      promptCapacity: 7,
      environment: fixture.environment,
    })
    expect(loaded.resolved).toEqual({
      capacity: 7,
      detailedTrace: false,
      models: {
        generator: {
          provider: 'user-provider',
          model: 'project-model',
          reasoningEffort: 'max',
        },
        verifier: { model: 'verifier-model' },
      },
    })
  })

  it('uses defaults when both optional files are absent', async () => {
    const fixture = await setup()
    const loaded = await loadAlphaSolveConfig(fixture.workspace, { environment: fixture.environment })
    expect(loaded.resolved).toEqual({ capacity: 2, detailedTrace: true, models: {} })
    expect(loaded.user).toBeUndefined()
    expect(loaded.project).toBeUndefined()
  })

  it('fails closed on malformed or unknown project fields', async () => {
    const fixture = await setup()
    const projectPath = path.join(fixture.workspace, '.alphasolve', 'config.json')
    await writeFile(projectPath, '{')
    await expect(loadAlphaSolveConfig(fixture.workspace, { environment: fixture.environment }))
      .rejects.toThrow(/config\.json: invalid JSON/)

    await writeFile(projectPath, '{"max_capacity": 2}')
    await expect(loadAlphaSolveConfig(fixture.workspace, { environment: fixture.environment }))
      .rejects.toThrow(/unknown field "max_capacity"/)
  })

  it('rejects a project config symlink escaping the workspace', async () => {
    const fixture = await setup()
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-config-outside-'))
    roots.push(outside)
    const outsideConfig = path.join(outside, 'config.json')
    await writeFile(outsideConfig, '{"capacity": 9}\n')
    await symlink(outsideConfig, path.join(fixture.workspace, '.alphasolve', 'config.json'))

    await expect(loadAlphaSolveConfig(fixture.workspace, { environment: fixture.environment }))
      .rejects.toThrow(/symlink resolves outside|symlink escapes/)
  })

  it('rejects a non-file user configuration path', async () => {
    const fixture = await setup()
    await mkdir(path.join(fixture.dshHome, 'alphasolve.json'))
    await expect(loadAlphaSolveConfig(fixture.workspace, { environment: fixture.environment }))
      .rejects.toThrow(/configuration is not an ordinary file/)
  })
})
