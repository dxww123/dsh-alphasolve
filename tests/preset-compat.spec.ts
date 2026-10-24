import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  agentEvents,
  assembleContextFor,
  type Agent,
} from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import {
  ToolCallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'

import { AlphaSolveSessionStateService } from '../src/session-state.js'

import {
  ACTIVATE_TOOL_NAME,
  AlphaSolveController,
} from '../src/controller.js'
import {
  createRolePolicy,
  ORCHESTRATOR_INDEX_PATH_PATTERN,
} from '../src/permissions.js'
import { runRoleAgent } from '../src/role-runner.js'
import {
  activateAlphaSolveRuntime,
  RUNTIME_TOOL_NAMES,
  type RuntimeActivationResult,
} from '../src/runtime.js'

const FIXTURES = path.join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'presets')
const REQUIRED_FILE_TOOLS = ['read', 'write', 'edit', 'glob', 'grep'] as const
const contexts: Context[] = []
const temporaryRoots: string[] = []

class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  run(_spec: PtcRunSpec): Promise<PtcRunResult> {
    throw new Error('preset presentation tests do not execute programs')
  }
}

class CompletingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'role completed' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-alphasolve-preset-compat-'))
  temporaryRoots.push(root)
  await writeFile(path.join(root, 'problem.md'), 'Prove the compatibility fixture proposition.\n')
  return root
}

async function presetHarness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(FIXTURES).href}/`
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AlphaSolveSessionStateService)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PresentationRuntime)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const marker of ['standard', 'minimal', 'complete', 'ptc'] as const) {
    await ctx.plugin(AgentPreset, {
      id: marker,
      plugins: [{
        name: pathToFileURL(path.join(FIXTURES, 'plugins', 'alphasolve-compat.js')).href,
        config: {
          marker,
          presentation: marker === 'ptc' ? 'ptc' : 'native',
          complete: marker === 'complete',
          tools: marker === 'minimal' ? ['read'] : [...REQUIRED_FILE_TOOLS, 'bash'],
        },
      }],
    })
  }
  return ctx
}

async function headlessHarness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AlphaSolveSessionStateService)
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const name of [...REQUIRED_FILE_TOOLS, 'bash']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} headless fixture`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: name }]),
    }))
  }
  return ctx
}

async function createAgent(
  ctx: Context,
  id: string,
  cwd: string,
  preset?: 'standard' | 'minimal' | 'complete' | 'ptc',
): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd },
    agentOptions: { provider: 'fixture', model: 'fixture' },
    ...(preset === undefined
      ? {}
      : { setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, preset) }),
  })
  return handle.agent
}

function message(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function submit(ctx: Context, agent: Agent, input: UserMessage): Promise<void> {
  agentEvents(ctx, agent).emit('agent/inbox/claimed', { message: input, turn: 1 })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      messages: [input],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter', messages: [input] }),
  )
  expect(decision).toMatchObject({ kind: 'enter' })
}

async function activateFromPreflight(ctx: Context, agent: Agent) {
  return await executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`activate-${agent.id}`),
    name: ACTIVATE_TOOL_NAME,
    arguments: { overwriteSolution: false },
    agent,
  })
}

