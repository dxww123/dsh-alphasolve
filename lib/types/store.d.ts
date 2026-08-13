/** Durable AlphaSolve state, worker records, and exactly-once completion ledger. */
import { type SessionState, type WorkerCompletion, type WorkerRecord } from './types.js';
/** Parse persisted session state and reject corruption or a future format. */
export declare function parseSessionState(value: Record<string, unknown>, path: string): SessionState;
/** Parse enough completion fields to make wait delivery fail closed. */
export declare function parseCompletion(value: Record<string, unknown>, path: string): WorkerCompletion;
/** Parse a worker snapshot strictly before recovery mutates or reports it. */
export declare function parseWorkerRecord(value: Record<string, unknown>, path: string): WorkerRecord;
/** Persistent storage owned by one locked AlphaSolve session runtime. */
export declare class RuntimeStore {
    readonly workspace: string;
    private readonly mutex;
    private readonly statePath;
    private readonly workerDir;
    private readonly completionDir;
    private state;
    constructor(workspace: string);
    /** Initialize fresh state or load and reconcile an interrupted state. */
    open(initial: SessionState): Promise<{
        readonly state: SessionState;
        readonly resumed: boolean;
    }>;
    /** Return the in-memory state only after {@link open}. */
    currentState(): SessionState;
    /** Atomically update the session state inside this runtime. */
    updateState(update: (state: SessionState) => SessionState): Promise<SessionState>;
    /** Persist a complete worker snapshot. */
    writeWorker(record: WorkerRecord): Promise<void>;
    private traceManifestPath;
    /** Append one already-persisted trace path to a durable per-worker manifest. */
    appendWorkerTracePath(workerId: string, tracePath: string): Promise<void>;
    /** Read the durable trace manifest used by normal completion and crash recovery. */
    listWorkerTracePaths(workerId: string): Promise<readonly string[]>;
    /**
     * Convert crash-left worker snapshots into interrupted terminal records and
     * publish any terminal record whose completion write never happened.
     */
    recoverInterruptedWorkers(): Promise<WorkerCompletion[]>;
    /**
     * Strictly read every worker snapshot without applying recovery mutations.
     * Generation archival calls this before moving any durable ledger so a
     * malformed entry can never be silently hidden in a backup.
     */
    validateWorkers(): Promise<WorkerRecord[]>;
    /**
     * Reconcile the crash windows around a provisional winner claim.
     *
     * A solution is terminal only when both the unique durable winner
     * completion and the atomically-published complete solution are present.
     * A claim (including the earlier state=solved-before-completion window) with
     * no winner completion is provisional and is cleared so a fresh worker can
     * win. Conversely, a completion written just before a state update repairs
     * state to solved. A winner completion whose solution disappeared is
     * durable corruption and must fail closed rather than be delivered as
     * solved or silently rewritten.
     */
    reconcileSolvedTerminal(solutionComplete: boolean): Promise<WorkerCompletion | undefined>;
    /** Assign a durable sequence and publish a worker completion before notifying waiters. */
    recordCompletion(completion: Omit<WorkerCompletion, 'version' | 'sequence'>): Promise<WorkerCompletion>;
    private readCompletionsUnlocked;
    /** List all completion ledger entries in publication order. */
    listCompletions(): Promise<WorkerCompletion[]>;
    /** Reserve every currently undelivered completion for one wait tool call. */
    reserveUndelivered(callId: string): Promise<WorkerCompletion[]>;
    /** Commit delivery only after DSH records the authoritative tool result. */
    commitDelivery(callId: string): Promise<void>;
    /** Release a wait reservation whose result never reached the durable session. */
    releaseReservation(callId: string): Promise<void>;
    /** Reconcile crash-stuck reservations against tool results already present in the session log. */
    recoverReservations(committedCallIds: ReadonlySet<string>): Promise<void>;
}
//# sourceMappingURL=store.d.ts.map