import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  MODEL_ROLES,
  type AlphaSolveConfig,
  type AlphaSolveFileConfig,
  type ModelOverride,
  type ModelRole,
} from './types.js'

export { MODEL_ROLES } from './types.js'
export type { AlphaSolveConfig, AlphaSolveFileConfig, ModelOverride, ModelRole } from './types.js'

export const DEFAULT_CAPACITY = 2
export const DEFAULT_DETAILED_TRACE = true

const ROOT_FIELDS = new Set(['capacity', 'detailedTrace', 'models'])
const MODEL_FIELDS = new Set(['provider', 'model', 'reasoningEffort'])
const MODEL_ROLE_SET: ReadonlySet<string> = new Set(MODEL_ROLES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(source: string, field: string, reason: string): never {
  throw new TypeError(`${source}: field "${field}" ${reason}`)
}

function assertKnownFields(
  source: string,
  owner: string,
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${source}: ${owner} contains unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map(key => `"${key}"`).join(', ')}`)
  }
}

export function assertPositiveCapacity(value: unknown, source = 'configuration'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return fail(source, 'capacity', 'must be a positive safe integer')
  }
  return value
}

function parseNonEmptyString(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail(source, field, 'must be a non-empty string')
  }
  if (value !== value.trim()) return fail(source, field, 'must not have leading or trailing whitespace')
  return value
}

function parseModelOverride(value: unknown, source: string, role: ModelRole): ModelOverride {
  const field = `models.${role}`
  if (!isRecord(value)) return fail(source, field, 'must be an object')
  assertKnownFields(source, field, value, MODEL_FIELDS)

  const provider = value.provider === undefined
    ? undefined
    : parseNonEmptyString(value.provider, source, `${field}.provider`)
  const model = value.model === undefined
    ? undefined
    : parseNonEmptyString(value.model, source, `${field}.model`)
  const reasoningEffort = value.reasoningEffort === undefined
    ? undefined
    : parseNonEmptyString(value.reasoningEffort, source, `${field}.reasoningEffort`)

  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

/** Strictly validate a parsed user- or project-level configuration object. */
export function parseModelConfig(value: unknown, source = 'configuration'): AlphaSolveFileConfig {
  if (!isRecord(value)) throw new TypeError(`${source}: configuration root must be an object`)
  assertKnownFields(source, 'configuration root', value, ROOT_FIELDS)

  const capacity = value.capacity === undefined
    ? undefined
    : assertPositiveCapacity(value.capacity, source)
  const detailedTrace = value.detailedTrace
  if (detailedTrace !== undefined && typeof detailedTrace !== 'boolean') {
    return fail(source, 'detailedTrace', 'must be a boolean')
  }

  let models: Partial<Record<ModelRole, ModelOverride>> | undefined
  if (value.models !== undefined) {
    if (!isRecord(value.models)) return fail(source, 'models', 'must be an object')
    const unknownRoles = Object.keys(value.models).filter(role => !MODEL_ROLE_SET.has(role))
    if (unknownRoles.length > 0) {
      throw new TypeError(`${source}: models contains unknown role${unknownRoles.length === 1 ? '' : 's'} ${unknownRoles.map(role => `"${role}"`).join(', ')}`)
    }
    models = {}
    for (const role of MODEL_ROLES) {
      if (value.models[role] !== undefined) models[role] = parseModelOverride(value.models[role], source, role)
    }
    Object.freeze(models)
  }

  return Object.freeze({
    ...(capacity === undefined ? {} : { capacity }),
    ...(detailedTrace === undefined ? {} : { detailedTrace }),
    ...(models === undefined ? {} : { models }),
  })
}

/** Parse JSON without losing the path-specific diagnostic required by activation. */
export function parseModelConfigJson(text: string, source: string): AlphaSolveFileConfig {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TypeError(`${source}: invalid JSON: ${message}`)
  }
  return parseModelConfig(value, source)
}

function mergeOverrides(
  lower: Readonly<Partial<Record<ModelRole, ModelOverride>>> | undefined,
  higher: Readonly<Partial<Record<ModelRole, ModelOverride>>> | undefined,
): Readonly<Partial<Record<ModelRole, ModelOverride>>> | undefined {
  if (lower === undefined && higher === undefined) return undefined
  const merged: Partial<Record<ModelRole, ModelOverride>> = {}
  for (const role of MODEL_ROLES) {
    const low = lower?.[role]
    const high = higher?.[role]
    if (low === undefined && high === undefined) continue
    merged[role] = Object.freeze({ ...low, ...high })
  }
  return Object.freeze(merged)
}

/** Merge configurations from lowest to highest precedence, field by field. */
export function mergeModelConfigs(...configs: readonly AlphaSolveFileConfig[]): AlphaSolveFileConfig {
  let capacity: number | undefined
  let detailedTrace: boolean | undefined
  let models: Readonly<Partial<Record<ModelRole, ModelOverride>>> | undefined

  for (const config of configs) {
    if (config.capacity !== undefined) capacity = assertPositiveCapacity(config.capacity)
    if (config.detailedTrace !== undefined) detailedTrace = config.detailedTrace
    models = mergeOverrides(models, config.models)
  }

  return Object.freeze({
    ...(capacity === undefined ? {} : { capacity }),
    ...(detailedTrace === undefined ? {} : { detailedTrace }),
    ...(models === undefined ? {} : { models }),
  })
}

export interface ResolveConfigOptions {
  readonly promptCapacity?: number
  readonly project?: AlphaSolveFileConfig
  readonly user?: AlphaSolveFileConfig
  readonly defaultCapacity?: number
  readonly defaultDetailedTrace?: boolean
}

/** Apply the product precedence: prompt > project > user > built-in default. */
export function resolveAlphaSolveConfig(options: ResolveConfigOptions = {}): AlphaSolveConfig {
  const merged = mergeModelConfigs(options.user ?? {}, options.project ?? {})
  const capacity = options.promptCapacity !== undefined
    ? assertPositiveCapacity(options.promptCapacity, 'prompt')
    : merged.capacity ?? assertPositiveCapacity(options.defaultCapacity ?? DEFAULT_CAPACITY, 'default configuration')
  const detailedTrace = merged.detailedTrace ?? options.defaultDetailedTrace ?? DEFAULT_DETAILED_TRACE

  return Object.freeze({
    capacity,
    detailedTrace,
    models: merged.models ?? Object.freeze({}),
  })
}

export type ModelAvailabilityCheck = (provider: string, model: string) => boolean

/**
 * Resolve a complete immutable model selection for a newly-created role Agent.
 * Existing Agents retain the previously resolved object when configuration changes.
 * A provider or model change clears inherited effort unless the override supplies it.
 */
export function resolveRoleModelSelection(
  role: ModelRole,
  inherited: ModelSelection,
  overrides: Readonly<Partial<Record<ModelRole, ModelOverride>>> = {},
  isAvailable?: ModelAvailabilityCheck,
): ModelSelection {
  const override = overrides[role]
  const provider = override?.provider ?? inherited.provider
  const model = override?.model ?? inherited.model
  const sameRoute = provider === inherited.provider && model === inherited.model
  const effort = override?.reasoningEffort ?? (sameRoute ? inherited.reasoningEffort : undefined)

  parseNonEmptyString(provider, 'resolved model selection', `${role}.provider`)
  parseNonEmptyString(model, 'resolved model selection', `${role}.model`)
  if (isAvailable !== undefined && !isAvailable(provider, model)) {
    throw new Error(`model selection for role "${role}" is not registered: ${provider}/${model}`)
  }

  return Object.freeze({
    provider,
    model,
    ...(effort === undefined ? {} : {
      reasoningEffort: ReasoningEffortId(effort),
    }),
  })
}
