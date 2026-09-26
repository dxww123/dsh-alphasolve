/** Durable identity of the curator conversation for one main Session and problem. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { atomicWriteJson } from './atomic.js'
import type { RoleSessionContinuation } from './role-runner.js'
import { readWorkspaceInput, resolveWorkspacePath } from './workspace.js'

/** Archived with the generation when AlphaSolve changes problems. */
export const CURATOR_SESSION_PATH = '.alphasolve/curator/session.json'
const identitySchema = z.object({
  version: z.literal(1), parentSessionId: z.string().min(1), sessionId: z.uuid(), problemDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

/** Read and validate the optional curator identity before use or generation archival. */
export async function readCuratorSessionIdentity(workspace: string): Promise<z.infer<typeof identitySchema> | undefined> {
  const file = path.join(workspace, CURATOR_SESSION_PATH)
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Curator Session identity must be an ordinary file')
    return identitySchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Select the stored curator log, without replacing missing or corrupt Harness history.
 * @param workspace Canonical workspace under the AlphaSolve runtime lock.
 * @param parentSessionId Main Session that owns this curator.
 * @returns Fresh or resume identity; ready records it after the log's durability barrier.
 */
export async function prepareCuratorSession(workspace: string, parentSessionId: SessionId): Promise<RoleSessionContinuation> {
  const directory = await resolveWorkspacePath(workspace, '.alphasolve/curator', { mustExist: false })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== path.join(workspace, '.alphasolve', 'curator')) {
    throw new Error('Curator Session directory must not be a symbolic link')
  }
  const file = path.join(directory, 'session.json')
  const problem = await readWorkspaceInput(workspace, 'problem.md', { nonEmpty: true })
  const prior = await readCuratorSessionIdentity(workspace)
  if (prior?.parentSessionId === parentSessionId && prior.problemDigest === problem.digest) {
    return { id: SessionId(prior.sessionId), resume: true, ready: async () => undefined }
  }
  const id = SessionId(randomUUID())
  return { id, resume: false, ready: () => atomicWriteJson(file, {
    version: 1, parentSessionId, sessionId: id, problemDigest: problem.digest,
  }) }
}
