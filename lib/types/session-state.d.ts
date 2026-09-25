/** AlphaSolve notices and resumable state derived from committed Session events. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
declare const stateSchema: z.ZodObject<{
    pendingCalls: z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodEnum<{
            alphasolve_activate: "alphasolve_activate";
            alphasolve_wait: "alphasolve_wait";
        }>;
        sequence: z.ZodNumber;
    }, z.core.$strip>>;
    latestActivation: z.ZodNumber;
    latestStop: z.ZodNumber;
    successfulWaitCallIds: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
/** Activation ordering and durable acknowledgements needed after a process restart. */
export type AlphaSolveSessionState = z.infer<typeof stateSchema>;
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        alphasolve: {
            readonly kind: 'alphasolve';
        } & ContextFormed;
    }
}
declare module '@deepseek-ai/dsh-session-projection' {
    interface SessionProjectionStateMap {
        alphasolve: AlphaSolveSessionState;
    }
}
/** Session fold for activation authorization and successful wait delivery. */
export declare const alphaSolveSessionProjection: {
    key: "alphasolve";
    stateSchema: z.ZodObject<{
        pendingCalls: z.ZodRecord<z.ZodString, z.ZodObject<{
            name: z.ZodEnum<{
                alphasolve_activate: "alphasolve_activate";
                alphasolve_wait: "alphasolve_wait";
            }>;
            sequence: z.ZodNumber;
        }, z.core.$strip>>;
        latestActivation: z.ZodNumber;
        latestStop: z.ZodNumber;
        successfulWaitCallIds: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    stateVersion: number;
    init: () => {
        pendingCalls: {};
        latestActivation: number;
        latestStop: number;
        successfulWaitCallIds: never[];
    };
    apply: (state: NoInfer<{
        pendingCalls: Record<string, {
            name: "alphasolve_activate" | "alphasolve_wait";
            sequence: number;
        }>;
        latestActivation: number;
        latestStop: number;
        successfulWaitCallIds: string[];
    }>, event: SessionEvent) => {
        pendingCalls: Record<string, {
            name: "alphasolve_activate" | "alphasolve_wait";
            sequence: number;
        }>;
        latestActivation: number;
        latestStop: number;
        successfulWaitCallIds: string[];
    };
};
/** Read the registered AlphaSolve state at this Agent's committed Session cursor.
 * @param agent - live Agent whose Session owns the runtime.
 * @returns current activation and delivery state.
 */
export declare function alphaSolveSessionState(agent: Agent): AlphaSolveSessionState;
/** Decide whether a successful activation has a later explicit stop.
 * @param state - current AlphaSolve Session projection.
 * @returns whether the runtime may attempt same-session restoration.
 */
export declare function hasDurableAlphaSolveResumeIntent(state: AlphaSolveSessionState): boolean;
export {};
//# sourceMappingURL=session-state.d.ts.map