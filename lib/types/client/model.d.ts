/** Workflow grouping and native transcript addresses for the client. */
import type { AlphaSolveRoleRunView, AlphaSolveWorkerView, AlphaSolveWorkflowView } from '../workflow-view.js';
/** A real role session with its own delegated helper sessions. */
export interface RoleRunNode {
    readonly run: AlphaSolveRoleRunView;
    readonly children: readonly RoleRunNode[];
}
/** Chronological role sessions in one workflow round. */
export interface WorkflowRoundGroup {
    readonly round: number | undefined;
    readonly runs: readonly RoleRunNode[];
}
/** A worker workflow, or auxiliary sessions outside a worker. */
export interface WorkflowGroup {
    readonly id: string | undefined;
    readonly worker: AlphaSolveWorkerView | undefined;
    readonly rounds: readonly WorkflowRoundGroup[];
}
/**
 * Group actual sessions by worker and round, retaining helper parentage.
 * @param view - validated index, including completed sessions.
 * @returns workers in creation order, followed by auxiliary role sessions.
 */
export declare function groupWorkflows(view: AlphaSolveWorkflowView): WorkflowGroup[];
/**
 * Address a role transcript in the existing Harness sidebar conversation.
 * @param run - real session and its direct parent.
 * @returns native one-shot conversation resource address.
 */
export declare function roleTranscriptAddress(run: AlphaSolveRoleRunView): string;
//# sourceMappingURL=model.d.ts.map