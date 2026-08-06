export type VerifierVerdict = "pass" | "fail";
export interface ExternalReferenceParenthetical {
    lineNumber: number;
    parenthetical: string;
}
/**
 * Parse the output of AlphaSolve's independent verifier-verdict judge.
 *
 * The original implementation is intentionally fail-closed: an empty or
 * ambiguous answer, including one that contains both words, is a failure.
 */
export declare function parseVerifierVerdict(text: string | null | undefined): VerifierVerdict;
/** Return true only when the theorem-checker answer contains AlphaSolve's yes marker. */
export declare function solvesOriginalProblem(text: string | null | undefined): boolean;
/**
 * Extract the Statement section for the compact worker-completion summary.
 *
 * This preserves the slightly unusual leading newline of AlphaSolve main so
 * existing result rendering does not silently change during the port.
 */
export declare function extractStatement(text: string, limit?: number): string;
/**
 * Sanitize the filename-only answer from AlphaSolve's proposition namer.
 * The caller may supply a deterministic fallback id for tests and recovery.
 */
export declare function parsePropositionFilename(text: string | null | undefined, fallbackId?: string): string;
/**
 * Detect likely author/year or title/year parentheticals for the citation
 * verifier. This is only a triage hint; it never accepts or rejects a proof.
 */
export declare function findExternalReferenceParentheticals(text: string): ExternalReferenceParenthetical[];
//# sourceMappingURL=parsers.d.ts.map