/** Browser-safe AlphaSolve workflow overview schema and index path. */

import { z } from 'zod'
import { VERIFIER_PROFILES } from './types.js'

const workerSchema = z.object({
  id: z.string().min(1), instruction: z.string().optional(),
  phase: z.enum(['created', 'generator', 'verifier', 'reviser', 'theorem_checker', 'arbitrating', 'promoting', 'complete']),
  round: z.number().int().nonnegative(), verifierProfile: z.enum(VERIFIER_PROFILES).optional(),
  theoremChecks: z.number().int().nonnegative(),
  terminalStatus: z.enum(['verified', 'solved', 'rejected', 'failed', 'cancelled', 'interrupted', 'stale_problem', 'write_conflict', 'discarded_after_solution']).optional(),
  updatedAt: z.iso.datetime(), reason: z.string().optional(),
}).strict()
const runSchema = z.object({
  sessionId: z.string().min(1), parentSessionId: z.string().min(1), workerId: z.string().min(1).optional(), role: z.string().min(1),
  workflowRound: z.number().int().nonnegative().optional(), verifierProfile: z.enum(VERIFIER_PROFILES).optional(),
  verifierAttempt: z.number().int().positive().optional(), theoremAttempt: z.number().int().positive().optional(),
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['running', 'completed', 'max_turns', 'max_tokens', 'aborted', 'blocked', 'error', 'disposed', 'interrupted']),
  steps: z.number().int().nonnegative(), error: z.string().optional(),
}).strict()
const viewSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1), workers: z.array(workerSchema), runs: z.array(runSchema),
}).strict().superRefine((view, context) => {
  const workers = new Set<string>()
  for (const worker of view.workers) {
    if (workers.has(worker.id)) context.addIssue({ code: 'custom', message: 'duplicate worker id' })
    workers.add(worker.id)
  }
  const parents = new Map<string, string>()
  for (const run of view.runs) {
    if (parents.has(run.sessionId)) context.addIssue({ code: 'custom', message: 'duplicate role Session id' })
    if (run.sessionId === view.sessionId) context.addIssue({ code: 'custom', message: 'a role cannot be the owning main Session' })
    parents.set(run.sessionId, run.parentSessionId)
  }
  for (const run of view.runs) {
    const visited = new Set<string>([run.sessionId])
    let parent: string | undefined = run.parentSessionId
    while (parent !== undefined) {
      if (visited.has(parent)) {
        context.addIssue({ code: 'custom', message: 'role Session ancestry contains a cycle' })
        break
      }
      visited.add(parent)
      parent = parents.get(parent)
    }
  }
})

/** One worker's durable progress, independent of its individual role Sessions. */
export type AlphaSolveWorkerView = z.infer<typeof workerSchema>
/** One real role Session, retained after its live Agent has been disposed. */
export type AlphaSolveRoleRunView = z.infer<typeof runSchema>
/** Complete overview exposed to the desktop's AlphaSolve panel. */
export type AlphaSolveWorkflowView = z.infer<typeof viewSchema>
/** Role identity captured before a fresh Session starts. */
export type AlphaSolveRoleIdentity = Pick<AlphaSolveRoleRunView,
  'role' | 'workerId' | 'workflowRound' | 'verifierProfile' | 'verifierAttempt' | 'theoremAttempt'>

/** Relative workspace path of one main Session's workflow index. */
export function alphaSolveWorkflowPath(sessionId: string): string {
  return `.alphasolve/workflows/${encodeURIComponent(sessionId)}.json`
}

/** Validate a durable workflow index before rendering its navigation targets. */
export function parseAlphaSolveWorkflowView(value: unknown): AlphaSolveWorkflowView {
  return viewSchema.parse(value)
}
