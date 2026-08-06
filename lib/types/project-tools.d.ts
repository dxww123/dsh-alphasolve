/** Safe project-organization tools temporarily exposed to the AlphaSolve orchestrator. */
export declare const VERIFIED_DIRECTORY_PATH_PATTERN: string;
export declare const VERIFIED_SUBDIRECTORY_PATH_PATTERN: string;
export declare const VERIFIED_MARKDOWN_PATH_PATTERN: string;
export declare const VERIFIED_RENAME_NAME_PATTERN: string;
export declare const PROJECT_TOOL_NAMES: Readonly<{
    readonly mkdir: "alphasolve_mkdir";
    readonly rename: "alphasolve_rename";
    readonly move: "alphasolve_move";
}>;
export interface ProjectMoveResult {
    readonly oldPath: string;
    readonly path: string;
    /** Number of Markdown files whose proposition references changed. */
    readonly updatedReferenceFiles: number;
}
export interface ProjectToolsOptions {
    /** Injection seam for transactional failure tests and host-owned atomic IO. */
    readonly writeText?: (absolutePath: string, content: string) => Promise<void>;
}
/** A project-tool rejection whose message is safe to return to the orchestrator. */
export declare class ProjectToolError extends Error {
    readonly path?: string | undefined;
    constructor(message: string, path?: string | undefined, options?: ErrorOptions);
}
/**
 * Orchestrator-only organization operations.
 *
 * The class intentionally has no general write/delete-file primitive. A
 * caller can organize existing research, but cannot promote a knowledge note
 * into verified_propositions or fabricate a new verified proposition.
 */
export declare class AlphaSolveProjectTools {
    readonly workspaceRoot: string;
    private readonly knowledgeRoot;
    private readonly referencesRoot;
    private readonly verifiedRoot;
    private readonly writeText;
    private constructor();
    static create(workspaceRoot: string, options?: ProjectToolsOptions): Promise<AlphaSolveProjectTools>;
    private nearestExisting;
    /** Reject every symlink component; this closes both escape and alias races. */
    private assertNoSymlinkComponents;
    private resolve;
    private rejectReferences;
    private rejectRoot;
    private rejectProtected;
    private ensureDirectory;
    /** Recursively create only the requested directory chain below one allowed root. */
    mkdir(relativePath: string): Promise<{
        readonly path: string;
    }>;
    private walkMarkdown;
    private buildReferenceUpdates;
    private rollbackMove;
    private writeReferenceUpdate;
    /**
     * Move or rename an existing file/directory to an explicit new path.
     * Cross-root moves are forbidden, so knowledge can never masquerade as a
     * verified proposition.
     */
    private move;
    /** AlphaSolve-compatible in-place rename convenience. */
    rename(directory: string, oldName: string, newName: string): Promise<ProjectMoveResult>;
    /** AlphaSolve-compatible move which preserves the source file name. */
    moveInto(sourcePath: string, destinationDirectory: string): Promise<ProjectMoveResult>;
}
export { AlphaSolveProjectTools as ProjectTools };
export declare function createProjectTools(workspaceRoot: string, options?: ProjectToolsOptions): Promise<AlphaSolveProjectTools>;
//# sourceMappingURL=project-tools.d.ts.map