/** Filesystem primitives exposed to the AlphaSolve curator role. */
import { type CuratorTaskKind } from './types.js';
export interface CuratorReadResult {
    readonly path: string;
    readonly content: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly totalLines: number;
}
export interface CuratorDirectoryEntry {
    readonly path: string;
    readonly type: 'file' | 'directory' | 'symlink' | 'other';
}
export interface CuratorGrepMatch {
    readonly path: string;
    readonly line: number;
    readonly text: string;
}
export interface ReferencePart {
    /** New workspace-relative Markdown path below knowledge/references. */
    readonly path: string;
    /** Inclusive, one-based line number. */
    readonly startLine: number;
    /** Inclusive, one-based line number. */
    readonly endLine: number;
}
/** A curator-tool rejection whose message is safe to show to the role agent. */
export declare class CuratorToolError extends Error {
    readonly path?: string | undefined;
    constructor(message: string, path?: string | undefined, options?: ErrorOptions);
}
/**
 * Dedicated knowledge-only tools for a single curator task.
 *
 * There is deliberately no process/shell primitive. All mutating operations
 * validate both the requested path and its canonical ancestry immediately
 * before touching the filesystem.
 */
export declare class CuratorKnowledgeTools {
    readonly workspaceRoot: string;
    readonly taskKind: CuratorTaskKind;
    readonly taskId: string;
    private readonly knowledgeRoot;
    private readonly referencesRoot;
    private readonly journalPath;
    private readonly journal;
    /** DSH-style per-role observed versions used to reject blind/stale rewrites. */
    private readonly observed;
    /** Successful curator mutations whose ordinary-entry metadata is finalized once. */
    private readonly touchedPaths;
    private metadataFinalized;
    private operationCursor;
    private constructor();
    static create(workspaceRoot: string, taskKind: CuratorTaskKind, taskId?: string): Promise<CuratorKnowledgeTools>;
    private nearestExisting;
    private resolve;
    private rejectFinalSymlink;
    private rejectReferenceMutation;
    private rejectProtectedMutation;
    private requireOrdinaryFile;
    private requireMarkdown;
    private observe;
    private assertObserved;
    private recordTouch;
    private persistJournal;
    private stateDigestAbsolute;
    private stateDigest;
    private beginMutation;
    private currentDigest;
    private validateAppliedReplay;
    private resumeMutation;
    private prepareMutation;
    private observeMutationFile;
    /**
     * Apply AlphaSolve main's system-owned modification counter after one
     * curator task succeeds. Human references and routing/protected files keep
     * their exact text and never receive this frontmatter.
     */
    finalizeMetadata(): Promise<void>;
    private ensureDirectory;
    read(relativePath: string, options?: {
        readonly startLine?: number;
        readonly endLine?: number;
    }): Promise<CuratorReadResult>;
    write(relativePath: string, content: string, options?: {
        readonly mode?: 'overwrite' | 'append';
    }): Promise<{
        readonly path: string;
    }>;
    edit(relativePath: string, oldText: string, newText: string): Promise<{
        readonly path: string;
    }>;
    mkdir(relativePath: string): Promise<{
        readonly path: string;
    }>;
    rename(directory: string, oldName: string, newName: string): Promise<{
        readonly path: string;
    }>;
    move(relativePath: string, destinationDirectory: string): Promise<{
        readonly path: string;
    }>;
    splitReference(sourcePath: string, parts: readonly ReferencePart[]): Promise<{
        readonly paths: readonly string[];
    }>;
    delete(relativePath: string): Promise<{
        readonly path: string;
    }>;
    list(relativePath?: string): Promise<readonly CuratorDirectoryEntry[]>;
    private walk;
    glob(pattern: string): Promise<readonly string[]>;
    grep(query: string, options?: {
        readonly path?: string;
        readonly caseSensitive?: boolean;
        readonly maxResults?: number;
    }): Promise<readonly CuratorGrepMatch[]>;
}
export declare function createCuratorKnowledgeTools(workspaceRoot: string, taskKind: CuratorTaskKind, taskId?: string): Promise<CuratorKnowledgeTools>;
//# sourceMappingURL=curator-tools.d.ts.map