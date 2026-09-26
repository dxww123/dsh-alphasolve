import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import Subagents, { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlphaSolveWorkflowObserver } from '../src/workflow-observation.js'
import { alphaSolveWorkflowPath, parseAlphaSolveWorkflowView } from '../src/workflow-view.js'
import { runRoleAgent } from '../src/role-runner.js'
import { createRolePolicy } from '../src/permissions.js'
import { initializeWorkspace } from '../src/workspace.js'
import { STATE_VERSION, type WorkerRecord } from '../src/types.js'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'alphasolve-overview-'))
  roots.push(root)
  await initializeWorkspace(root)
  return root
}
function worker(id: string): WorkerRecord {
  return { version: STATE_VERSION, id, instruction: `Investigate ${id}`, phase: 'generator',
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
    problemDigest: 'fixture', round: 0, theoremChecks: 0, artifactPaths: [] }
}
async function readView(root: string, sessionId = 'main') {
  return parseAlphaSolveWorkflowView(JSON.parse(await readFile(path.join(root, alphaSolveWorkflowPath(sessionId)), 'utf8')))
}
class CompletingAdapter extends LlmAdapter {
  constructor(private readonly inspect: (options: GenerateOptions) => Promise<void> = async () => undefined) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.inspect(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'role completed' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function harness(root: string, adapter: LlmAdapter): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  ctx.llm.registerAdapter(['fixture'], adapter)
  const parent = (await ctx.agents.create({ sessionId: SessionId('main'), meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture' } })).agent
  return { ctx, parent }
}

describe('durable workflow overview', () => {
  it('retains concurrent workers and converts only unfinished work to interrupted after reopening', async () => {
    const root = await workspace()
    const errors = vi.fn()
    const observer = await AlphaSolveWorkflowObserver.open(root, 'main', errors)
    await Promise.all([observer.worker(worker('worker-a')), observer.worker(worker('worker-b'))])
    await observer.worker({ ...worker('worker-b'), phase: 'complete', terminalStatus: 'verified' })
    const view = await readView(root)
    expect(view.workers.map(row => row.id)).toEqual(['worker-a', 'worker-b'])
    await AlphaSolveWorkflowObserver.open(root, 'main', errors)
    expect((await readView(root)).workers).toMatchObject([
      { id: 'worker-a', terminalStatus: 'interrupted' }, { id: 'worker-b', terminalStatus: 'verified' },
    ])
    expect(errors).not.toHaveBeenCalled()
  })

  it('refuses damaged files and a file owned by another Session', async () => {
    const root = await workspace()
    await AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())
    const file = path.join(root, alphaSolveWorkflowPath('main'))
    await writeFile(file, '{invalid')
    await expect(AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())).rejects.toBeInstanceOf(SyntaxError)
    await writeFile(file, JSON.stringify({ version: 1, sessionId: 'other', workers: [], runs: [] }))
    await expect(AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())).rejects.toThrow('another Session')
  })

  it('keeps worker admission independent from a failed overview write and contains diagnostic failures', async () => {
    const root = await workspace()
    const errors = vi.fn(() => { throw new Error('diagnostic failed') })
    const observer = await AlphaSolveWorkflowObserver.open(root, 'main', errors)
    const directory = path.join(root, '.alphasolve', 'workflows')
    await rm(directory, { recursive: true })
    await writeFile(directory, 'occupied')
    await expect(observer.worker(worker('worker-a'))).resolves.toBeUndefined()
    expect(errors).toHaveBeenCalledOnce()
  })

  it('exposes each fresh role before its first request and preserves native one-shot navigation after disposal', async () => {
    const root = await workspace()
    const observer = await AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())
    await observer.worker(worker('worker-a'))
    const firstRequestViews: string[] = []
    const { ctx, parent } = await harness(root, new CompletingAdapter(async options => {
      const view = await readView(root)
      const run = view.runs.find(row => row.sessionId === options.sessionId)
      expect(run).toMatchObject({ workerId: 'worker-a', status: 'running' })
      if (run === undefined) throw new Error('role not discoverable before model request')
      firstRequestViews.push(run.sessionId)
    }))
    const logs = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
    ctx.on('session/event', (session, event) => {
      let log = logs.get(String(session.id))
      if (log === undefined) { log = { header: session.header, events: [] }; logs.set(String(session.id), log) }
      log.events.push(event)
    })
    let helperSessionId: string | undefined
    const run = async (role: 'generator' | 'verifier' | 'reviser', round: number) => runRoleAgent({
      parent, role, cwd: root, persona: role, prompt: 'Complete this role.', maxTurns: 2,
      signal: new AbortController().signal, permissionPolicy: createRolePolicy(role, { workspace: root,
        workerDirectory: path.join(root, 'unverified_propositions', 'prop-worker-a'),
        propositionFile: path.join(root, 'unverified_propositions', 'prop-worker-a', 'proposition.md') }),
      allowedInheritedTools: [], observation: observer.role({ workerId: 'worker-a', role, workflowRound: round }),
      ...(role !== 'generator' ? {} : { setupHelpers: (childCtx: Context, child: Agent) => {
        childCtx.on('agent/pre-step', async (_payload, next) => {
          const helper = await runRoleAgent({ parent: child, role: 'reasoning', cwd: root,
            persona: 'reasoning helper', prompt: 'Check one implication.', maxTurns: 1,
            signal: new AbortController().signal,
            permissionPolicy: createRolePolicy('reasoning', { workspace: root }),
            allowedInheritedTools: [], observation: observer.role({ workerId: 'worker-a', role: 'reasoning' }),
          })
          helperSessionId = String(helper.agentId)
          return next()
        })
      } }),
    })
    const generator = await run('generator', 0)
    const verifier = await run('verifier', 1)
    const reviser = await run('reviser', 1)
    const view = await readView(root)
    expect(view.runs.map(row => row.sessionId)).toEqual([generator.agentId, helperSessionId, verifier.agentId, reviser.agentId])
    expect(view.runs.find(row => row.sessionId === helperSessionId)).toMatchObject({ parentSessionId: generator.agentId, workerId: 'worker-a' })
    expect(new Set(firstRequestViews)).toEqual(new Set(view.runs.map(row => row.sessionId)))
    expect(view.runs.every(row => row.status === 'completed' && row.finishedAt !== undefined && row.steps === 1)).toBe(true)
    const catalog = ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog
    expect(catalog).toMatchObject(view.runs.filter(row => row.parentSessionId === 'main').map(row => ({ id: row.sessionId, mode: 'one-shot' })))
    for (const row of view.runs) {
      const log = logs.get(row.sessionId)
      if (log === undefined) throw new Error('missing durable child log')
      const restored = validateStoredEvents(log.header, structuredClone(log.events))
      expect(foldSubagentDescriptor(restored)).toMatchObject({ mode: 'one-shot', provider: 'alphasolve' })
      expect(restored.findIndex(event => event.type === 'subagent/descriptor'))
        .toBeLessThan(restored.findIndex(event => event.type === 'request/header'))
      const loaded = ctx.sessions.create(SessionId(`restored-${row.sessionId}`), { seed: restored })
      expect(ctx.sessionProjections.snapshot(loaded).values.subagent).toMatchObject({ mode: 'one-shot' })
      if (row.sessionId === String(generator.agentId)) {
        expect(ctx.sessionProjections.snapshot(loaded).values.subagentCatalog).toMatchObject([{ id: helperSessionId, mode: 'one-shot' }])
      }
    }
    await AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())
    expect((await readView(root)).runs).toEqual(view.runs)
  })


