/** AlphaSolve for DSH: dormant controller with session-scoped hot activation. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { AlphaSolveController } from './controller.js'

export * from './controller.js'
export * from './runtime.js'
export * from './types.js'

export const name = 'dsh-alphasolve'
export const inject = ['agents', 'tools', 'systemPrompt']

export interface Config {
  /** Built-in fallback after prompt, project, and user configuration (default 2). */
  readonly defaultCapacity?: number
  /** Built-in trace-persistence fallback (default true). */
  readonly defaultDetailedTrace?: boolean
}

export const Config: z<Config> = z.object({
  defaultCapacity: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  defaultDetailedTrace: z.boolean().default(true),
})

/** Install only the dormant trigger listener. It contributes no global tool or prompt. */
export function apply(ctx: Context, config: Config = {}): () => Promise<void> {
  const controller = new AlphaSolveController(ctx, {
    defaultCapacity: config.defaultCapacity ?? 2,
    defaultDetailedTrace: config.defaultDetailedTrace ?? true,
  })
  return controller.install()
}
