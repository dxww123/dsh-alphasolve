/** AlphaSolve workflow sidebar registration for the Harness desktop and web client. */
import type { Context } from '@deepseek-ai/cordis';
/** Sidebar implementation identity. */
export declare const WORKFLOW_TAB_ID = "@dsh-external/dsh-alphasolve/workflows";
/** Sidebar page kind for the owning main Session. */
export declare const WORKFLOW_TAB_KIND = "alphasolve-workflows";
/** Services required for authenticated workflow reads and native transcript navigation. */
export declare const inject: string[];
/**
 * Register one workflow page per main Session and route roles to Harness transcripts.
 * @param ctx - client root services supplied by Harness.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map