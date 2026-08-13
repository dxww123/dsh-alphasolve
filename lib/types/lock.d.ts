/** Cross-session and cross-process ownership lock for one canonical workspace. */
declare const LOCK_VERSION: 2;
interface LockRecordBase {
    readonly pid: number;
    readonly sessionId: string;
    readonly token: string;
    readonly workspace: string;
    readonly acquiredAt: string;
}
interface LinuxProcessIdentity {
    /** Linux kernel boot identity, so start ticks cannot match across reboots. */
    readonly bootId: string;
    /** Field 22 from /proc/<pid>/stat, expressed as a decimal string. */
    readonly startTimeTicks: string;
}
interface LockRecord extends LockRecordBase {
    readonly version: typeof LOCK_VERSION;
    /** Null only when the host cannot expose an exact process identity. */
    readonly processIdentity: LinuxProcessIdentity | null;
}
/** A live session already owns this canonical project directory. */
export declare class WorkspaceBusyError extends Error {
    readonly owner: LockRecord;
    constructor(owner: LockRecord);
}
/** A lock exists but cannot be trusted or recovered automatically. */
export declare class WorkspaceLockError extends Error {
    readonly path: string;
    constructor(message: string, path: string, options?: ErrorOptions);
}
/** Conservatively decide whether the recorded process still exists. */
export declare function isProcessAlive(pid: number): boolean;
/** Test helper: pause stale recovery after unlinking the old source inode. */
export declare function setStaleSourceUnlinkedHookForTest(hook: (() => Promise<void> | void) | undefined): void;
/** Exact lock ownership returned to one session runtime. */
export interface WorkspaceLock {
    readonly workspace: string;
    readonly sessionId: string;
    readonly token: string;
    readonly path: string;
    assertOwned(): Promise<void>;
    release(): Promise<void>;
}
/** Acquire the one-session-per-canonical-directory lock, recovering dead owners only. */
export declare function acquireWorkspaceLock(workspace: string, sessionId: string): Promise<WorkspaceLock>;
/** Test helper: expose only whether a canonical workspace is locally owned. */
export declare function isWorkspaceOwnedInProcess(workspace: string): boolean;
export {};
//# sourceMappingURL=lock.d.ts.map