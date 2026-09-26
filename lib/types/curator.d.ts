/** Durable, single-consumer curator queue. */
import { type CuratorKnowledgeTools } from './curator-tools.js';
import { type CuratorTask, type CuratorTaskKind } from './types.js';
export interface CuratorTaskInput {
    /** Optional caller-owned idempotency key. Generated once when omitted. */
    readonly id?: string;
    readonly kind: CuratorTaskKind;
    readonly sourceWorkerId?: string;
    readonly tracePath?: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
export interface CuratorRunnerContext {
    readonly task: CuratorTask;
    readonly tools: CuratorKnowledgeTools;
    /** Aborted only when the bounded shutdown drain expires. */
    readonly signal: AbortSignal;
}
export type CuratorRunner = (context: CuratorRunnerContext) => Promise<void>;
export interface DurableCuratorOptions {
    readonly workspaceRoot: string;
    /** Runs each durable task serially with task-local tools and a shared curator Session. */
    readonly runner: CuratorRunner;
    readonly idFactory?: () => string;
    readonly now?: () => Date;
    /** Surface a durable task failure to the owning orchestrator. */
    readonly onTaskFailure?: (task: CuratorTask, error: unknown) => void;
    /** Defaults to the AlphaSolve shutdown contract of sixty seconds. */
    readonly drainTimeoutMs?: number;
}
export interface CuratorStopResult {
    readonly drained: boolean;
    readonly pending: number;
    readonly active: number;
    readonly failed: number;
}
/**
 * A durable FIFO which serializes curator role invocations.
 *
 * `open()` immediately starts the consumer. A process restart converts any
 * persisted `active` item back to `pending`, so that the whole idempotent task
 * is replayed from its beginning.
 */
export declare class DurableCurator {
    readonly workspaceRoot: string;
    readonly queuePath: string;
    private tasks;
    private readonly runner;
    private readonly idFactory;
    private readonly now;
    private readonly onTaskFailure;
    private readonly drainTimeoutMs;
    private mutationTail;
    private accepting;
    private timedOut;
    private waiter;
    private activeDispatch;
    private readonly idleWaiters;
    private readonly loopPromise;
    private stopPromise;
    private constructor();
    static open(options: DurableCuratorOptions): Promise<DurableCurator>;
    private exclusive;
    private persist;
    private generateId;
    private wakeConsumer;
    private notifyIdleIfNeeded;
    private digestCountSinceHealthCheck;
    submit(input: CuratorTaskInput): Promise<CuratorTask>;
    private acquireNext;
    private settle;
    private consume;
    /** Return a detached immutable view in durable FIFO order. */
    snapshot(): Promise<readonly CuratorTask[]>;
    /** Wait until the current queue has neither pending nor active work. */
    waitForIdle(): Promise<void>;
    /** Freeze submissions immediately, then drain FIFO work for at most the configured bound. */
    stop(options?: {
        readonly timeoutMs?: number;
    }): Promise<CuratorStopResult>;
    /** Freeze and drain the queue, then await cancellation cleanup before releasing its workspace. */
    close(): Promise<void>;
    private stopOnce;
}
/** Strict read-only recovery probe used before terminal-session teardown. */
export declare function hasRecoverableCuratorTasks(workspace: string): Promise<boolean>;
//# sourceMappingURL=curator.d.ts.map