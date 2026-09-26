/** Browser-safe AlphaSolve workflow overview schema and index path. */
import { z } from 'zod';
declare const workerSchema: z.ZodObject<{
    id: z.ZodString;
    instruction: z.ZodOptional<z.ZodString>;
    phase: z.ZodEnum<{
        created: "created";
        generator: "generator";
        verifier: "verifier";
        reviser: "reviser";
        theorem_checker: "theorem_checker";
        arbitrating: "arbitrating";
        promoting: "promoting";
        complete: "complete";
    }>;
    round: z.ZodNumber;
    verifierProfile: z.ZodOptional<z.ZodEnum<{
        format_references: "format_references";
        citation: "citation";
        failure_modes: "failure_modes";
        stepwise: "stepwise";
        premise_chain: "premise_chain";
    }>>;
    theoremChecks: z.ZodNumber;
    terminalStatus: z.ZodOptional<z.ZodEnum<{
        verified: "verified";
        solved: "solved";
        rejected: "rejected";
        failed: "failed";
        cancelled: "cancelled";
        interrupted: "interrupted";
        stale_problem: "stale_problem";
        write_conflict: "write_conflict";
        discarded_after_solution: "discarded_after_solution";
    }>>;
    updatedAt: z.ZodISODateTime;
    reason: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const runSchema: z.ZodObject<{
    sessionId: z.ZodString;
    parentSessionId: z.ZodString;
    workerId: z.ZodOptional<z.ZodString>;
    role: z.ZodString;
    workflowRound: z.ZodOptional<z.ZodNumber>;
    verifierProfile: z.ZodOptional<z.ZodEnum<{
        format_references: "format_references";
        citation: "citation";
        failure_modes: "failure_modes";
        stepwise: "stepwise";
        premise_chain: "premise_chain";
    }>>;
    verifierAttempt: z.ZodOptional<z.ZodNumber>;
    theoremAttempt: z.ZodOptional<z.ZodNumber>;
    startedAt: z.ZodISODateTime;
    finishedAt: z.ZodOptional<z.ZodISODateTime>;
    status: z.ZodEnum<{
        error: "error";
        interrupted: "interrupted";
        running: "running";
        completed: "completed";
        max_turns: "max_turns";
        max_tokens: "max_tokens";
        aborted: "aborted";
        blocked: "blocked";
        disposed: "disposed";
    }>;
    steps: z.ZodNumber;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const viewSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    workers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        instruction: z.ZodOptional<z.ZodString>;
        phase: z.ZodEnum<{
            created: "created";
            generator: "generator";
            verifier: "verifier";
            reviser: "reviser";
            theorem_checker: "theorem_checker";
            arbitrating: "arbitrating";
            promoting: "promoting";
            complete: "complete";
        }>;
        round: z.ZodNumber;
        verifierProfile: z.ZodOptional<z.ZodEnum<{
            format_references: "format_references";
            citation: "citation";
            failure_modes: "failure_modes";
            stepwise: "stepwise";
            premise_chain: "premise_chain";
        }>>;
        theoremChecks: z.ZodNumber;
        terminalStatus: z.ZodOptional<z.ZodEnum<{
            verified: "verified";
            solved: "solved";
            rejected: "rejected";
            failed: "failed";
            cancelled: "cancelled";
            interrupted: "interrupted";
            stale_problem: "stale_problem";
            write_conflict: "write_conflict";
            discarded_after_solution: "discarded_after_solution";
        }>>;
        updatedAt: z.ZodISODateTime;
        reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    runs: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        parentSessionId: z.ZodString;
        workerId: z.ZodOptional<z.ZodString>;
        role: z.ZodString;
        workflowRound: z.ZodOptional<z.ZodNumber>;
        verifierProfile: z.ZodOptional<z.ZodEnum<{
            format_references: "format_references";
            citation: "citation";
            failure_modes: "failure_modes";
            stepwise: "stepwise";
            premise_chain: "premise_chain";
        }>>;
        verifierAttempt: z.ZodOptional<z.ZodNumber>;
        theoremAttempt: z.ZodOptional<z.ZodNumber>;
        startedAt: z.ZodISODateTime;
        finishedAt: z.ZodOptional<z.ZodISODateTime>;
        status: z.ZodEnum<{
            error: "error";
            interrupted: "interrupted";
            running: "running";
            completed: "completed";
            max_turns: "max_turns";
            max_tokens: "max_tokens";
            aborted: "aborted";
            blocked: "blocked";
            disposed: "disposed";
        }>;
        steps: z.ZodNumber;
        error: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** One worker's durable progress, independent of its individual role Sessions. */
export type AlphaSolveWorkerView = z.infer<typeof workerSchema>;
/** One real role Session, retained after its live Agent has been disposed. */
export type AlphaSolveRoleRunView = z.infer<typeof runSchema>;
/** Complete overview exposed to the desktop's AlphaSolve panel. */
export type AlphaSolveWorkflowView = z.infer<typeof viewSchema>;
/** Role identity captured before a fresh Session starts. */
export type AlphaSolveRoleIdentity = Pick<AlphaSolveRoleRunView, 'role' | 'workerId' | 'workflowRound' | 'verifierProfile' | 'verifierAttempt' | 'theoremAttempt'>;
/** Relative workspace path of one main Session's workflow index. */
export declare function alphaSolveWorkflowPath(sessionId: string): string;
/** Validate a durable workflow index before rendering its navigation targets. */
export declare function parseAlphaSolveWorkflowView(value: unknown): AlphaSolveWorkflowView;
export {};
//# sourceMappingURL=workflow-view.d.ts.map