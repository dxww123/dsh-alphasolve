import type { Context } from '@deepseek-ai/cordis';
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools';
/** Agent roles which receive an AlphaSolve-scoped filesystem view. */
export type RoleKind = 'orchestrator' | 'generator' | 'verifier' | 'verifier_citation' | 'reviser' | 'theorem_checker' | 'curator' | 'curator_helper' | 'compute' | 'numerical_experiment' | 'research_reviewer' | 'reasoning';
export type PathAccess = 'read' | 'write';
export interface PathPermissionRule {
    /** Absolute file or directory path. */
    readonly root: string;
    readonly kind: 'file' | 'directory';
    readonly access: readonly PathAccess[];
    /** Denials take precedence over grants, including through symlink aliases. */
    readonly effect?: 'allow' | 'deny';
    /** Optional POSIX-relative path constraint below a directory root. */
    readonly relativePattern?: RegExp;
}
export interface RolePermissionPolicy {
    readonly role: RoleKind;
    readonly cwd: string;
    /** Includes standard global tools and scoped helper tools permitted for the role. */
    readonly allowedTools: ReadonlySet<string>;
    readonly paths: readonly PathPermissionRule[];
}
export interface RolePolicyScope {
    readonly workspace: string;
    readonly workerDirectory?: string;
    readonly propositionFile?: string;
    readonly theoremViewDirectory?: string;
    readonly knowledgeDirectory?: string;
    readonly verifiedDirectory?: string;
    /** Read-only roots explicitly delegated to an auxiliary role. */
    readonly delegatedReadRoots?: readonly string[];
    /** Names of role-scoped helper tools installed by the workflow. */
    readonly extraAllowedTools?: readonly string[];
}
export interface CanonicalPathAccess {
    readonly requestedPath: string;
    readonly lexicalPath: string;
    readonly canonicalPath: string;
    readonly matchedRule: PathPermissionRule;
}
/** AlphaSolve main permits orchestrator Write/Edit only for per-directory indexes. */
export declare const ORCHESTRATOR_INDEX_PATH_PATTERN: string;
/** Exact names known to provide process, code, generic delegation, or network access. */
export declare const FORBIDDEN_ROLE_TOOLS: ReadonlySet<string>;
/**
 * Materialize the filesystem/tool policy for one fresh role agent.
 *
 * Auxiliary roles intentionally receive no ambient workspace access: their
 * caller must pass the roots which are safe for that particular delegation.
 */
export declare function createRolePolicy(role: RoleKind, scope: RolePolicyScope): RolePermissionPolicy;
/** Treat both POSIX and Windows path syntax as path syntax on every platform. */
export declare function normalizeUserPath(candidate: string): string;
export interface ToolPathRequest {
    readonly path: string;
    readonly access: PathAccess;
}
/** Extract the standard DSH filesystem path without interpreting helper tools. */
export declare function toolPathRequest(execution: Pick<ToolExecution, 'name' | 'arguments'>): ToolPathRequest | undefined;
/** Validate a tool path without touching the filesystem; suitable for tools.guard(). */
export declare function assertLexicalPathAccess(policy: RolePermissionPolicy, requestedPath: string, access: PathAccess): string;
/**
 * Resolve an existing path, or the nearest existing ancestor of a create target.
 * This detects a symlink in every existing component without requiring the leaf
 * to exist yet.
 */
export declare function canonicalizePotentialPath(candidate: string): Promise<string>;
/** Resolve symlinks in both the requested path and grants, then re-check access. */
export declare function assertCanonicalContainment(policy: RolePermissionPolicy, requestedPath: string, access: PathAccess): Promise<CanonicalPathAccess>;
export declare function isForbiddenRoleTool(name: string): boolean;
/** Final synchronous policy boundary which later waterfall listeners cannot override. */
export declare function createLexicalToolGuard(policy: RolePermissionPolicy, ownsScopedGlob?: (execution: ToolExecution) => boolean): ToolGuard;
/**
 * Install both lexical and canonical checks into one Agent scope.
 *
 * Custom helper tools remain responsible for calling
 * assertCanonicalContainment for each path they accept; only the five standard
 * DSH filesystem tools have a common argument contract here.
 */
export declare function installRolePermissionBoundary(ctx: Context, policy: RolePermissionPolicy, agent?: ToolExecution['agent']): () => void;
//# sourceMappingURL=permissions.d.ts.map