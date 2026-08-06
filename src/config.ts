/** Strict user/project configuration loading with the documented precedence. */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { lstat, readFile, realpath } from 'node:fs/promises'
import {
  parseModelConfigJson,
  resolveAlphaSolveConfig,
  type ResolveConfigOptions,
} from './model-config.js'
import type { AlphaSolveConfig, AlphaSolveFileConfig } from './types.js'
import { isContained, resolveWorkspacePath, WorkspaceError } from './workspace.js'

/** Config paths and parsed layers retained for diagnostics. */
export interface LoadedConfig {
  readonly resolved: AlphaSolveConfig
  readonly userPath: string
  readonly projectPath: string
  readonly user?: AlphaSolveFileConfig
  readonly project?: AlphaSolveFileConfig
}

export interface LoadAlphaSolveConfigOptions
  extends Pick<ResolveConfigOptions, 'promptCapacity' | 'defaultCapacity' | 'defaultDetailedTrace'> {
  readonly environment?: NodeJS.ProcessEnv
}

/** Resolve the fixed user-level configuration path. */
export function userConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.DSH_HOME
  const dshHome = explicit === undefined || explicit.trim() === '' ? join(homedir(), '.dsh') : explicit
  return join(dshHome, 'alphasolve.json')
}

/** Read a strict optional JSON config; missing is the only silent outcome. */
async function readOptionalConfig(path: string, containmentRoot?: string): Promise<AlphaSolveFileConfig | undefined> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new TypeError(`${path}: unable to inspect configuration: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!info.isFile() && !info.isSymbolicLink()) throw new TypeError(`${path}: configuration is not an ordinary file`)
  if (containmentRoot !== undefined) {
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch (error) {
      throw new TypeError(`${path}: unable to resolve configuration: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isContained(containmentRoot, canonical)) throw new WorkspaceError('configuration symlink escapes the workspace', path)
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new TypeError(`${path}: unable to read configuration: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseModelConfigJson(text, path)
}

/** Load user and project layers and apply prompt > project > user > default capacity. */
export async function loadAlphaSolveConfig(
  workspace: string,
  options: LoadAlphaSolveConfigOptions = {},
): Promise<LoadedConfig> {
  const userPath = userConfigPath(options.environment)
  const projectPath = await resolveWorkspacePath(workspace, '.alphasolve/config.json', { mustExist: false })
  const [user, project] = await Promise.all([
    readOptionalConfig(userPath),
    readOptionalConfig(projectPath, workspace),
  ])
  return {
    resolved: resolveAlphaSolveConfig({
      ...options.promptCapacity === undefined ? {} : { promptCapacity: options.promptCapacity },
      ...options.defaultCapacity === undefined ? {} : { defaultCapacity: options.defaultCapacity },
      ...options.defaultDetailedTrace === undefined ? {} : { defaultDetailedTrace: options.defaultDetailedTrace },
      ...user === undefined ? {} : { user },
      ...project === undefined ? {} : { project },
    }),
    userPath,
    projectPath,
    ...user === undefined ? {} : { user },
    ...project === undefined ? {} : { project },
  }
}

/** Parent directory used by setup instructions and tests. */
export function userConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return dirname(userConfigPath(environment))
}
