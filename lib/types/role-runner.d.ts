import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import { type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session';
import { type RoleKind, type RolePermissionPolicy } from './permissions.js';
export type RoleRunStopReason = 'completed' | 'max_turns' | 'max_tokens' | 'aborted' | 'blocked' | 'error' | 'disposed' | 'interrupted';
export interface RoleRunResult {
    readonly agentId: ReturnType<typeof SessionId>;
    readonly role: RoleKind;
    /** Last complete assistant message; empty when the role never produced one. */
    readonly output: readonly ContentBlock[];
    /** Text blocks from output joined for AlphaSolve's verdict parsers. */
    readonly text: string;
    readonly stopReason: RoleRunStopReason;
    readonly steps: number;
    readonly turnEndReason?: TurnEndReason;
}
/** Report observable work in a nested helper to its owning role watchdog. */
export type RoleActivityReporter = () => void;
export type RoleRunFailurePhase = 'create' | 'run' | 'inactivity' | 'dispose';
/** Best-effort snapshot emitted before a runner rejects. The original error is rethrown unchanged. */
export interface RoleRunFailure {
    readonly agentId: string;
    readonly role: RoleKind;
    readonly phase: RoleRunFailurePhase;
    readonly output: readonly ContentBlock[];
    readonly text: string;
    readonly steps: number;
    readonly error: unknown;
    readonly cleanupError?: unknown;
    readonly turnEndReason?: TurnEndReason;
}
/** Register role-local helper tools or result-capture listeners before publication. */
export type RoleHelperSetup = (childCtx: Context, child: Agent, reportActivity: RoleActivityReporter) => void | Promise<void>;
export interface RunRoleAgentOptions {
    readonly parent: Agent;
    readonly role: RoleKind;
    /** Absolute workspace/cwd for the fresh child session. */
    readonly cwd: string;
    readonly persona: string;
    readonly prompt: string | readonly ContentBlock[];
    /** Maximum admitted model-request steps across this invocation's turns. */
    readonly maxTurns: number;
    readonly signal: AbortSignal;
    readonly permissionPolicy: RolePermissionPolicy;
    /** Complete resolved route; omission inherits the parent's current request route. */
    readonly modelSelection?: ModelSelection;
    readonly maxTokens?: number;
    /** Inherited file tools retained by tools.restrict; role-local helpers remain visible. */
    readonly allowedInheritedTools?: readonly string[];
    readonly setupHelpers?: RoleHelperSetup;
    /** Propagate nested-role activity to an owning role's inactivity watchdog. */
    readonly onActivity?: RoleActivityReporter;
    /** Internal diagnostic handoff used to persist partial traces on rejection. */
    readonly onFailure?: (failure: RoleRunFailure) => void;
    /** Technical bounds only; they do not impose a total worker wall-clock limit. */
    readonly createTimeoutMs?: number;
    readonly inactivityTimeoutMs?: number;
    readonly disposeTimeoutMs?: number;
}
export declare const ROLE_CREATE_TIMEOUT_MS = 60000;
/** Abort only after one hour without any observable role or nested-helper activity. */
export declare const ROLE_INACTIVITY_TIMEOUT_MS: number;
export declare const ROLE_DISPOSE_TIMEOUT_MS = 15000;
export declare class RoleTechnicalTimeoutError extends Error {
    readonly phase: 'create' | 'inactivity' | 'dispose';
    constructor(phase: 'create' | 'inactivity' | 'dispose', milliseconds: number);
}
/**
 * Run one fresh DSH Agent until idle, including automatic retry turns, with
 * role-scoped prompt, route, tools, path policy, cancellation, and a step cap.
 */
export declare function runRoleAgent(options: RunRoleAgentOptions): Promise<RoleRunResult>;
//# sourceMappingURL=role-runner.d.ts.map