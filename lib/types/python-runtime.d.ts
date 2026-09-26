import type { Context } from '@deepseek-ai/cordis';
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
/** Native tool exposed only to AlphaSolve computation helpers. */
export declare const PYTHON_TOOL_NAME = "alphasolve_python";
/** Deployment-owned Python limits; model calls supply only code. */
export interface PythonOptions {
    readonly executable: string;
    readonly timeoutMs: number;
    readonly maxOutputChars: number;
    readonly maxCodeChars: number;
    readonly graceMs: number;
}
/** Optional deployment overrides resolved before a helper starts. */
export type PythonConfig = Partial<PythonOptions>;
/**
 * Resolve the dedicated venv and validate every configured execution limit.
 * @param input Deployment overrides; omission selects the managed Python environment.
 * @returns Fully specified executable and bounded execution limits.
 */
export declare function resolvePythonOptions(input?: PythonConfig): PythonOptions;
/** Canonical text produced by one Python call; values remain inside the interpreter. */
export interface PythonResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly result: string;
    readonly truncated: boolean;
    readonly sympyVersion: string;
}
/** One process and namespace per helper; cancellation and disposal await process-range exit. */
export declare class PythonSession {
    private readonly subprocess;
    private readonly sandbox;
    private readonly options;
    private current;
    private closed;
    private busy;
    private nextId;
    private active;
    private abortActive;
    private disposing;
    constructor(subprocess: SubprocessRuntime, sandbox: SandboxProvider, options: PythonOptions);
    private fail;
    private receive;
    private start;
    private stop;
    /**
     * Run one snippet; ordinary Python exceptions retain variables, infrastructure failures reset them.
     * @param code Python source evaluated in this helper's persistent namespace.
     * @param signal Cancellation ends the interpreter and discards its namespace.
     * @returns Bounded captured text and the final expression; Python errors reject.
     */
    execute(code: string, signal: AbortSignal): Promise<PythonResult>;
    private run;
    /**
     * Close idle or running Python and wait for its process and temporary directory cleanup.
     * @returns A shared promise that settles after cleanup.
     */
    dispose(): Promise<void>;
}
/**
 * Register Python only in the caller's helper scope; the returned disposer owns its interpreter.
 * @param ctx Helper context with Harness tool, subprocess, and sandbox services.
 * @param options Fully resolved deployment limits.
 * @returns Disposer that unregisters the tool and joins its interpreter.
 */
export declare function installPythonTool(ctx: Context, options: PythonOptions): () => Promise<void>;
//# sourceMappingURL=python-runtime.d.ts.map