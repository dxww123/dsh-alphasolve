/** Capacity-bounded asynchronous worker scheduling and durable wait delivery. */
import { type WorkerCompletion, type WorkerRecord, type WorkerStartResult, type WorkerWaitResult } from './types.js';
import type { RuntimeStore } from './store.js';
/** Thrown at workflow phase boundaries when the immutable problem changed. */
export declare class ProblemChangedError extends Error {
    constructor();
}
/** Terminal information returned by the fixed workflow implementation. */
export interface WorkflowResult {
    readonly status: WorkerCompletion['status'];
    readonly producedVerifiedProposition: boolean;
    readonly solved: boolean;
    readonly statement?: string;
    readonly propositionPath?: string;
    readonly failureStage?: string;
    readonly reason?: string;
    readonly artifactPaths: readonly string[];
    /** In-process rollback for the post-publication digest/ledger window. */
    readonly rollbackPublishedSolution?: () => Promise<void>;
}
/** Capabilities supplied to one fixed workflow execution. */
export interface WorkerExecutionContext {
    readonly id: string;
    readonly instruction: string;
    readonly signal: AbortSignal;
    readonly problemDigest: string;
    readonly hintDigest?: string;
    progress(update: Partial<WorkerRecord>): Promise<void>;
    assertInputsCurrent(): Promise<void>;
    claimSolvedWinner(): Promise<boolean>;
    releaseSolvedWinner?(): Promise<void>;
}
/** Injectable fixed-workflow implementation. */
export type WorkerExecutor = (context: WorkerExecutionContext) => Promise<WorkflowResult>;
export interface ActiveWorkerProgress {
    readonly workerId: string;
    readonly phase: WorkerRecord['phase'];
    readonly round: number;
    readonly verifierProfile?: WorkerRecord['verifierProfile'];
    readonly theoremChecks: number;
}
/** Wait response before the tool-result commit phase. */
export type ReservedWaitResult = WorkerWaitResult;
/** Own all detached worker promises for exactly one active AlphaSolve session. */
export declare class WorkerManager {
    private readonly store;
    private readonly executeWorkflow;
    private readonly onHintChanged;
    private readonly onBackgroundError;
    private readonly assertRuntimeOwned;
    private readonly onSolution;
    private readonly active;
    private readonly activeRecords;
    private readonly notifier;
    private readonly pendingAdmissions;
    private stopping;
    private solutionFound;
    private finalizingWinnerId;
    private solutionDrainGate;
    private stopStatus;
    private problemNoticeSent;
    constructor(store: RuntimeStore, executeWorkflow: WorkerExecutor, onHintChanged: (message: string) => void, onBackgroundError?: (error: unknown) => void, assertRuntimeOwned?: () => Promise<void>, onSolution?: () => Promise<void>);
    /** Current active worker IDs in start order. */
    activeIds(): string[];
    /** Synchronous model/UI summary updated at every durable phase boundary. */
    activeProgress(): readonly ActiveWorkerProgress[];
    /** Current hard capacity from durable session state. */
    capacity(): number;
    /** Whether active work temporarily exceeds a newly lowered capacity. */
    overCapacity(): boolean;
    /** Verify problem/hint digests and notify the orchestrator once per hint version. */
    assertInputsCurrent(): Promise<void>;
    /** Atomically claim the one solution winner. */
    private claimSolvedWinner;
    /** Release only this worker's provisional winner claim after a failed publish. */
    private releaseSolvedWinner;
    private finishSolvedDrain;
    /** Start a worker immediately or return a non-queuing admission failure. */
    start(instruction: string): Promise<WorkerStartResult>;
    private driveWorker;
    /** Wait for and reserve all completions published since the last committed wait. */
    wait(callId: string, signal: AbortSignal): Promise<ReservedWaitResult>;
    /** Change the single hard capacity without cancelling over-capacity workers. */
    configure(capacity: number): Promise<{
        readonly previousCapacity: number;
        readonly capacity: number;
        readonly active: number;
        readonly overCapacity: boolean;
    }>;
    /** Abort all workers and wait for every detached promise to settle. */
    stop(status?: 'cancelled' | 'interrupted'): Promise<void>;
}
//# sourceMappingURL=worker-manager.d.ts.map