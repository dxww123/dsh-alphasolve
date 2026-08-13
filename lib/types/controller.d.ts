/** Dormant global controller and one-turn, session-scoped AlphaSolve preflight. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { activateAlphaSolveRuntime, restoreAlphaSolveRuntime, type AlphaSolveRuntimeDefaults } from './runtime.js';
export declare const ACTIVATE_TOOL_NAME = "alphasolve_activate";
export interface ControllerOptions extends AlphaSolveRuntimeDefaults {
    /** Test seam; production mounts the real runtime. */
    readonly activate?: typeof activateAlphaSolveRuntime;
    /** Test seam; production restores the real runtime on a cold session resume. */
    readonly restore?: typeof restoreAlphaSolveRuntime;
}
/** Strict dormant trigger: direct human source plus whole ASCII word, case-insensitive. */
export declare function requestsAlphaSolvePreflight(message: UserMessage): boolean;
/** Subagent/fork sessions never receive the dormant trigger controller. */
export declare function isTopLevelAgent(agent: Agent): boolean;
/** Owns every dynamic child fiber created by the otherwise dormant plugin. */
export declare class AlphaSolveController {
    private readonly ctx;
    private readonly options;
    private readonly states;
    private readonly activate;
    private readonly restore;
    constructor(ctx: Context, options?: ControllerOptions);
    install(): () => Promise<void>;
    private beginRestore;
    private injectRestoreDiagnostic;
    private mountPreflight;
    private activationTool;
    private disposePreflight;
}
//# sourceMappingURL=controller.d.ts.map