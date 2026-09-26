import { SessionId } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import type { RoleSessionContinuation } from './role-runner.js';
/** Archived with the generation when AlphaSolve changes problems. */
export declare const CURATOR_SESSION_PATH = ".alphasolve/curator/session.json";
declare const identitySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    parentSessionId: z.ZodString;
    sessionId: z.ZodUUID;
    problemDigest: z.ZodString;
}, z.core.$strict>;
/** Read and validate the optional curator identity before use or generation archival. */
export declare function readCuratorSessionIdentity(workspace: string): Promise<z.infer<typeof identitySchema> | undefined>;
/**
 * Select the stored curator log, without replacing missing or corrupt Harness history.
 * @param workspace Canonical workspace under the AlphaSolve runtime lock.
 * @param parentSessionId Main Session that owns this curator.
 * @returns Fresh or resume identity; ready records it after the log's durability barrier.
 */
export declare function prepareCuratorSession(workspace: string, parentSessionId: SessionId): Promise<RoleSessionContinuation>;
export {};
//# sourceMappingURL=curator-session.d.ts.map