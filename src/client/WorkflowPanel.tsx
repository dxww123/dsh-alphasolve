/** Workflow overview built from role metadata; transcripts use Harness conversations. */
import { IconBranchOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AlphaSolveRoleRunView, AlphaSolveWorkflowView } from '../workflow-view.js'
import { groupWorkflows, type RoleRunNode } from './model.js'
import { NS, zh, type AlphaSolveLocaleKey } from './locales.js'

/** Inputs for the workflow overview independent of file transport. */
export interface WorkflowOverviewProps extends PropsLocale<typeof NS> {
  readonly view: AlphaSolveWorkflowView | undefined
  readonly loading: boolean
  readonly failed: boolean
  readonly retry: () => void
  readonly openRole: (run: AlphaSolveRoleRunView) => void
}

function roleLabel(role: string, t: TranslateNS<typeof NS>): string {
  const key = `role.${role}`
  return key in zh ? t(key as AlphaSolveLocaleKey) : role
}

function roleState(run: AlphaSolveRoleRunView): StateDotState {
  if (run.status === 'running') return 'ongoing'
  if (run.status === 'completed') return 'done'
  if (run.status === 'error') return 'error'
  return 'warning'
}

function hasRunning(nodes: readonly RoleRunNode[]): boolean {
  return nodes.some(node => node.run.status === 'running' || hasRunning(node.children))
}

function RoleRows({ nodes, openRole, t }: {
  readonly nodes: readonly RoleRunNode[]
  readonly openRole: WorkflowOverviewProps['openRole']
  readonly t: WorkflowOverviewProps['t']
}) {
  return <ol className="alphasolve-runs">
    {nodes.map(({ run, children }) => {
      const label = roleLabel(run.role, t)
      const attempt = run.verifierAttempt ?? run.theoremAttempt
      return <li key={run.sessionId} data-role-session={run.sessionId}>
        <button type="button" className="alphasolve-run" onClick={() => openRole(run)} aria-label={t('openRole', { role: label })}>
          <span className="alphasolve-state"><StateDot state={roleState(run)} /></span>
          <span className="alphasolve-run-content">
            <span className="alphasolve-run-title">{label}</span>
            <span className="alphasolve-secondary">
              {t(`run.${run.status}`)}{' · '}{t('steps', { count: run.steps })}
              {attempt === undefined ? null : <> · {t('attempt', { attempt })}</>}
            </span>
            <span className="alphasolve-open">{t('open')}</span>
          </span>
        </button>
        {run.error === undefined ? null : <p className="alphasolve-notice">{run.error}</p>}
        {children.length === 0 ? null : <details className="alphasolve-helpers" open={hasRunning(children)}><summary>{t('helpers', { count: children.length })}</summary><RoleRows nodes={children} openRole={openRole} t={t} /></details>}
      </li>
    })}
  </ol>
}

/**
 * Show each worker's rounds and preserve every completed role's transcript link.
 * @param props - current metadata, load feedback, and native conversation action.
 * @returns accessible workflow list.
 */
export function WorkflowOverview({ view, loading, failed, retry, openRole, t }: WorkflowOverviewProps) {
  const groups = view === undefined ? [] : groupWorkflows(view)
  return <div className="alphasolve-panel">
    <p className="alphasolve-description">{t('description')}</p>
    {failed ? <div className="alphasolve-notice" role="status">
      <span>{t('loadFailed')}</span>
      <button type="button" className="alphasolve-retry" onClick={retry}>{t('retry')}</button>
    </div> : null}
    {loading ? <div className="alphasolve-empty" role="status" aria-label={t('loading')}><StateDot state="ongoing" size={20} /></div>
      : groups.length === 0 ? <p className="alphasolve-empty">{t('empty')}</p> : groups.map(group => {
        const worker = group.worker
        const terminal = worker?.terminalStatus
        const status = worker === undefined ? undefined : terminal === undefined ? t(`phase.${worker.phase}`) : t(`terminal.${terminal}`)
        const workerState: StateDotState = terminal === undefined ? 'ongoing' : terminal === 'verified' || terminal === 'solved' ? 'done' : terminal === 'failed' || terminal === 'write_conflict' ? 'error' : 'warning'
        return <details key={group.id ?? 'auxiliary'} className="alphasolve-worker" open={terminal === undefined}>
          <summary className="alphasolve-worker-summary">
            <span className="alphasolve-worker-title">{group.id === undefined ? t('auxiliary') : t('worker', { id: group.id })}</span>
            {status === undefined ? null : <span className="alphasolve-worker-status"><StateDot state={workerState} />{status}</span>}
          </summary>
          {worker?.instruction === undefined ? null : <p className="alphasolve-instruction">{worker.instruction}</p>}
          {worker === undefined || terminal !== undefined ? null : <p className="alphasolve-current">
            {worker.round > 0 ? <>{t('round', { round: worker.round })}{' · '}</> : null}{t(`phase.${worker.phase}`)}
          </p>}
          {worker?.reason === undefined ? null : <p className="alphasolve-notice">{worker.reason}</p>}
          {group.rounds.length === 0 ? <p className="alphasolve-secondary alphasolve-waiting">{t('noRoles')}</p> : group.rounds.map(round => <details key={round.round ?? 'preparation'} className="alphasolve-round" open={(terminal === undefined && round.round === worker?.round) || hasRunning(round.runs)}>
            <summary>{round.round === undefined || round.round === 0 ? t('preparation') : t('round', { round: round.round })}</summary>
            <RoleRows nodes={round.runs} openRole={openRole} t={t} />
          </details>)}
        </details>
      })}
  </div>
}

/**
 * Sidebar tab title, using the shared workflow icon.
 * @param props - locale for the AlphaSolve title.
 * @returns icon and localized title.
 */
export function WorkflowTabTitle({ t }: PropsLocale<typeof NS>) {
  return <><IconBranchOutlineRegular size={14} />{t('title')}</>
}
