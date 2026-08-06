/** Strict user/project configuration loading with the documented precedence. */
import { type ResolveConfigOptions } from './model-config.js';
import type { AlphaSolveConfig, AlphaSolveFileConfig } from './types.js';
/** Config paths and parsed layers retained for diagnostics. */
export interface LoadedConfig {
    readonly resolved: AlphaSolveConfig;
    readonly userPath: string;
    readonly projectPath: string;
    readonly user?: AlphaSolveFileConfig;
    readonly project?: AlphaSolveFileConfig;
}
export interface LoadAlphaSolveConfigOptions extends Pick<ResolveConfigOptions, 'promptCapacity' | 'defaultCapacity' | 'defaultDetailedTrace'> {
    readonly environment?: NodeJS.ProcessEnv;
}
/** Resolve the fixed user-level configuration path. */
export declare function userConfigPath(environment?: NodeJS.ProcessEnv): string;
/** Load user and project layers and apply prompt > project > user > default capacity. */
export declare function loadAlphaSolveConfig(workspace: string, options?: LoadAlphaSolveConfigOptions): Promise<LoadedConfig>;
/** Parent directory used by setup instructions and tests. */
export declare function userConfigDirectory(environment?: NodeJS.ProcessEnv): string;
//# sourceMappingURL=config.d.ts.map