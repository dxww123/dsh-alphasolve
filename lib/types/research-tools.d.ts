/** Read-only Markdown navigation helpers for the AlphaSolve research reviewer. */
export declare const RESEARCH_REVIEW_TOOL_NAMES: Readonly<{
    readonly progress: "alphasolve_research_progress_review";
    readonly inspectMarkdown: "alphasolve_inspect_markdown";
}>;
export interface MarkdownReviewEntry {
    readonly path: string;
    readonly headings: readonly string[];
    readonly statementOrProgress: string;
    readonly tail: string;
    readonly totalLines: number;
}
export interface ResearchProgressResult {
    readonly files: readonly MarkdownReviewEntry[];
    readonly scanned: number;
    readonly truncated: boolean;
    readonly suggestedInspectionPaths: readonly string[];
}
export interface InspectMarkdownOptions {
    readonly maxFiles?: number;
    readonly tailLines?: number;
    readonly statementLines?: number;
}
/** Hard cap for the complete JSON result returned by progressReview. */
export declare const RESEARCH_PROGRESS_CHARACTER_BUDGET = 24000;
/** Normal broad-workspace target count before the global budget is applied. */
export declare const RESEARCH_PROGRESS_DEFAULT_CANDIDATES = 16;
/** Scans no path outside the research reviewer's frozen read boundary. */
export declare class ResearchReviewTools {
    readonly workspaceRoot: string;
    private constructor();
    static create(workspace: string): Promise<ResearchReviewTools>;
    private collect;
    /** Share broad scan capacity across roots so one large tree cannot hide the others. */
    private collectProgress;
    inspectMarkdown(requestedPath?: string, options?: InspectMarkdownOptions): Promise<ResearchProgressResult>;
    progressReview(options?: {
        readonly path?: string;
        readonly paths?: readonly string[];
        readonly maxFiles?: number;
    }): Promise<ResearchProgressResult>;
}
export declare function createResearchReviewTools(workspace: string): Promise<ResearchReviewTools>;
//# sourceMappingURL=research-tools.d.ts.map