describe('declarative Agent Preset compatibility', () => {
  it('discovers required tools through the parent agent scope and rejects an insufficient preset explicitly', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-minimal', root, 'minimal')
    const activate = vi.fn<() => Promise<RuntimeActivationResult>>()
    const lookup = vi.spyOn(ctx.tools, 'get')
    await new AlphaSolveController(ctx, { activate }).install()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const result = await activateFromPreflight(ctx, agent)

    expect(result).toMatchObject({
      isError: false,
      value: {
        activated: false,
        reason: 'agent_preset_missing_required_tools',
        agentPreset: 'minimal',
        missingTools: ['write', 'edit', 'glob', 'grep'],
      },
    })
    expect(activate).not.toHaveBeenCalled()
    for (const name of REQUIRED_FILE_TOOLS) {
      expect(lookup.mock.calls.some(([candidate, scope]) => candidate === name && scope === agent), name).toBe(true)
    }
  })

  it('blocks run_code during PTC preflight and restores the unchanged executor afterward', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-ptc-preflight', root, 'ptc')
    const run = vi.spyOn(ctx.ptcRuntime, 'run').mockResolvedValue({ logs: [], value: 7 })
    const activate = vi.fn<() => Promise<RuntimeActivationResult>>()
    await new AlphaSolveController(ctx, { activate }).install()
    const call = (id: string) => executeModelToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(id), name: RUN_CODE_NAME,
      arguments: { code: 'return 7', description: 'verify the selected PTC executor' }, agent,
    })
    expect(await call('ptc-before-preflight')).toMatchObject({ isError: false, value: { result: 7 } })
    expect(run).toHaveBeenCalledOnce()
    run.mockClear()

    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(assembly.sections.find(section => section.name === 'alphasolve:preflight')?.text)
      .toMatch(/native/i)
    const denied = await call('ptc-denied-during-preflight')
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toMatch(/native tool executor/i)
    expect(run).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['problem.md'])

    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeUndefined())
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name))
      .toEqual([RUN_CODE_NAME])
    expect(await call('ptc-after-preflight')).toMatchObject({ isError: false, value: { result: 7 } })
    expect(run).toHaveBeenCalledOnce()
  })

  it('hands a real preflight to the real runtime without retaining the preflight tool restriction', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-controller-runtime', root, 'standard')
    const disposeController = await new AlphaSolveController(ctx, {
      defaultDetailedTrace: false,
    }).install()

    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    const activation = await activateFromPreflight(ctx, agent)

    expect(activation).toMatchObject({
      isError: false,
      value: { activated: true, capacity: 2, resumed: false },
    })
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining([...REQUIRED_FILE_TOOLS, RUNTIME_TOOL_NAMES.worker]))
    for (const name of [RUN_CODE_NAME, 'bash', ACTIVATE_TOOL_NAME]) {
      expect(assembly.tools.map(tool => tool.name), name).not.toContain(name)
    }
    for (const name of ['write', 'edit'] as const) {
      expect(ctx.tools.get(name, agent)?.parameters).toMatchObject({
        properties: { file_path: { pattern: ORCHESTRATOR_INDEX_PATH_PATTERN } },
      })
    }
    const denied = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('preset-controller-runtime-denied-write'),
      name: 'write',
      arguments: {
        file_path: 'verified_propositions/fabricated.md',
        content: '# Fabricated\n',
      },
      agent,
    })
    expect(denied.isError).toBe(true)

    await disposeController()

    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
  })

  it('rejects a complete-prompt preset when it hides the AlphaSolve orchestrator section', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-complete-prompt', root, 'complete')
    await new AlphaSolveController(ctx, { defaultDetailedTrace: false }).install()

    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
    await submit(ctx, agent, message('Use AlphaSolve to solve problem.md.'))
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)

    const activation = await activateFromPreflight(ctx, agent)

    expect(activation).toMatchObject({
      isError: false,
      value: {
        activated: false,
        reason: 'agent_preset_blocks_alphasolve_prompt',
        agentPreset: 'complete',
      },
    })
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    await expect(lstat(path.join(root, '.alphasolve', 'lock.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    // The failed activation restores the preflight lease until this response
    // turn settles, then unloads it and restores the inherited native tool catalog.
    expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeDefined()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    await vi.waitFor(() => expect(ctx.tools.get(ACTIVATE_TOOL_NAME, agent)).toBeUndefined())
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
  })

  it('rejects a PTC runtime before filesystem changes and leaves its executor usable', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-ptc-runtime', root, 'ptc')
    const run = vi.spyOn(ctx.ptcRuntime, 'run').mockResolvedValue({ logs: [], value: 11 })
    const activated = await activateAlphaSolveRuntime(
      agent, { capacity: 2 }, { defaultDetailedTrace: false }, () => undefined,
    )
    expect(activated).toMatchObject({ activated: false, reason: 'agent_executor_requires_native' })
    expect(await readdir(root)).toEqual(['problem.md'])
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name))
      .toEqual([RUN_CODE_NAME])
    const stillPtc = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('ptc-after-rejected-activation'),
      name: RUN_CODE_NAME, arguments: { code: 'return 11', description: 'confirm PTC remains usable' }, agent,
    })
    expect(stillPtc).toMatchObject({ isError: false, value: { result: 11 } })
    expect(run).toHaveBeenCalledOnce()
  })

  it('preserves a native executor before activation, during runtime, and after disposal', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const agent = await createAgent(ctx, 'preset-native-runtime', root, 'standard')
    const read = (id: string) => executeModelToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId(id), name: 'read',
      arguments: { file_path: 'problem.md' }, agent,
    })
    expect(await read('native-before-runtime')).toMatchObject({ isError: false, value: { name: 'read' } })
    const activated = await activateAlphaSolveRuntime(
      agent, { capacity: 2 }, { defaultDetailedTrace: false }, () => undefined,
    )
    expect(activated.activated).toBe(true)
    if (!activated.activated) throw new Error('fixture activation failed: ' + activated.reason)
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining([...REQUIRED_FILE_TOOLS, RUNTIME_TOOL_NAMES.worker]))
    expect(assembly.tools.map(tool => tool.name)).not.toContain(RUN_CODE_NAME)
    expect(assembly.sections.map(section => section.name)).toContain('preset:standard')
    expect(assembly.sections.map(section => section.name)).toContain('alphasolve:orchestrator')
    const configured = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('native-runtime-configure'),
      name: RUNTIME_TOOL_NAMES.configure, arguments: { capacity: 3 }, agent,
    })
    expect(configured).toMatchObject({
      isError: false, value: { previousCapacity: 2, capacity: 3 },
    })
    await activated.runtime.dispose()
    expect(ctx.tools.get(RUNTIME_TOOL_NAMES.worker, agent)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble(assembleContextFor(agent))).tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining([...REQUIRED_FILE_TOOLS, 'bash']))
    expect(await read('native-after-runtime')).toMatchObject({ isError: false, value: { name: 'read' } })
  })
})

