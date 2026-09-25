/** AlphaSolve for DSH: dormant controller with session-scoped hot activation. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export * from './controller.js';
export * from './runtime.js';
export * from './session-state.js';
export * from './types.js';
export declare const name = "dsh-alphasolve";
export declare const inject: string[];
export interface Config {
    /** Built-in fallback after prompt, project, and user configuration (default 2). */
    readonly defaultCapacity?: number;
    /** Built-in trace-persistence fallback (default true). */
    readonly defaultDetailedTrace?: boolean;
}
export declare const Config: z<Config>;
/** Install only the dormant trigger listener. It contributes no global tool or prompt. */
export declare function apply(ctx: Context, config?: Config): () => Promise<void>;
//# sourceMappingURL=index.d.ts.map