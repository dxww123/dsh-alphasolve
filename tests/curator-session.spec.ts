import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCuratorSession, readCuratorSessionIdentity, CURATOR_SESSION_PATH } from '../src/curator-session.js'
import { createCuratorKnowledgeTools } from '../src/curator-tools.js'
import { AlphaSolveRoleService, type RoleAgentRunner } from '../src/role-service.js'
import { runRoleAgent, type RoleRunResult } from '../src/role-runner.js'
import { initializeWorkspace } from '../src/workspace.js'
import { AlphaSolveWorkflowObserver } from '../src/workflow-observation.js'
import { alphaSolveWorkflowPath } from '../src/workflow-view.js'
import type { CuratorTaskKind } from '../src/types.js'

type Reply = string | { name: string; arguments: Record<string, unknown> }
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeReply: ((options: GenerateOptions) => Promise<void>) | undefined
  constructor(private readonly replies: Reply[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    await this.beforeReply?.(options)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('Unexpected model request')
    const block = typeof reply === 'string'
      ? { type: 'text' as const, text: reply }
      : { type: 'tool-call' as const, id: ToolCallId(randomUUID()), name: reply.name, arguments: JSON.stringify(reply.arguments) }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: typeof reply === 'string' ? 'stop' : 'tool-calls' } }
  }
}

const contexts = new Set<Context>()
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'alphasolve-curator-session-')))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  await initializeWorkspace(workspace)
  await writeFile(path.join(workspace, 'problem.md'), 'Prove the fixture proposition.\n')
  return { root, workspace }
}

async function harness(root: string, workspace: string, adapter: ScriptedAdapter, resume = false) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: path.join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], adapter)
  const route = { provider: 'fixture', model: 'curator' }
  const handle = resume
    ? await ctx.agents.resume({ resumeSessionId: SessionId('main'), agentOptions: route })
    : await ctx.agents.create({ sessionId: SessionId('main'), meta: { cwd: workspace }, agentOptions: route })
  return { ctx, parent: handle.agent }
}

async function service(parent: Agent, workspace: string, runner?: RoleAgentRunner) {
  const observer = await AlphaSolveWorkflowObserver.open(workspace, String(parent.id), error => { throw error })
  return new AlphaSolveRoleService({ parent, workspace, observer,
    getConfig: () => ({ capacity: 1, detailedTrace: false, models: {} }),
    ...(runner === undefined ? {} : { runner }),
  })
}

async function task(workspace: string, id: string, kind: CuratorTaskKind = 'digest', signal = new AbortController().signal) {
  return {
    task: { version: 1 as const, id, kind, createdAt: new Date().toISOString(), status: 'active' as const,
      attempts: 1, metadata: { note: `Evidence for ${id}` } },
    tools: await createCuratorKnowledgeTools(workspace, kind, id), signal,
  }
}

async function events(ctx: Context, id: SessionId) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try { return (await reader.read()).events }
  finally { await reader.close() }
}

