/** Theme-token styles owned by the AlphaSolve client plugin lifetime. */
export const workflowStyles = `
.alphasolve-panel { box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; padding: 16px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.alphasolve-panel p { margin: 0; }
.alphasolve-description { color: var(--dsw-alias-label-secondary); padding-bottom: 12px; }
.alphasolve-empty { display: flex; min-height: 100px; align-items: center; justify-content: center; color: var(--dsw-alias-label-secondary); text-align: center; }
.alphasolve-worker { margin-bottom: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); padding: 12px; }
.alphasolve-worker-summary { cursor: pointer; overflow-wrap: anywhere; }
.alphasolve-worker-title { font-weight: 500; }
.alphasolve-worker-status { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; color: var(--dsw-alias-label-secondary); }
.alphasolve-instruction { padding-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.alphasolve-current { color: var(--dsw-alias-label-secondary); padding-top: 8px; }
.alphasolve-round { padding-top: 12px; }
.alphasolve-round > summary { cursor: pointer; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); margin: 0 0 4px; }
.alphasolve-runs { margin: 0; padding: 0; list-style: none; }
.alphasolve-run { display: flex; gap: 8px; width: 100%; padding: 8px; border: 0; border-radius: var(--dsw-radius-sm); text-align: left; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.alphasolve-run:hover { background: var(--dsw-alias-interactive-bg-hover); }
.alphasolve-run:focus-visible, .alphasolve-retry:focus-visible, .alphasolve-header:focus-visible, .alphasolve-worker-summary:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset: 2px; }
.alphasolve-state { width: 14px; min-width: 14px; display: flex; justify-content: center; padding-top: 3px; }
.alphasolve-run-content { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; overflow-wrap: anywhere; }
.alphasolve-run-title { font-weight: 500; }
.alphasolve-secondary { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.alphasolve-open { color: var(--dsw-alias-label-secondary); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.alphasolve-helpers { margin-left: 14px; padding-left: 8px; border-left: 1px solid var(--dsw-alias-border-l1); }
.alphasolve-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.alphasolve-retry { color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: transparent; padding: 3px 8px; font: inherit; cursor: pointer; }
.alphasolve-waiting { padding-top: 8px; }
.alphasolve-header { display: inline-flex; gap: 4px; align-items: center; min-height: 28px; padding: 3px 2px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: pointer; }
.alphasolve-header:hover { color: var(--dsw-alias-label-primary); }
`