  it('marks an unfinished role interrupted without erasing its Session address', async () => {
    const root = await workspace()
    const observer = await AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())
    const { ctx, parent } = await harness(root, new CompletingAdapter())
    const child = await ctx.agents.create({ parentAgent: parent,
      sessionId: SessionId('crash-left-role'), meta: { cwd: root, parentSession: parent.id, origin: 'subagent' },
    })
    await observer.role({ workerId: 'worker-a', role: 'generator' }).started(child.agent)
    await child.dispose()
    await AlphaSolveWorkflowObserver.open(root, 'main', vi.fn())
    expect((await readView(root)).runs).toMatchObject([{
      sessionId: 'crash-left-role', parentSessionId: 'main', role: 'generator', status: 'interrupted',
    }])
  })

  it.each(['self', 'cycle', 'duplicate'])('rejects invalid role ancestry: %s', kind => {
    const row = { sessionId: 'role-a', parentSessionId: kind === 'self' ? 'role-a' : 'role-b',
      role: 'generator', startedAt: '2026-09-25T00:00:00.000Z', status: 'running', steps: 0 }
    const runs = kind === 'self' ? [row] : [row, { ...row,
      sessionId: kind === 'duplicate' ? 'role-a' : 'role-b', parentSessionId: 'role-a' }]
    expect(() => parseAlphaSolveWorkflowView({ version: 1, sessionId: 'main', workers: [], runs })).toThrow()
  })
})
