/** Session-owned AlphaSolve runtime: durable state, workers, tools, and teardown. */
import { type Agent } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
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
export declare const ALPHASOLVE_REQUIRED_FILE_TOOLS: readonly ["read", "write", "edit", "glob", "grep"];
export declare const AGENT_PRESET_MISSING_TOOLS_REASON: "agent_preset_missing_required_tools";
export declare const AGENT_PRESET_BLOCKS_PROMPT_REASON: "agent_preset_blocks_alphasolve_prompt";
export interface AlphaSolveAgentCapabilities {
    readonly agentPreset?: string;
    readonly missingTools: readonly string[];
}
/** Inspect the complete inherited catalog for this exact live Agent scope. */
export declare function inspectAlphaSolveAgentCapabilities(agent: Agent): AlphaSolveAgentCapabilities;
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
/** Cold-resume outcome. An absent reason means this session has no live AlphaSolve intent. */
export type RuntimeRestoreResult = {
    readonly restored: false;
    readonly workspace: string;
    readonly reason?: string;
    readonly agentPreset?: string;
    readonly missingTools?: readonly string[];
} | {
    readonly restored: true;
    readonly workspace: string;
    readonly capacity: number;
    readonly runtime: AlphaSolveRuntime;
};
type ActivationMode = 'explicit' | 'session-resume';
/**
 * A successful activation is durable user authorization for this session.
 * Any later stop call wins even if the process died before its result was
 * appended: fail closed rather than resurrecting an intentionally stopped run.
 */
export declare function hasDurableAlphaSolveResumeIntent(events: readonly SessionEvent[]): boolean;
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
    static activate(agent: Agent, request: RuntimeActivationRequest, defaults: AlphaSolveRuntimeDefaults, onDisposed: () => void, signal?: AbortSignal, mode?: ActivationMode): Promise<{
        readonly runtime: AlphaSolveRuntime;
        readonly resumed: boolean;
    }>;
    private visibleAllowedInheritedTools;
    private narrowedIndexTools;
    private install;
    private trackToolResultCommit;
    private flushToolResultCommits;
    private createRuntimeTools;
    private createProjectToolDefinitions;
    private onToolResultEvent;
    private maybeDisposeAfterTerminalResult;
    /** Release workspace ownership and always detach this runtime from its controller. */
    private releaseOwnership;
    private shutdown;
    /** Dispose the published session fiber, or the prepared resources on startup failure. */
    dispose(): Promise<void>;
}
/** Convert activation failures into a stable preflight tool result. */
export declare function activateAlphaSolveRuntime(agent: Agent, request: RuntimeActivationRequest, defaults: AlphaSolveRuntimeDefaults, onDisposed: () => void, signal?: AbortSignal): Promise<RuntimeActivationResult>;
/**
 * Reattach a runtime only when the selected workspace carries durable active
 * intent for this exact resumed session. This is recovery, never a new
 * activation: it cannot archive a generation or authorize solution overwrite.
 */
export declare function restoreAlphaSolveRuntime(agent: Agent, defaults: AlphaSolveRuntimeDefaults, onDisposed: () => void, signal?: AbortSignal): Promise<RuntimeRestoreResult>;
export {};
//# sourceMappingURL=runtime.d.ts.map