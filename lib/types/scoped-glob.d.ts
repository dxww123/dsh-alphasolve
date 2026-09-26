import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/** Filesystem policy applied before searching roots and before publishing each path. */
export interface ScopedGlobAccess {
    readonly cwd: string;
    roots(base: string): readonly string[];
    assertRoot(root: string): Promise<void>;
    canRead(file: string): Promise<boolean>;
}
/** Wrap the preset's glob tool without changing its result schema or UI presentation. */
export declare function createScopedGlobTool(inherited: ToolDefinition, access: ScopedGlobAccess): ToolDefinition;
//# sourceMappingURL=scoped-glob.d.ts.map