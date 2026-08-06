export declare const VERIFIED_REFERENCE_PATTERN: RegExp;
export type SolutionAssemblyErrorCode = "invalid-reference" | "path-escape" | "missing-proposition" | "not-a-file" | "cyclic-reference" | "unsafe-verified-root" | "cross-device-temp";
export declare class SolutionAssemblyError extends Error {
    readonly code: SolutionAssemblyErrorCode;
    readonly details: Readonly<Record<string, string>>;
    constructor(code: SolutionAssemblyErrorCode, message: string, details?: Readonly<Record<string, string>>);
}
export interface OrderedProposition {
    /** Backslash-free, extension-free path relative to verified_propositions. */
    label: string;
    path: string;
    content: string;
}
export interface AssembleSolutionOptions {
    problemText: string;
    verifiedDir: string;
    finalPropositionPath: string;
}
export interface AssembledSolution {
    text: string;
    propositions: readonly OrderedProposition[];
}
export interface AtomicWriteOptions {
    /** Must be on the same filesystem as targetPath. */
    tempDir?: string;
    /** Rename over an existing target. Preflight must have authorized/backed it up. */
    replaceExisting?: boolean;
}
export interface WriteSolutionOptions extends AssembleSolutionOptions, AtomicWriteOptions {
    solutionPath: string;
}
export interface WrittenSolution extends AssembledSolution {
    solutionPath: string;
}
/**
 * Convert AlphaSolve's backslash citation syntax into a canonical POSIX label.
 * No filesystem lookup happens here.
 */
export declare function normalizeVerifiedReference(rawReference: string): string;
/** Extract unique references in first-appearance order. */
export declare function extractVerifiedReferences(text: string): string[];
/**
 * Assemble solution.md in memory. It performs a fail-closed DFS and returns
 * dependencies before the propositions that cite them.
 */
export declare function assembleSolution(options: AssembleSolutionOptions): Promise<AssembledSolution>;
/**
 * Write a complete text file atomically using a same-filesystem temporary.
 * With replaceExisting=false, hard-link publication makes EEXIST fail closed.
 */
export declare function writeTextAtomically(targetPath: string, text: string, options?: AtomicWriteOptions): Promise<string>;
/** Assemble, validate, and atomically publish solution.md. */
export declare function writeSolutionAtomically(options: WriteSolutionOptions): Promise<WrittenSolution>;
//# sourceMappingURL=solution.d.ts.map