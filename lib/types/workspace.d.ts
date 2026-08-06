/** Canonical workspace validation and AlphaSolve-owned directory initialization. */
import type { FileStamp, InputSnapshot, WorkspaceSnapshot } from './types.js';
/** Error whose message is safe to return in an activation/tool diagnostic. */
export declare class WorkspaceError extends Error {
    readonly path?: string | undefined;
    constructor(message: string, path?: string | undefined, options?: ErrorOptions);
}
/** AlphaSolve-owned paths relative to the immutable workspace root. */
export declare const WORKSPACE_DIRS: readonly ["knowledge", "knowledge/references", "unverified_propositions", "verified_propositions", ".alphasolve", ".alphasolve/workers", ".alphasolve/completions", ".alphasolve/curator", ".alphasolve/traces", ".alphasolve/backups", ".alphasolve/tmp"];
/** Return a SHA-256 digest for immutable-input and conflict checks. */
export declare function digestText(content: string | Uint8Array): string;
/** Whether a canonical candidate is the root itself or a descendant. */
export declare function isContained(root: string, candidate: string): boolean;
/** Normalize an untrusted relative path without accepting either platform's escape syntax. */
export declare function normalizeRelativePath(input: string): string;
/** Canonicalize the session's immutable cwd and require an existing directory. */
export declare function canonicalWorkspace(cwd: string | undefined): Promise<string>;
/**
 * Resolve a relative workspace path and reject lexical and symlink escapes.
 * Missing final components are allowed only when `mustExist` is false.
 */
export declare function resolveWorkspacePath(root: string, input: string, options: {
    readonly mustExist: boolean;
}): Promise<string>;
/** Read one safe ordinary UTF-8 file and compute its digest. */
export declare function readWorkspaceInput(root: string, relativePath: string, options: {
    readonly nonEmpty: boolean;
}): Promise<InputSnapshot>;
/** Test for a safe existing workspace file; missing is false and all other failures are loud. */
export declare function workspaceFileExists(root: string, relativePath: string): Promise<boolean>;
/** Validate the three activation-time inputs without changing the workspace. */
export declare function snapshotWorkspace(cwd: string | undefined): Promise<WorkspaceSnapshot>;
/** Create all AlphaSolve-owned directories and non-destructive knowledge skeleton files. */
export declare function initializeWorkspace(root: string): Promise<void>;
/** Atomically preserve an existing solution before an explicitly authorized overwrite. */
export declare function backupSolution(root: string, now?: Date): Promise<string | undefined>;
/** Capture an active proposition's identity for fail-closed external-edit detection. */
export declare function captureFileStamp(root: string, relativePath: string): Promise<FileStamp>;
/** Reject an active proposition that changed outside the role which owned it. */
export declare function assertFileStamp(root: string, relativePath: string, expected: FileStamp): Promise<void>;
//# sourceMappingURL=workspace.d.ts.map