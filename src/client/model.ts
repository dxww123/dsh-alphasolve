/** Workflow grouping and native transcript addresses for the client. */
import type { AlphaSolveRoleRunView, AlphaSolveWorkerView, AlphaSolveWorkflowView } from '../workflow-view.js'

/** A real role session with its own delegated helper sessions. */
export interface RoleRunNode {
  readonly run: AlphaSolveRoleRunView
  readonly children: readonly RoleRunNode[]
}

/** Chronological role sessions in one workflow round. */
export interface WorkflowRoundGroup {
  readonly round: number | undefined
  readonly runs: readonly RoleRunNode[]
}

/** A worker workflow, or auxiliary sessions outside a worker. */
export interface WorkflowGroup {
  readonly id: string | undefined
  readonly worker: AlphaSolveWorkerView | undefined
  readonly rounds: readonly WorkflowRoundGroup[]
}

/**
 * Group actual sessions by worker and round, retaining helper parentage.
 * @param view - validated index, including completed sessions.
 * @returns workers in creation order, followed by auxiliary role sessions.
 */
export function groupWorkflows(view: AlphaSolveWorkflowView): WorkflowGroup[] {
  const nodes = new Map(view.runs.map(run => [run.sessionId, { run, children: [] as RoleRunNode[] }]))
  const roots: RoleRunNode[] = []
  for (const node of nodes.values()) {
    const parent = nodes.get(node.run.parentSessionId)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  const workers = new Map(view.workers.map(worker => [worker.id, worker]))
  const workerIds: (string | undefined)[] = [...workers.keys()]
  for (const { run } of roots) {
    if (!workerIds.includes(run.workerId)) workerIds.push(run.workerId)
  }
  return workerIds.map(id => {
    const rounds = new Map<number | undefined, RoleRunNode[]>()
    for (const root of roots.filter(node => node.run.workerId === id)) {
      const round = root.run.workflowRound
      const runs = rounds.get(round) ?? []
      runs.push(root)
      rounds.set(round, runs)
    }
    return {
      id,
      worker: id === undefined ? undefined : workers.get(id),
      rounds: [...rounds].map(([round, runs]) => ({ round, runs })),
    }
  })
}

/**
 * Address a role transcript in the existing Harness sidebar conversation.
 * @param run - real session and its direct parent.
 * @returns native one-shot conversation resource address.
 */
export function roleTranscriptAddress(run: AlphaSolveRoleRunView): string {
  const query = new URLSearchParams({ parent: run.parentSessionId, mode: 'one-shot' })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(run.sessionId)}?${query}`
}
