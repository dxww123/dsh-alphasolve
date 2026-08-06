/** Production bridge from the fixed AlphaSolve workflow to fresh DSH role Agents. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CuratorRunner } from './curator.js';
import type { CuratorKnowledgeTools } from './curator-tools.js';
import { type RoleKind } from './permissions.js';
import { type RoleRunFailure, type RoleRunFailurePhase, type RoleRunResult, type RunRoleAgentOptions } from './role-runner.js';
import { type ResearchReviewTools } from './research-tools.js';
import type { AlphaSolveConfig } from './types.js';
import type { PropositionFilenameBuilder, RoleInvocation, RoleInvocationResult, RoleInvoker, WorkflowRole } from './workflow.js';
export declare const SUBAGENT_TOOL_NAME = "alphasolve_subagent";
export declare const CURATOR_TOOL_NAMES: Readonly<{
    readonly read: "alphasolve_curator_read";
    readonly write: "alphasolve_curator_write";
    readonly edit: "alphasolve_curator_edit";
    readonly mkdir: "alphasolve_curator_mkdir";
    readonly rename: "alphasolve_curator_rename";
    readonly move: "alphasolve_curator_move";
    readonly splitReference: "alphasolve_curator_split_reference";
    readonly delete: "alphasolve_curator_delete";
    readonly list: "alphasolve_curator_list";
    readonly glob: "alphasolve_curator_glob";
    readonly grep: "alphasolve_curator_grep";
}>;
export type RoleAgentRunner = (options: RunRoleAgentOptions) => Promise<RoleRunResult>;
export interface RoleTraceEvent {
    readonly kind: 'workflow_role' | 'subagent' | 'research_review';
    readonly role: WorkflowRole | RoleKind;
    readonly task: string;
    readonly text: string;
    readonly stopReason: RoleRunResult['stopReason'];
    readonly steps: number;
    readonly agentId: string;
    readonly workerId?: string;
    readonly parentRole?: WorkflowRole | 'curator';
    /** Present when the runner rejected before producing an ordinary result. */
    readonly phase?: RoleRunFailurePhase;
    readonly error?: RoleTraceError;
    readonly cleanupError?: RoleTraceError;
    readonly turnEndReason?: RoleRunFailure['turnEndReason'];
}
export interface RoleTraceError {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
}
/** Persist a trace and optionally return its workspace-relative artifact path. */
export type RoleTraceHandler = (event: RoleTraceEvent) => string | undefined | Promise<string | undefined>;
export interface AlphaSolveRoleServiceOptions {
    /** The interactive DSH session Agent which owns this AlphaSolve runtime. */
    readonly parent: Agent;
    /** Absolute activated workspace. */
    readonly workspace: string;
    /** Read at every fresh invocation so prompt-time configuration changes apply. */
    readonly getConfig: () => AlphaSolveConfig;
    /** Optional durable trace handoff (normally a curator-queue submitter). */
    readonly onTrace?: RoleTraceHandler;
    /** Test seam; production uses runRoleAgent. */
    readonly runner?: RoleAgentRunner;
}
export interface ResearchReviewRequest {
    readonly signal: AbortSignal;
    readonly prompt?: string;
    readonly workerId?: string;
}
export declare class RoleAgentDidNotCompleteError extends Error {
    readonly label: string;
    readonly result: RoleRunResult;
    constructor(label: string, result: RoleRunResult);
}
/**
 * Session-owned implementation of RoleInvoker and the auxiliary AlphaSolve
 * Agent routes. No Agent or scoped tool is shared between calls.
 */
export declare class AlphaSolveRoleService implements RoleInvoker {
    private readonly parent;
    private readonly workspace;
    private readonly getConfig;
    private readonly onTrace;
    private readonly runner;
    private readonly workerArtifactPaths;
    constructor(options: AlphaSolveRoleServiceOptions);
    private inheritedTarget;
    private target;
    private runWithTrace;
    private recordTrace;
    /** Durable trace paths accumulated for one worker, including helper traces. */
    artifactPaths(workerId: string): readonly string[];
    private workflowPolicy;
    private helperSetup;
    private createSubagentTool;
    invoke(request: RoleInvocation): Promise<RoleInvocationResult>;
    /** No-tool, one-step generator-model route used only to name a verified proposition. */
    readonly buildPropositionFilename: PropositionFilenameBuilder;
    /** Fresh, read-only, non-nesting research review route for the orchestrator. */
    readonly runResearchReview: (request: ResearchReviewRequest) => Promise<string>;
    private curatorTaskPrompt;
    /** DurableCurator-compatible runner; it deliberately never traces itself. */
    readonly runCurator: CuratorRunner;
}
/** Build the two AlphaSolve-main research navigation tools for one reviewer. */
export declare function createResearchReviewToolDefinitions(tools: ResearchReviewTools): readonly ToolDefinition[];
/** Build the no-shell, knowledge-only tool surface for one curator invocation. */
export declare function createCuratorTools(tools: CuratorKnowledgeTools): readonly ToolDefinition[];
//# sourceMappingURL=role-service.d.ts.map