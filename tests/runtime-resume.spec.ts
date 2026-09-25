import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

import { alphaSolveSessionProjection, alphaSolveSessionState, hasDurableAlphaSolveResumeIntent } from '../src/session-state.js'

import { RuntimeStore } from '../src/store.js'
import { STATE_VERSION, type WorkerRecord } from '../src/types.js'
import {
  activateAlphaSolveRuntime,
  restoreAlphaSolveRuntime,
  RUNTIME_TOOL_NAMES,
} from '../src/runtime.js'
import { initializeWorkspace, readWorkspaceInput } from '../src/workspace.js'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const REQUIRED_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep'] as const

function registerFileToolFixtures(ctx: Context, names: readonly string[]): void {
  for (const name of names) {
    const pathField = name === 'glob' || name === 'grep' ? 'path' : 'file_path'
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} resume fixture`,
      parameters: {
        [pathField]: {
          type: 'string',
          ...(name === 'write' || name === 'edit' ? { required: true } : {}),
        },
        ...(name === 'write' ? { content: { type: 'string', required: true } } : {}),
        ...(name === 'edit' ? {
          old_string: { type: 'string', required: true },
          new_string: { type: 'string', required: true },
        } : {}),
      },
      execute: () => Promise.resolve([{ type: 'text', text: name }]),
    }))
  }
}

async function createRuntimeAgent(
  id = 'resume-session',
  tools: readonly string[] = REQUIRED_FILE_TOOLS,
): Promise<{ agent: Agent; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-runtime-resume-'))
  roots.push(root)
  await writeFile(path.join(root, 'problem.md'), 'Prove the persisted proposition.\n')
  await initializeWorkspace(root)

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.sessionProjections.register(alphaSolveSessionProjection)
  registerFileToolFixtures(ctx, tools)
  await ctx.plugin(AgentLoop, { agents: [] })
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd: root },
    agentOptions: { provider: 'unused', model: 'unused' },
  })
  return { agent: handle.agent, root }
}

function appendToolResult(
  agent: Agent,
  turn: number,
  name: string,
  result: Record<string, unknown>,
): void {
  const callId = ToolCallId(`${name}-${turn}`)
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name,
    arguments: '{}',
  })
  agent.session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn, step: 1 })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function appendCrashLeftToolCall(agent: Agent, turn: number, name: string): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('tool/call', {
    turn,
    step: 1,
    callId: ToolCallId(`${name}-${turn}`),
    name,
    arguments: '{}',
  })
}

async function seedInterruptedState(agent: Agent, root: string, capacity = 7): Promise<void> {
  const problem = await readWorkspaceInput(root, 'problem.md', { nonEmpty: true })
  const now = new Date().toISOString()
  const store = new RuntimeStore(root)
  await store.open({
    version: STATE_VERSION,
    sessionId: String(agent.id),
    workspace: root,
    activatedAt: now,
    updatedAt: now,
    status: 'interrupted',
    problemDigest: problem.digest,
    capacity,
    detailedTrace: true,
    modelOverrides: {},
    nextCompletionSequence: 1,
  })
  appendToolResult(agent, 1, 'alphasolve_activate', { activated: true, capacity })
}

describe('same-session runtime recovery', () => {
  it('does no filesystem probing and stays silent without durable activation intent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    ctx.sessionProjections.register(alphaSolveSessionProjection)
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = await ctx.agents.create({
      sessionId: SessionId('resume-without-intent-or-cwd'),
      agentOptions: { provider: 'unused', model: 'unused' },
    })

    await expect(restoreAlphaSolveRuntime(handle.agent, {}, () => undefined))
      .resolves.toEqual({ restored: false, workspace: '' })
  })

  it('recognizes activation intent and lets a later explicit stop win', async () => {
    const { agent } = await createRuntimeAgent()
    appendToolResult(agent, 1, 'alphasolve_activate', { activated: true })
    expect(hasDurableAlphaSolveResumeIntent(alphaSolveSessionState(agent))).toBe(true)

    appendToolResult(agent, 2, 'alphasolve_stop', { stopped: true })
    expect(hasDurableAlphaSolveResumeIntent(alphaSolveSessionState(agent))).toBe(false)
  })

  it('does not resurrect after a crash-left stop call whose result was never persisted', async () => {
    const { agent } = await createRuntimeAgent()
    appendToolResult(agent, 1, 'alphasolve_activate', { activated: true })
    appendCrashLeftToolCall(agent, 2, 'alphasolve_stop')

    expect(hasDurableAlphaSolveResumeIntent(alphaSolveSessionState(agent))).toBe(false)
  })

  it('reattaches only the same session and preserves its durable runtime configuration', async () => {
    const { agent, root } = await createRuntimeAgent()
    await seedInterruptedState(agent, root, 7)
    await writeFile(path.join(root, '.alphasolve', 'config.json'), '{"unknownAfterActivation":true}\n')

    const result = await restoreAlphaSolveRuntime(
      agent,
      { defaultCapacity: 2, defaultDetailedTrace: false },
      () => undefined,
    )
    expect(result).toMatchObject({ restored: true, capacity: 7, workspace: root })
    if (!result.restored) throw new Error(result.reason)
    expect(result.runtime.store.currentState()).toMatchObject({
      sessionId: String(agent.id),
      status: 'active',
      capacity: 7,
      detailedTrace: true,
    })
    expect(agent.ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeDefined()
    await result.runtime.dispose()
  })

  it('rejects durable recovery before taking the lock when the resumed agent lacks required file tools', async () => {
    const { agent, root } = await createRuntimeAgent('resume-missing-tools', ['read'])
    await seedInterruptedState(agent, root, 3)

    const result = await restoreAlphaSolveRuntime(agent, {}, () => undefined)

    expect(result).toMatchObject({
      restored: false,
      workspace: root,
      reason: 'agent_preset_missing_required_tools',
      missingTools: ['write', 'edit', 'glob', 'grep'],
    })
    expect(agent.ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    await expect(lstat(path.join(root, '.alphasolve', 'lock.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back durable recovery when a complete prompt suppresses the orchestrator section', async () => {
    const { agent, root } = await createRuntimeAgent('resume-complete-prompt')
    agent.ctx.systemPrompt.section({
      name: 'fixture:complete',
      order: 0,
      text: 'Only the fixture prompt is effective.',
      complete: true,
    })
    await seedInterruptedState(agent, root, 3)

    const result = await restoreAlphaSolveRuntime(agent, {}, () => undefined)

    expect(result).toMatchObject({
      restored: false,
      workspace: root,
      reason: 'agent_preset_blocks_alphasolve_prompt',
    })
    expect(agent.ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    await expect(lstat(path.join(root, '.alphasolve', 'lock.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers a crash-left worker exactly once across repeated cold resumes', async () => {
    const { agent, root } = await createRuntimeAgent()
    await seedInterruptedState(agent, root, 2)
    const problem = await readWorkspaceInput(root, 'problem.md', { nonEmpty: true })
    const worker: WorkerRecord = {
      version: STATE_VERSION,
      id: 'worker-crash-left',
      instruction: 'prove the persisted proposition',
      phase: 'reviser',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:10:00.000Z',
      problemDigest: problem.digest,
      round: 1,
      theoremChecks: 0,
      propositionPath: 'unverified_propositions/worker-crash-left/proposition.md',
      artifactPaths: ['unverified_propositions/worker-crash-left/proposition.md'],
    }
    await writeFile(
      path.join(root, '.alphasolve', 'workers', `${worker.id}.json`),
      `${JSON.stringify(worker)}\n`,
    )

    const first = await restoreAlphaSolveRuntime(agent, {}, () => undefined)
    expect(first).toMatchObject({ restored: true, workspace: root })
    if (!first.restored) throw new Error(first.reason)
    expect(await first.runtime.store.listCompletions()).toMatchObject([{
      workerId: worker.id,
      status: 'interrupted',
      failureStage: 'reviser',
      reason: 'worker was active when the prior AlphaSolve runtime ended',
    }])
    await first.runtime.dispose()

    const second = await restoreAlphaSolveRuntime(agent, {}, () => undefined)
    expect(second).toMatchObject({ restored: true, workspace: root })
    if (!second.restored) throw new Error(second.reason)
    const completions = await second.runtime.store.listCompletions()
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ workerId: worker.id, status: 'interrupted' })
    await second.runtime.dispose()
  })

  it('also preserves persisted configuration on explicit same-session reactivation unless capacity is explicit', async () => {
    const { agent, root } = await createRuntimeAgent()
    await seedInterruptedState(agent, root, 7)
    await writeFile(path.join(root, '.alphasolve', 'config.json'), '{"capacity":1,"detailedTrace":false}\n')

    const continued = await activateAlphaSolveRuntime(
      agent,
      {},
      { defaultCapacity: 2, defaultDetailedTrace: false },
      () => undefined,
    )
    expect(continued).toMatchObject({ activated: true, capacity: 7, resumed: true })
    if (!continued.activated) throw new Error(continued.reason)
    expect(continued.runtime.store.currentState()).toMatchObject({ capacity: 7, detailedTrace: true })
    await continued.runtime.dispose()

    const overridden = await activateAlphaSolveRuntime(
      agent,
      { capacity: 4 },
      { defaultCapacity: 2, defaultDetailedTrace: false },
      () => undefined,
    )
    expect(overridden).toMatchObject({ activated: true, capacity: 4, resumed: true })
    if (!overridden.activated) throw new Error(overridden.reason)
    expect(overridden.runtime.store.currentState()).toMatchObject({ capacity: 4, detailedTrace: true })
    await overridden.runtime.dispose()
  })

  it('stays dormant after stop and for a state owned by another session', async () => {
    const stopped = await createRuntimeAgent('stopped-session')
    await seedInterruptedState(stopped.agent, stopped.root)
    appendToolResult(stopped.agent, 2, 'alphasolve_stop', { stopped: true })
    await expect(restoreAlphaSolveRuntime(stopped.agent, {}, () => undefined))
      .resolves.toEqual({ restored: false, workspace: stopped.root })

    const mismatched = await createRuntimeAgent('current-session')
    await seedInterruptedState(mismatched.agent, mismatched.root)
    const state = new RuntimeStore(mismatched.root)
    const problem = await readWorkspaceInput(mismatched.root, 'problem.md', { nonEmpty: true })
    const now = new Date().toISOString()
    await state.open({
      version: STATE_VERSION,
      sessionId: 'another-session',
      workspace: mismatched.root,
      activatedAt: now,
      updatedAt: now,
      status: 'interrupted',
      problemDigest: problem.digest,
      capacity: 2,
      detailedTrace: false,
      modelOverrides: {},
      nextCompletionSequence: 1,
    })
    await state.updateState(current => ({ ...current, sessionId: 'another-session' }))
    await expect(restoreAlphaSolveRuntime(mismatched.agent, {}, () => undefined))
      .resolves.toEqual({ restored: false, workspace: mismatched.root })
  })

  it('fails closed with a diagnostic when problem.md changed', async () => {
    const { agent, root } = await createRuntimeAgent()
    await seedInterruptedState(agent, root)
    await writeFile(path.join(root, 'problem.md'), 'A different proposition.\n')

    const result = await restoreAlphaSolveRuntime(agent, {}, () => undefined)
    expect(result).toMatchObject({
      restored: false,
      workspace: root,
      reason: expect.stringContaining('problem.md changed'),
    })
  })
})
