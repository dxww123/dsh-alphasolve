// @vitest-environment jsdom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResourceSnapshot, UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AlphaSolveRoleRunView, AlphaSolveWorkflowView } from '../src/workflow-view.js'
import { groupWorkflows, roleTranscriptAddress } from '../src/client/model.js'
import { WorkflowOverview, type WorkflowOverviewProps } from '../src/client/WorkflowPanel.js'
import { zh, en, type AlphaSolveLocaleKey } from '../src/client/locales.js'
import { useWorkflow } from '../src/client/use-workflow.js'

const parentId = 'parent' as SessionId
const now = '2026-09-26T00:00:00.000Z'
const t: WorkflowOverviewProps['t'] = (key, params) => {
  const text = zh[key as AlphaSolveLocaleKey] ?? key
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ''))
}
function run(sessionId: string, over: Partial<AlphaSolveRoleRunView> = {}): AlphaSolveRoleRunView {
  return { sessionId, parentSessionId: parentId, workerId: 'worker-1', role: 'generator', workflowRound: 1, startedAt: now, status: 'completed', steps: 2, ...over }
}
function fixture(): AlphaSolveWorkflowView {
  return {
    version: 1, sessionId: parentId,
    workers: [{ id: 'worker-1', instruction: 'Prove the statement', phase: 'reviser', round: 2, theoremChecks: 0, updatedAt: now }],
    runs: [
      run('generator'),
      run('compute', { parentSessionId: 'generator', role: 'compute' }),
      run('verifier', { role: 'verifier_stepwise' }),
      run('reviser', { role: 'reviser', workflowRound: 2, status: 'running', steps: 1 }),
      run('research', { role: 'research_reviewer', workerId: undefined, workflowRound: undefined }),
    ],
  }
}
afterEach(cleanup)

describe('workflow presentation', () => {
  it('groups successive role sessions by worker and round, with helpers under their actual parent', () => {
    const view = fixture()
    view.workers.push({ id: 'worker-2', phase: 'created', round: 0, theoremChecks: 0, updatedAt: now })
    const groups = groupWorkflows(view)
    expect(groups.map(group => group.id)).toEqual(['worker-1', 'worker-2', undefined])
    expect(groups[0]?.rounds.map(round => round.round)).toEqual([1, 2])
    expect(groups[0]?.rounds[0]?.runs.map(node => node.run.sessionId)).toEqual(['generator', 'verifier'])
    expect(groups[0]?.rounds[0]?.runs[0]?.children[0]?.run.sessionId).toBe('compute')
    expect(groups[1]?.rounds).toEqual([])
    expect(groups[2]?.rounds[0]?.runs[0]?.run.sessionId).toBe('research')
  })

  it('opens current rounds, folds historical rounds, and routes helper transcripts to their direct parent', () => {
    const openRole = vi.fn()
    const view = fixture()
    const rendered = render(createElement(WorkflowOverview, { view, loading: false, failed: false, retry: vi.fn(), openRole, t }))
    const rounds = rendered.container.querySelectorAll<HTMLDetailsElement>('.alphasolve-round')
    expect(rounds[0]?.open).toBe(false)
    expect(rounds[1]?.open).toBe(true)
    expect(rendered.getByText('修订命题', { selector: '.alphasolve-worker-status' })).toBeTruthy()
    const earlier = rounds[0]!
    fireEvent.click(earlier.querySelector('summary')!)
    const helpers = rendered.container.querySelector<HTMLDetailsElement>('.alphasolve-helpers')!
    helpers.open = true
    fireEvent.click(rendered.getByRole('button', { name: '查看 计算助手 的执行记录' }))
    expect(openRole).toHaveBeenCalledWith(view.runs[1])
    expect(roleTranscriptAddress(view.runs[1]!)).toBe('dsh-resource://subagentchat/session/compute?parent=generator&mode=one-shot')
  })

  it('retains finished role links as progress moves to the next round and shows errors alongside the records', () => {
    const props = { loading: false, failed: false, retry: vi.fn(), openRole: vi.fn(), t }
    const initial = fixture()
    const rendered = render(createElement(WorkflowOverview, { ...props, view: initial }))
    const next = fixture()
    next.workers[0]!.round = 3
    next.workers[0]!.phase = 'verifier'
    next.runs[3]!.status = 'completed'
    next.runs.push(run('verifier-next', { role: 'verifier_stepwise', workflowRound: 3, status: 'running' }))
    rendered.rerender(createElement(WorkflowOverview, { ...props, view: next, failed: true }))
    expect(rendered.container.querySelector('[data-role-session="generator"]')).toBeTruthy()
    expect(rendered.container.querySelector('[data-role-session="reviser"]')).toBeTruthy()
    const current = rendered.container.querySelector('[data-role-session="verifier-next"]')!.closest('details')
    expect(current?.open).toBe(true)
    expect(rendered.getByText('无法加载工作流记录')).toBeTruthy()
    fireEvent.click(rendered.getByRole('button', { name: '重试' }))
    expect(props.retry).toHaveBeenCalledOnce()
  })

  it('folds completed workers while keeping cancelled role transcripts available', () => {
    const view = fixture()
    view.workers[0]!.terminalStatus = 'cancelled'
    view.workers[0]!.phase = 'complete'
    view.runs[3]!.status = 'aborted'
    const openRole = vi.fn()
    const rendered = render(createElement(WorkflowOverview, { view, loading: false, failed: false, retry: vi.fn(), openRole, t }))
    const worker = rendered.container.querySelector<HTMLDetailsElement>('.alphasolve-worker')!
    expect(worker.open).toBe(false)
    expect([...worker.querySelectorAll<HTMLDetailsElement>('.alphasolve-round')].every(round => !round.open)).toBe(true)
    worker.open = true
    const round = worker.querySelectorAll<HTMLDetailsElement>('.alphasolve-round')[1]!
    round.open = true
    fireEvent.click(rendered.getByRole('button', { name: '查看 修订器 的执行记录' }))
    expect(openRole).toHaveBeenCalledWith(view.runs[3])
    expect(roleTranscriptAddress(view.runs[3]!)).toContain('reviser?parent=parent&mode=one-shot')
  })
  it('encodes native transcript identifiers and keeps the locale dictionaries aligned', () => {
    expect(roleTranscriptAddress(run('session/#', { parentSessionId: 'role/&' })))
      .toBe('dsh-resource://subagentchat/session/session%2F%23?parent=role%2F%26&mode=one-shot')
    expect(Object.keys(en)).toEqual(Object.keys(zh))
  })
})