describe('role child preset composition', () => {
  it('inherits the exact parent preset, switches itself to native, and keeps the AlphaSolve permission boundary', async () => {
    const root = await workspace()
    const ctx = await presetHarness()
    const adapter = new CompletingAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const parent = await createAgent(ctx, 'preset-role-parent', root, 'ptc')
    let observed: {
      preset?: string
      durablePreset?: string
      toolNames?: string[]
      sectionNames?: string[]
    } = {}

    const result = await runRoleAgent({
      parent,
      role: 'reasoning',
      cwd: root,
      persona: 'AlphaSolve reasoning fixture.',
      prompt: 'Check the fixture implication.',
      maxTurns: 2,
      signal: new AbortController().signal,
      permissionPolicy: createRolePolicy('reasoning', {
        workspace: root,
        delegatedReadRoots: ['problem.md'],
      }),
      setupHelpers: async (childCtx, child) => {
        const assembly = await childCtx.systemPrompt.assemble(assembleContextFor(child))
        observed = {
          preset: ctx.agentPresets.composedPreset(childCtx),
          durablePreset: child.ctx.get('agentPresets')?.presetForSession(child.session) ?? undefined,
          toolNames: assembly.tools.map(tool => tool.name),
          sectionNames: assembly.sections.map(section => section.name),
        }
      },
    })

    expect(result).toMatchObject({ stopReason: 'completed', text: 'role completed' })
    expect(observed.preset).toBe('ptc')
    expect(observed.durablePreset).toBe('ptc')
    expect(observed.toolNames).toEqual(expect.arrayContaining(['read', 'glob', 'grep']))
    for (const name of ['write', 'edit', 'bash', RUN_CODE_NAME]) {
      expect(observed.toolNames, name).not.toContain(name)
    }
    expect(observed.sectionNames).toContain('preset:ptc')
    expect(observed.sectionNames).toContain('deployment:persona-prefix')
    expect((await ctx.systemPrompt.assemble(assembleContextFor(parent))).tools.map(tool => tool.name)).toContain(RUN_CODE_NAME)
  })

  it('retains global Headless tools when no AgentPresets service exists', async () => {
    const root = await workspace()
    const ctx = await headlessHarness()
    const adapter = new CompletingAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    const parent = await createAgent(ctx, 'headless-role-parent', root)
    let toolNames: string[] = []

    const result = await runRoleAgent({
      parent,
      role: 'reasoning',
      cwd: root,
      persona: 'AlphaSolve Headless reasoning fixture.',
      prompt: 'Check the Headless fixture implication.',
      maxTurns: 2,
      signal: new AbortController().signal,
      permissionPolicy: createRolePolicy('reasoning', {
        workspace: root,
        delegatedReadRoots: ['problem.md'],
      }),
      setupHelpers: async (childCtx, child) => {
        toolNames = (await childCtx.systemPrompt.assemble(assembleContextFor(child)))
          .tools.map(tool => tool.name)
      },
    })

    expect(result).toMatchObject({ stopReason: 'completed', text: 'role completed' })
    expect(toolNames).toEqual(expect.arrayContaining(['read', 'glob', 'grep']))
    for (const name of ['write', 'edit', 'bash', RUN_CODE_NAME]) {
      expect(toolNames, name).not.toContain(name)
    }
  })
})
