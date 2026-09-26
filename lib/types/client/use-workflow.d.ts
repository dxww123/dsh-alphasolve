import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client';
import { type AlphaSolveWorkflowView } from '../workflow-view.js';
/** Reads and validates one complete workflow index under its owning Session. */
export type ReadWorkflow = (sessionId: SessionId, signal: AbortSignal) => Promise<AlphaSolveWorkflowView>;
/**
 * Follow the standard file provider's versions, preserving the last valid view on errors.
 * @param sessionId - main Session whose workspace contains the workflow index.
 * @param useResource - Harness resource hook with shared filesystem watching.
 * @param read - authenticated full-file reader.
 * @returns current view, loading/error flags and explicit retry action.
 */
export declare function useWorkflow(sessionId: SessionId, useResource: UseResource, read: ReadWorkflow): {
    view: {
        version: 1;
        sessionId: string;
        workers: {
            id: string;
            phase: "created" | "generator" | "verifier" | "reviser" | "theorem_checker" | "arbitrating" | "promoting" | "complete";
            round: number;
            theoremChecks: number;
            updatedAt: string;
            instruction?: string | undefined;
            verifierProfile?: "format_references" | "citation" | "failure_modes" | "stepwise" | "premise_chain" | undefined;
            terminalStatus?: "verified" | "solved" | "rejected" | "failed" | "cancelled" | "interrupted" | "stale_problem" | "write_conflict" | "discarded_after_solution" | undefined;
            reason?: string | undefined;
        }[];
        runs: {
            sessionId: string;
            parentSessionId: string;
            role: string;
            startedAt: string;
            status: "error" | "interrupted" | "running" | "completed" | "max_turns" | "max_tokens" | "aborted" | "blocked" | "disposed";
            steps: number;
            workerId?: string | undefined;
            workflowRound?: number | undefined;
            verifierProfile?: "format_references" | "citation" | "failure_modes" | "stepwise" | "premise_chain" | undefined;
            verifierAttempt?: number | undefined;
            theoremAttempt?: number | undefined;
            finishedAt?: string | undefined;
            error?: string | undefined;
        }[];
    } | undefined;
    failed: boolean;
    loading: boolean;
    retry: () => void;
};
//# sourceMappingURL=use-workflow.d.ts.map