describe('persistent curator conversation', () => {
  it('reuses full history across tasks and a fresh Harness runtime, with one catalog entry and overview row', async () => {
    const { root, workspace } = await fixture()
    const adapter = new ScriptedAdapter(['Remember the parity route.', 'Keep the odd case separate.'])
    const first = await harness(root, workspace, adapter)
    const roles = await service(first.parent, workspace)
    await roles.runCurator(await task(workspace, 'first'))
    const identity = (await readCuratorSessionIdentity(workspace))!
    await roles.runCurator(await task(workspace, 'second'))
    expect(await readCuratorSessionIdentity(workspace)).toEqual(identity)
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Remember the parity route.')
    expect(first.ctx.agents.get(SessionId(identity.sessionId))).toBeUndefined()
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)

    const restartedAdapter = new ScriptedAdapter(['Continue from the remembered wiki.'])
    const restarted = await harness(root, workspace, restartedAdapter, true)
    await (await service(restarted.parent, workspace)).runCurator(await task(workspace, 'third'))
    const history = restartedAdapter.requests[0]!.messages
    expect(history.filter(message => message.role === 'assistant').map(message => message.content)).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Remember the parity route.",
            "type": "text",
          },
        ],
        [
          {
            "text": "Keep the odd case separate.",
            "type": "text",
          },
        ],
      ]
    `)
    expect(JSON.stringify(history)).toContain('Task ID: first')
    expect(JSON.stringify(history)).toContain('Task ID: second')
    expect(await readCuratorSessionIdentity(workspace)).toEqual(identity)
    const stored = await events(restarted.ctx, SessionId(identity.sessionId))
    expect(stored.filter(event => event.type === 'subagent/descriptor')).toMatchObject([
      { data: { mode: 'one-shot', provider: 'alphasolve' } },
    ])
    expect(stored.filter(event => event.type === 'turn/start')).toHaveLength(3)
    expect(restarted.parent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toHaveLength(1)
    const view = JSON.parse(await readFile(path.join(workspace, alphaSolveWorkflowPath('main')), 'utf8'))
    expect(view.runs).toMatchObject([{ role: 'curator', sessionId: identity.sessionId, status: 'completed' }])
    expect(view.runs).toHaveLength(1)
  })

  it('refreshes task permissions and mutation journals while retaining earlier tool results', async () => {
    const { root, workspace } = await fixture()
    const write = (target: string, content: string): Reply => ({ name: 'alphasolve_curator_write', arguments: { path: target, content } })
    const read = (target: string): Reply => ({ name: 'alphasolve_curator_read', arguments: { path: target } })
    const adapter = new ScriptedAdapter([
      read('knowledge/common-errors.md'), write('knowledge/common-errors.md', '# Common errors\n- Check the zero case.\n'),
      write('knowledge/parity.md', '# Parity\nFirst bound.\n'), 'Reviewed.',
      read('knowledge/common-errors.md'), write('knowledge/common-errors.md', '# Forbidden overwrite\n'),
      read('knowledge/parity.md'), { name: 'alphasolve_curator_edit', arguments: { path: 'knowledge/parity.md', oldText: 'First bound.', newText: 'Stronger bound.' } }, 'Digested.',
    ])
    const { parent, ctx } = await harness(root, workspace, adapter)
    const roles = await service(parent, workspace)
    const review = await task(workspace, 'review', 'verifier_final')
    await roles.runCurator(review)
    await review.tools.finalizeMetadata()
    const firstLog = await events(ctx, SessionId((await readCuratorSessionIdentity(workspace))!.sessionId))
    expect(firstLog.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
    const digest = await task(workspace, 'digest')
    await roles.runCurator(digest)
    await digest.tools.finalizeMetadata()
    expect(await readFile(path.join(workspace, 'knowledge/common-errors.md'), 'utf8')).toContain('Check the zero case.')
    expect(await readFile(path.join(workspace, 'knowledge/parity.md'), 'utf8')).toContain('modification_count: 2')
    expect(await readFile(path.join(workspace, 'knowledge/parity.md'), 'utf8')).toContain('Stronger bound.')
    const identity = (await readCuratorSessionIdentity(workspace))!
    const stored = await events(ctx, SessionId(identity.sessionId))
    const results = stored.filter(event => event.type === 'tool/result').map(event => event.data.message)
    expect(results.map(result => result.isError ?? false)).toEqual([false, false, false, false, true, false, false])
    expect(JSON.stringify(adapter.requests[4]!.messages)).toContain('Reviewed.')
    expect(JSON.stringify(adapter.requests[4]!.messages)).toContain('Do not modify `knowledge/common-errors.md`')
  })

  it('resets the step budget for each task and keeps the capped attempt in history', async () => {
    const { root, workspace } = await fixture()
    const adapter = new ScriptedAdapter([
      { name: 'alphasolve_curator_list', arguments: {} }, 'Next task completed.',
    ])
    const { parent } = await harness(root, workspace, adapter)
    const results: RoleRunResult[] = []
    const roles = await service(parent, workspace, async options => {
      const result = await runRoleAgent({ ...options, maxTurns: 1 })
      results.push(result)
      return result
    })
    await expect(roles.runCurator(await task(workspace, 'capped'))).rejects.toMatchObject({ result: { stopReason: 'max_turns' } })
    await roles.runCurator(await task(workspace, 'next'))
    expect(results.map(result => result.steps)).toEqual([1, 1])
    expect(results[0]!.agentId).toBe(results[1]!.agentId)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('Task ID: capped')
  })

  it('persists even an empty first Session before saving its identity', async () => {
    const { root, workspace } = await fixture()
    const first = await harness(root, workspace, new ScriptedAdapter([]))
    const abort = new AbortController()
    const roles = await service(first.parent, workspace, options => runRoleAgent({
      ...options, session: { ...options.session!, ready: async () => {
        await options.session!.ready()
        abort.abort(new Error('interrupted before first input'))
      } },
    }))
    await expect(roles.runCurator(await task(workspace, 'unstarted', 'digest', abort.signal))).rejects.toMatchObject({ result: { stopReason: 'aborted' } })
    const identity = (await readCuratorSessionIdentity(workspace))!
    expect(await events(first.ctx, SessionId(identity.sessionId))).toEqual([])
    await first.ctx.fiber.dispose()
    contexts.delete(first.ctx)
    const restarted = await harness(root, workspace, new ScriptedAdapter(['Recovered empty conversation.']), true)
    await (await service(restarted.parent, workspace)).runCurator(await task(workspace, 'unstarted'))
    expect((await readCuratorSessionIdentity(workspace))!.sessionId).toBe(identity.sessionId)
  })

  it('does not publish an identity or send input when the durability barrier fails', async () => {
    const { root, workspace } = await fixture()
    const adapter = new ScriptedAdapter([])
    const { parent, ctx } = await harness(root, workspace, adapter)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk failure'))
    try {
      await expect((await service(parent, workspace)).runCurator(await task(workspace, 'first'))).rejects.toThrow('disk failure')
    } finally { flush.mockRestore() }
    expect(await readCuratorSessionIdentity(workspace)).toBeUndefined()
    expect(adapter.requests).toEqual([])
    expect(ctx.agents.list().map(agent => agent.id)).toEqual(['main'])
  })

  it('rejects overlap and waits for cancellation cleanup before the same Session can be resumed', async () => {
    const { root, workspace } = await fixture()
    const entered = Promise.withResolvers<void>()
    const adapter = new ScriptedAdapter(['Cancelled response.', 'Resumed.'])
    adapter.beforeReply = async options => {
      entered.resolve()
      await new Promise<void>(resolve => {
        if (options.signal!.aborted) resolve()
        else options.signal!.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const { parent, ctx } = await harness(root, workspace, adapter)
    const roles = await service(parent, workspace)
    const abort = new AbortController()
    const pending = roles.runCurator(await task(workspace, 'cancelled', 'digest', abort.signal))
    const rejected = expect(pending).rejects.toMatchObject({ result: { stopReason: 'aborted' } })
    await entered.promise
    await expect(roles.runCurator(await task(workspace, 'overlap'))).rejects.toThrow('already running')
    abort.abort(new Error('stop'))
    await rejected
    const identity = (await readCuratorSessionIdentity(workspace))!
    expect(ctx.agents.get(SessionId(identity.sessionId))).toBeUndefined()
    const writer = await ctx.sessionPersistence.open(SessionId(identity.sessionId), 'write')
    await writer.close()
    adapter.beforeReply = undefined
    await roles.runCurator(await task(workspace, 'resumed'))
    expect((await readCuratorSessionIdentity(workspace))!.sessionId).toBe(identity.sessionId)
  })

  it('clears crash-left pending input so only the durable queue retry starts a turn', async () => {
    const { root, workspace } = await fixture()
    const adapter = new ScriptedAdapter(['Retried once.'])
    const { parent, ctx } = await harness(root, workspace, adapter)
    const identity = await prepareCuratorSession(workspace, parent.id)
    const detached = ctx.sessions.prepare(identity.id, { meta: { cwd: workspace, parentSession: parent.id, origin: 'subagent' } })
    const message = createUserMessage({ content: [{ type: 'text', text: 'stale pending copy' }], source: { kind: 'user' } })
    detached.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] })
    const writer = await ctx.sessionPersistence.create(detached.header)
    try {
      await writer.append(detached.snapshotEvents())
      await writer.flush()
    } finally { await writer.close() }
    await identity.ready()
    await (await service(parent, workspace)).runCurator(await task(workspace, 'retry'))
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('stale pending copy')
    expect((await events(ctx, identity.id)).filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('fails explicitly if a saved log is missing instead of replacing its identity', async () => {
    const { root, workspace } = await fixture()
    const { parent } = await harness(root, workspace, new ScriptedAdapter([]))
    const identity = await prepareCuratorSession(workspace, parent.id)
    await identity.ready()
    await expect((await service(parent, workspace)).runCurator(await task(workspace, 'missing'))).rejects.toThrow()
    expect((await readCuratorSessionIdentity(workspace))!.sessionId).toBe(identity.id)
  })

  it.each(['owner', 'workspace'])('refuses a stored Session with the wrong %s', async mismatch => {
    const { root, workspace } = await fixture()
    const { parent, ctx } = await harness(root, workspace, new ScriptedAdapter([]))
    const identity = await prepareCuratorSession(workspace, parent.id)
    const wrong = await ctx.agents.create({ sessionId: identity.id,
      meta: { cwd: mismatch === 'workspace' ? root : workspace, origin: 'subagent',
        parentSession: mismatch === 'owner' ? SessionId('another-main') : parent.id } })
    await ctx.sessions.flush(wrong.agent.session)
    await wrong.dispose()
    await identity.ready()
    await expect((await service(parent, workspace)).runCurator(await task(workspace, 'wrong'))).rejects.toThrow('different owner or workspace')
    const writer = await ctx.sessionPersistence.open(identity.id, 'write')
    await writer.close()
  })

  it('separates new main Sessions and changed problems, and refuses corrupt identities', async () => {
    const { workspace } = await fixture()
    const original = await prepareCuratorSession(workspace, SessionId('main'))
    await original.ready()
    expect((await prepareCuratorSession(workspace, SessionId('main'))).id).toBe(original.id)
    expect((await prepareCuratorSession(workspace, SessionId('other-main'))).id).not.toBe(original.id)
    await writeFile(path.join(workspace, 'problem.md'), 'A different problem.\n')
    expect((await prepareCuratorSession(workspace, SessionId('main'))).id).not.toBe(original.id)
    await writeFile(path.join(workspace, CURATOR_SESSION_PATH), '{"corrupt":true}')
    await expect(prepareCuratorSession(workspace, SessionId('main'))).rejects.toThrow()
    expect(await readFile(path.join(workspace, CURATOR_SESSION_PATH), 'utf8')).toBe('{"corrupt":true}')
  })
})
