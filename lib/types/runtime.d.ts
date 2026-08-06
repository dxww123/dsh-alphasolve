/** Session-owned AlphaSolve runtime: durable state, workers, tools, and teardown. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type RoleTraceEvent } from './role-service.js';
import { RuntimeStore } from './store.js';
import { type ActivateResult } from './types.js';
import { WorkerManager } from './worker-manager.js';
export declare const RUNTIME_TOOL_NAMES: Readonly<{
    readonly worker: "alphasolve_worker";
    readonly wait: "alphasolve_wait";
    readonly configure: "alphasolve_configure";
    readonly researchReview: "alphasolve_research_review";
    readonly stop: "alphasolve_stop";
}>;
/** Curator-helper output is already part of its parent task and must not self-enqueue. */
export declare function shouldEnqueueCuratorTrace(event: Pick<RoleTraceEvent, 'parentRole'>): boolean;
export interface AlphaSolveRuntimeDefaults {
    readonly defaultCapacity?: number;
    readonly defaultDetailedTrace?: boolean;
}
export interface RuntimeActivationRequest {
    readonly capacity?: number;
    readonly overwriteSolution?: boolean;
}
export type RuntimeActivationResult = (ActivateResult & {
    readonly activated: false;
}) | (ActivateResult & {
    readonly activated: true;
    readonly runtime: AlphaSolveRuntime;
});
/**
 * Preserve a completed or different-problem state before beginning a new
 * explicit AlphaSolve request. Research files remain in place; only runtime
 * metadata whose delivery/winner semantics cannot cross generations moves.
 */
export type ArchiveGenerationPhase = 'completions' | 'workers' | 'curator' | 'metadata' | 'committed';
export interface ArchiveGenerationOptions {
    /** Failure-injection/observability seam; production leaves it unset. */
    readonly afterPhase?: (phase: ArchiveGenerationPhase, backup: string) => Promise<void> | void;
}
export declare function archivePreviousGeneration(workspace: string, problemDigest: string, options?: ArchiveGenerationOptions): Promise<boolean>;
/** One locked, session-isolated AlphaSolve runtime. */
export declare class AlphaSolveRuntime {
    private readonly agent;
    private readonly lock;
    private config;
    private readonly curator;
    private readonly roleService;
    private readonly projectTools;
    private readonly replaceExistingSolution;
    private readonly terminalRecovery;
    private readonly onDisposed;
    readonly workspace: string;
    readonly store: RuntimeStore;
    readonly manager: WorkerManager;
    private fiber;
    private readonly waitCalls;
    private readonly solvedWaitCalls;
    private solvedResultCommitted;
    private stopCallId;
    private stopResultCommitted;
    private turnSettled;
    private readonly pendingSessionCommits;
    private readonly pendingSessionCommitErrors;
    private readonly completionsSinceResearchReview;
    private shutdownPromise;
    private disposed;
    private constructor();
    private static prepare;
    /** Prepare resources, then publish all tools/prompt in one agent child fiber. */
    static activate(agent: Agent, request: RuntimeActivationRequest, defaults: AlphaSolveRuntimeDefaults, onDisposed: () => void, signal?: AbortSignal): Promise<{
        readonly runtime: AlphaSolveRuntime;
        readonly resumed: boolean;
    }>;
    private visibleAllowedGlobals;
    private narrowedIndexTools;
    private install;
    private trackToolResultCommit;
    private flushToolResultCommits;
    private createRuntimeTools;
    private createProjectToolDefinitions;
    private onToolResultEvent;
    private maybeDisposeAfterTerminalResult;
    private shutdown;
    /** Dispose the published session fiber, or the prepared resources on startup failure. */
    dispose(): Promise<void>;
}
/** Convert activation failures into a stable preflight tool result. */
export declare function activateAlphaSolveRuntime(agent: Agent, request: RuntimeActivationRequest, defaults: AlphaSolveRuntimeDefaults, onDisposed: () => void, signal?: AbortSignal): Promise<RuntimeActivationResult>;
//# sourceMappingURL=runtime.d.ts.map