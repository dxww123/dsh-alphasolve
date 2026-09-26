import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { AlphaSolveRoleRunView, AlphaSolveWorkflowView } from '../workflow-view.js';
import { NS } from './locales.js';
/** Inputs for the workflow overview independent of file transport. */
export interface WorkflowOverviewProps extends PropsLocale<typeof NS> {
    readonly view: AlphaSolveWorkflowView | undefined;
    readonly loading: boolean;
    readonly failed: boolean;
    readonly retry: () => void;
    readonly openRole: (run: AlphaSolveRoleRunView) => void;
}
/**
 * Show each worker's rounds and preserve every completed role's transcript link.
 * @param props - current metadata, load feedback, and native conversation action.
 * @returns accessible workflow list.
 */
export declare function WorkflowOverview({ view, loading, failed, retry, openRole, t }: WorkflowOverviewProps): import("react").JSX.Element;
/**
 * Sidebar tab title, using the shared workflow icon.
 * @param props - locale for the AlphaSolve title.
 * @returns icon and localized title.
 */
export declare function WorkflowTabTitle({ t }: PropsLocale<typeof NS>): import("react").JSX.Element;
//# sourceMappingURL=WorkflowPanel.d.ts.map