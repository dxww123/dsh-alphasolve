export declare const VERIFIER_PROFILE_ORDER: readonly ["verifier_format_references", "verifier_citation", "verifier_failure_modes", "verifier_stepwise", "verifier_premise_chain"];
export type VerifierPromptProfile = (typeof VERIFIER_PROFILE_ORDER)[number] | "format_references" | "citation" | "failure_modes" | "stepwise" | "premise_chain";
export declare const REVIEW_VERDICT_JUDGE_PROMPT: string;
export declare const GENERATOR_PROMPT: string;
export declare const REVISER_PROMPT: string;
export declare const THEOREM_CHECKER_PROMPT: string;
export declare const VERIFIER_PROMPT: string;
export declare const VERIFIER_FORMAT_REFERENCES_PROMPT: string;
export declare const VERIFIER_CITATION_PROMPT: string;
export declare const VERIFIER_FAILURE_MODES_PROMPT: string;
export declare const VERIFIER_STEPWISE_PROMPT: string;
export declare const VERIFIER_PREMISE_CHAIN_PROMPT: string;
export declare const COMPUTE_SUBAGENT_PROMPT: string;
export declare const NUMERICAL_EXPERIMENT_SUBAGENT_PROMPT: string;
export declare const REASONING_SUBAGENT_PROMPT: string;
export declare const RESEARCH_REVIEWER_PROMPT: string;
export declare const CURATOR_PROMPT: string;
export declare const ORCHESTRATOR_PROMPT: string;
export declare const ROLE_PROMPTS: Readonly<{
    orchestrator: string;
    generator: string;
    reviser: string;
    theorem_checker: string;
    verifier: string;
    verifier_format_references: string;
    verifier_citation: string;
    verifier_failure_modes: string;
    verifier_stepwise: string;
    verifier_premise_chain: string;
    review_verdict_judge: string;
    compute: string;
    numerical_experiment: string;
    reasoning: string;
    research_reviewer: string;
    curator: string;
}>;
/** AlphaSolve main turn budgets. DSH model routes are resolved separately. */
export declare const ROLE_MAX_TURNS: Readonly<{
    orchestrator: 80;
    generator: 80;
    reviser: 80;
    theorem_checker: 60;
    verifier: 80;
    verifier_format_references: 80;
    verifier_citation: 40;
    verifier_failure_modes: 80;
    verifier_stepwise: 80;
    verifier_premise_chain: 80;
    review_verdict_judge: 80;
    compute: 80;
    numerical_experiment: 80;
    reasoning: 80;
    research_reviewer: 100;
    curator: 80;
}>;
/** Role-scoped helper types; an empty tuple means the Agent tool must be absent. */
export declare const ROLE_SUBAGENTS: Readonly<{
    readonly generator: readonly ["compute", "numerical_experiment", "research_reviewer", "reasoning"];
    readonly verifier_format_references: readonly [];
    readonly verifier_citation: readonly ["reasoning"];
    readonly verifier_failure_modes: readonly ["compute", "numerical_experiment", "reasoning"];
    readonly verifier_stepwise: readonly ["compute", "numerical_experiment", "reasoning"];
    readonly verifier_premise_chain: readonly ["compute", "numerical_experiment", "reasoning"];
    readonly reviser: readonly ["compute", "numerical_experiment", "reasoning"];
    readonly theorem_checker: readonly [];
    readonly curator: readonly ["compute", "reasoning"];
    readonly compute: readonly [];
    readonly numerical_experiment: readonly [];
    readonly reasoning: readonly [];
    readonly research_reviewer: readonly [];
    readonly review_verdict_judge: readonly [];
}>;
export type RolePromptName = keyof typeof ROLE_PROMPTS;
export declare function loadRolePrompt(role: RolePromptName): string;
export interface GeneratorTaskInput {
    problem: string;
    workerRelativePath: string;
    hint?: string | null;
    instruction?: string | null;
}
export declare function buildGeneratorTask(input: GeneratorTaskInput): string;
export interface VerifierTaskInput {
    /** Retained for source compatibility; verifier prompts deliberately never expose the original problem. */
    problem: string;
    propositionPath: string;
    propositionText: string;
    workflowIndex: number;
    attemptIndex: number;
    attemptTotal: number;
    profile: VerifierPromptProfile;
}
export declare function buildVerifierTask(input: VerifierTaskInput): string;
export declare function buildReviewVerdictTask(review: string, workflowIndex: number, attemptIndex: number): string;
export declare function buildReviserTask(_problem: string, propositionPath: string, review: string, workflowIndex: number): string;
export declare function buildTheoremCheckerTask(problem: string, verifiedPropositionPath: string): string;
export interface CuratorDigestInput {
    traceKind: string;
    trace: readonly unknown[];
    callerContext?: Readonly<Record<string, unknown>> | null;
    finalVerifierReview?: boolean;
}
export declare function buildCuratorDigestTask(input: CuratorDigestInput): string;
export declare function buildCuratorHealthCheckTask(scanText?: string): string;
export declare const PROPOSITION_FILENAME_PROMPT_PREFIX: string;
export declare function buildPropositionFilenameTask(propositionText: string): string;
//# sourceMappingURL=prompts.d.ts.map