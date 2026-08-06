/** Fixed AlphaSolve worker workflow, independent of the concrete DSH role runner. */
import type { FileStamp, VerifierProfile } from './types.js';
import type { WorkerExecutionContext, WorkerExecutor, WorkflowResult } from './worker-manager.js';
export declare const MAX_VERIFY_ROUNDS = 6;
export declare const THEOREM_CHECK_ATTEMPTS = 5;
export type WorkflowRole = 'generator' | 'verifier_format_references' | 'verifier_citation' | 'verifier_failure_modes' | 'verifier_stepwise' | 'verifier_premise_chain' | 'review_verdict_judge' | 'reviser' | 'theorem_checker';
export interface RoleInvocation {
    readonly role: WorkflowRole;
    readonly workerId: string;
    /** A fresh Agent must use this as its cwd. */
    readonly cwd: string;
    readonly workspace: string;
    readonly workerDirectory: string;
    readonly propositionPath: string;
    readonly theoremViewDirectory?: string;
    readonly verifierProfile?: VerifierProfile;
    readonly workflowRound?: number;
    readonly verifierAttempt?: number;
    readonly theoremAttempt?: number;
    readonly expectedPropositionStamp?: FileStamp;
    readonly persona: string;
    readonly task: string;
    readonly maxTurns: number;
    readonly signal: AbortSignal;
}
export interface RoleInvocationResult {
    readonly text: string;
    readonly trace?: readonly unknown[];
    readonly artifactPaths?: readonly string[];
}
/** The implementation must create and dispose a fresh DSH Agent for every call. */
export interface RoleInvoker {
    invoke(request: RoleInvocation): Promise<RoleInvocationResult>;
    /** Workspace-relative durable trace artifacts accumulated for this worker. */
    artifactPaths?(workerId: string): readonly string[];
}
export interface PropositionFilenameRequest {
    readonly workerId: string;
    readonly propositionText: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
}
/** Return the raw filename-model answer; the workflow always sanitizes it. */
export type PropositionFilenameBuilder = (request: PropositionFilenameRequest) => Promise<string>;
export interface SolutionPublishRequest {
    readonly workerId: string;
    readonly workspace: string;
    readonly problemText: string;
    readonly verifiedDir: string;
    readonly finalPropositionPath: string;
    readonly solutionPath: string;
    readonly signal: AbortSignal;
}
export type SolutionPublisher = (request: SolutionPublishRequest) => Promise<string>;
export interface FixedWorkflowOptions {
    readonly workspace: string;
    readonly invoker: RoleInvoker;
    readonly filenameBuilder?: PropositionFilenameBuilder;
    readonly solutionPublisher?: SolutionPublisher;
    /** Preflight must have explicitly authorized and backed up this replacement. */
    readonly replaceExistingSolution?: boolean;
}
export declare class PropositionWriteConflictError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
/** Create the WorkerManager-compatible executor for one locked session. */
export declare function createFixedWorkerExecutor(options: FixedWorkflowOptions): WorkerExecutor;
/** Exported for focused tests and alternate schedulers. */
export declare function runFixedWorkerWorkflow(options: FixedWorkflowOptions, context: WorkerExecutionContext): Promise<WorkflowResult>;
//# sourceMappingURL=workflow.d.ts.map