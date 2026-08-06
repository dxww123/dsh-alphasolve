/** Small persistence helpers built on DSH's reviewed atomic replacement primitive. */

import { readFile } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Error thrown when durable JSON is malformed or has an unexpected root shape. */
export class DurableDataError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`${message}: ${path}`, options)
    this.name = 'DurableDataError'
  }
}

/** Atomically replace a user-private UTF-8 text file. */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
}

/** Atomically replace a user-private JSON file with stable human-readable output. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Read JSON and fail with a path-bearing diagnostic. */
export async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new DurableDataError('unable to read durable JSON', path, { cause: error })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new DurableDataError('malformed durable JSON', path, { cause: error })
  }
}

/** Read an object-rooted JSON document. */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const value = await readJson(path)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableDataError('durable JSON root must be an object', path)
  }
  return value as Record<string, unknown>
}

/** Whether a wrapped filesystem failure represents a missing path. */
function isMissing(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return true
  return ((error as Error | null)?.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Serialize a read-modify-write update across processes. */
export async function updateJsonObject<T>(
  path: string,
  update: (current: Record<string, unknown> | undefined) => T | Promise<T>,
): Promise<T> {
  return withFileLock(path, async () => {
    let current: Record<string, unknown> | undefined
    try {
      current = await readJsonObject(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const next = await update(current)
    await atomicWriteJson(path, next)
    return next
  })
}