describe('workflow file subscription', () => {
  it('reloads on file versions and retains valid content through a failed read until retry succeeds', async () => {
    let meta: ResourceSnapshot<WorkspaceFileStat> = { status: 'live', value: { absolutePath: '/workspace/index.json', version: 'first' }, failure: undefined }
    const useResource = (() => meta) as UseResource
    const read = vi.fn().mockResolvedValue(fixture())
    const { result, rerender } = renderHook(() => useWorkflow(parentId, useResource, read))
    await waitFor(() => expect(result.current.view?.runs).toHaveLength(5))
    expect(read).toHaveBeenCalledTimes(1)
    rerender()
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRejectedValueOnce(new Error('temporary read failure'))
    meta = { ...meta, value: { absolutePath: '/workspace/index.json', version: 'second' } }
    rerender()
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.view?.runs).toHaveLength(5)
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.failed).toBe(false))
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('treats an absent index as empty and reads it when the file watcher observes creation', async () => {
    let meta: ResourceSnapshot<WorkspaceFileStat> = { status: 'failed', value: undefined, failure: new RemoteError('workspace-file/not-found', 'absent', { path: '/workspace/index.json' }) }
    const useResource = (() => meta) as UseResource
    const read = vi.fn().mockResolvedValue(fixture())
    const { result, rerender } = renderHook(() => useWorkflow(parentId, useResource, read))
    expect(result.current.loading).toBe(false)
    expect(result.current.failed).toBe(false)
    expect(read).not.toHaveBeenCalled()
    meta = { status: 'live', value: { absolutePath: '/workspace/index.json', version: 'created' }, failure: undefined }
    rerender()
    await waitFor(() => expect(result.current.view?.workers).toHaveLength(1))
  })

  it('cancels stale reads when versions change and releases the active read on unmount', async () => {
    let meta: ResourceSnapshot<WorkspaceFileStat> = { status: 'live', value: { absolutePath: '/workspace/index.json', version: 'first' }, failure: undefined }
    const useResource = (() => meta) as UseResource
    let settleOld: ((view: AlphaSolveWorkflowView) => void) | undefined
    let oldSignal: AbortSignal | undefined
    let currentSignal: AbortSignal | undefined
    const latest = fixture()
    latest.workers[0]!.round = 9
    const read = vi.fn()
      .mockImplementationOnce((_id: SessionId, signal: AbortSignal) => {
        oldSignal = signal
        return new Promise<AlphaSolveWorkflowView>(resolve => { settleOld = resolve })
      })
      .mockImplementationOnce((_id: SessionId, signal: AbortSignal) => { currentSignal = signal; return Promise.resolve(latest) })
    const { result, rerender, unmount } = renderHook(() => useWorkflow(parentId, useResource, read))
    meta = { ...meta, value: { absolutePath: '/workspace/index.json', version: 'second' } }
    rerender()
    await waitFor(() => expect(result.current.view?.workers[0]?.round).toBe(9))
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => { settleOld?.(fixture()); await Promise.resolve() })
    expect(result.current.view?.workers[0]?.round).toBe(9)
    unmount()
    expect(currentSignal?.aborted).toBe(true)
  })
})
