/** AlphaSolve workflow sidebar registration for the Harness desktop and web client. */
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { alphaSolveWorkflowPath, parseAlphaSolveWorkflowView } from '../workflow-view.js'
import { WorkflowOverview, WorkflowTabTitle } from './WorkflowPanel.js'
import { roleTranscriptAddress } from './model.js'
import { useWorkflow, type ReadWorkflow } from './use-workflow.js'
import { NS, zh, en } from './locales.js'
import { workflowStyles } from './styles.js'

/** Sidebar implementation identity. */
export const WORKFLOW_TAB_ID = '@dsh-external/dsh-alphasolve/workflows'
/** Sidebar page kind for the owning main Session. */
export const WORKFLOW_TAB_KIND = 'alphasolve-workflows'
/** Services required for authenticated workflow reads and native transcript navigation. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'resources', 'remote', 'remote.workspaceFiles']

type WorkflowPanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & { readonly readWorkflow: ReadWorkflow }

function WorkflowPanel({ sessionId, useResource, useTabInfo, readWorkflow, t }: WorkflowPanelProps) {
  const { tab } = useTabInfo()
  const workflow = useWorkflow(sessionId, useResource, readWorkflow)
  return <WorkflowOverview {...workflow} t={t} openRole={run => tab.actions.openResource(roleTranscriptAddress(run), { preferNewPane: true })} />
}

type WorkflowHeaderProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & { readonly openWorkflows: () => void }

function WorkflowHeader({ useSession, openWorkflows, t }: WorkflowHeaderProps) {
  const child = useSession(session => session.subagent !== null && session.subagent !== undefined)
  if (child) return null
  return <button type="button" className="alphasolve-header" onClick={openWorkflows}>
    <IconBranchOutlineRegular size={14} />{t('title')}
  </button>
}

/**
 * Register one workflow page per main Session and route roles to Harness transcripts.
 * @param ctx - client root services supplied by Harness.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'alphasolve: workflow dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = workflowStyles
    document.head.append(style)
    return () => { style.remove() }
  }, 'alphasolve: workflow styles')
  const t = ctx.locale.bind(NS)
  const readWorkflow: ReadWorkflow = async (sessionId, signal) => {
    const result = await ctx.remote.workspaceFiles.readBytes(sessionId, alphaSolveWorkflowPath(sessionId), {}, signal)
    if (!result.ok) throw result.error
    const view = parseAlphaSolveWorkflowView(JSON.parse(new TextDecoder().decode(result.value.data)))
    if (view.sessionId !== sessionId) throw new Error('AlphaSolve workflow index belongs to a different session')
    return view
  }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: WORKFLOW_TAB_ID,
    kind: WORKFLOW_TAB_KIND,
    title: () => t('title'),
    guide: [{ id: WORKFLOW_TAB_ID, order: 30, title: () => t('title'), description: () => t('description'), icon: IconBranchOutlineRegular }],
  }), 'alphasolve: workflow tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: WORKFLOW_TAB_ID, locale: NS, inject: () => ({ readWorkflow }),
  }, WorkflowPanel)), 'alphasolve: workflow body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: WORKFLOW_TAB_ID, locale: NS,
  }, WorkflowTabTitle)), 'alphasolve: workflow tab title')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: WORKFLOW_TAB_ID, order: -25, locale: NS,
    inject: sessionId => ({ openWorkflows: () => ctx.sidebarRight.openTabIn(sessionId, WORKFLOW_TAB_KIND) }),
  }, WorkflowHeader)), 'alphasolve: workflow header action')
}
