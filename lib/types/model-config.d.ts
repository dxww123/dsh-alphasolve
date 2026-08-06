import type { AgentLlmTarget } from '@deepseek-ai/dsh-agent';
import { type AlphaSolveConfig, type AlphaSolveFileConfig, type ModelOverride, type ModelRole } from './types.js';
export { MODEL_ROLES } from './types.js';
export type { AlphaSolveConfig, AlphaSolveFileConfig, ModelOverride, ModelRole } from './types.js';
export declare const DEFAULT_CAPACITY = 2;
export declare const DEFAULT_DETAILED_TRACE = true;
export declare function assertPositiveCapacity(value: unknown, source?: string): number;
/** Strictly validate a parsed user- or project-level configuration object. */
export declare function parseModelConfig(value: unknown, source?: string): AlphaSolveFileConfig;
/** Parse JSON without losing the path-specific diagnostic required by activation. */
export declare function parseModelConfigJson(text: string, source: string): AlphaSolveFileConfig;
/** Merge configurations from lowest to highest precedence, field by field. */
export declare function mergeModelConfigs(...configs: readonly AlphaSolveFileConfig[]): AlphaSolveFileConfig;
export interface ResolveConfigOptions {
    readonly promptCapacity?: number;
    readonly project?: AlphaSolveFileConfig;
    readonly user?: AlphaSolveFileConfig;
    readonly defaultCapacity?: number;
    readonly defaultDetailedTrace?: boolean;
}
/** Apply the product precedence: prompt > project > user > built-in default. */
export declare function resolveAlphaSolveConfig(options?: ResolveConfigOptions): AlphaSolveConfig;
export type ModelAvailabilityCheck = (provider: string, model: string) => boolean;
/**
 * Resolve a complete immutable target for a newly-created role Agent.
 * Existing Agents retain the previously resolved object when configuration changes.
 */
export declare function resolveRoleLlmTarget(role: ModelRole, inherited: AgentLlmTarget, overrides?: Readonly<Partial<Record<ModelRole, ModelOverride>>>, isAvailable?: ModelAvailabilityCheck): AgentLlmTarget;
//# sourceMappingURL=model-config.d.ts.map