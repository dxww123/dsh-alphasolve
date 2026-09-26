/** Version-driven reads of the workflow index through Harness workspace files. */
import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { alphaSolveWorkflowPath, type AlphaSolveWorkflowView } from '../workflow-view.js'

/** Reads and validates one complete workflow index under its owning Session. */
export type ReadWorkflow = (sessionId: SessionId, signal: AbortSignal) => Promise<AlphaSolveWorkflowView>

/**
 * Follow the standard file provider's versions, preserving the last valid view on errors.
 * @param sessionId - main Session whose workspace contains the workflow index.
 * @param useResource - Harness resource hook with shared filesystem watching.
 * @param read - authenticated full-file reader.
 * @returns current view, loading/error flags and explicit retry action.
 */
export function useWorkflow(sessionId: SessionId, useResource: UseResource, read: ReadWorkflow) {
  const metadata = useResource<'file'>(fileAddressFor(sessionId, undefined, alphaSolveWorkflowPath(sessionId)))
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{
    sessionId: SessionId
    view?: AlphaSolveWorkflowView
    failed: boolean
    loading: boolean
  }>({ sessionId, failed: false, loading: true })
  const version = metadata.value?.version
  useEffect(() => {
    if (version === undefined && attempt === 0) return
    const controller = new AbortController()
    setState(current => ({ sessionId, ...(current.sessionId === sessionId ? current : {}), failed: false, loading: true }))
    void read(sessionId, controller.signal).then(view => {
      if (!controller.signal.aborted) setState({ sessionId, view, failed: false, loading: false })
    }, (_error: unknown) => {
      if (!controller.signal.aborted) setState(current => ({ ...current, failed: true, loading: false }))
    })
    return () => { controller.abort() }
  }, [sessionId, version, attempt, read])
  const view = state.sessionId === sessionId ? state.view : undefined
  const missing = metadata.failure?.code === 'workspace-file/not-found'
  const failed = (state.sessionId === sessionId && state.failed) || metadata.status === 'none' || (metadata.status === 'failed' && (!missing || view !== undefined))
  return {
    view,
    failed,
    loading: !failed && view === undefined && !missing && (metadata.status === 'loading' || state.loading),
    retry: () => setAttempt(value => value + 1),
  }
}
