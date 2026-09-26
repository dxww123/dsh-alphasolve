/** Atomic, session-owned observations of workers and their real role Sessions. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RoleRunStopReason } from './role-runner.js';
import type { WorkerRecord } from './types.js';
import { type AlphaSolveRoleIdentity } from './workflow-view.js';
export type { AlphaSolveWorkflowView, AlphaSolveWorkerView, AlphaSolveRoleRunView } from './workflow-view.js';
/** Lifecycle sink supplied to the low-level role runner. */
export interface RoleRunObservation {
    readonly label: string;
    started(child: Agent): Promise<void>;
    progress(sessionId: string, steps: number): void;
    finished(sessionId: string, status: RoleRunStopReason, steps: number, error?: string): Promise<void>;
}
/** Serialize complete index snapshots so concurrent workers cannot overwrite each other. */
export declare class AlphaSolveWorkflowObserver {
    private readonly file;
    private view;
    private readonly onError;
    private pending;
    private constructor();
    /** Load an index, preserving completed history and interrupting crash-left active work. */
    static open(workspace: string, sessionId: string, onError: (error: unknown) => void): Promise<AlphaSolveWorkflowObserver>;
    /** Record a snapshot only after its worker ledger write succeeds. */
    worker(record: WorkerRecord): Promise<void>;
    /** Create a per-invocation recorder; helpers retain their actual parent Session. */
    role(identity: AlphaSolveRoleIdentity): RoleRunObservation;
    private writeRun;
    private persist;
}
//# sourceMappingURL=workflow-observation.d.ts.map