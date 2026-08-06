import { randomUUID } from "node:crypto"
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

export const VERIFIED_REFERENCE_PATTERN = /\\ref\{([^{}]+)\}/g

export type SolutionAssemblyErrorCode =
  | "invalid-reference"
  | "path-escape"
  | "missing-proposition"
  | "not-a-file"
  | "cyclic-reference"
  | "unsafe-verified-root"
  | "cross-device-temp"

export class SolutionAssemblyError extends Error {
  constructor(
    readonly code: SolutionAssemblyErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message)
    this.name = "SolutionAssemblyError"
  }
}

export interface OrderedProposition {
  /** Backslash-free, extension-free path relative to verified_propositions. */
  label: string
  path: string
  content: string
}

export interface AssembleSolutionOptions {
  problemText: string
  verifiedDir: string
  finalPropositionPath: string
}

export interface AssembledSolution {
  text: string
  propositions: readonly OrderedProposition[]
}

export interface AtomicWriteOptions {
  /** Must be on the same filesystem as targetPath. */
  tempDir?: string
  /** Rename over an existing target. Preflight must have authorized/backed it up. */
  replaceExisting?: boolean
}

export interface WriteSolutionOptions extends AssembleSolutionOptions, AtomicWriteOptions {
  solutionPath: string
}

export interface WrittenSolution extends AssembledSolution {
  solutionPath: string
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/**
 * Convert AlphaSolve's backslash citation syntax into a canonical POSIX label.
 * No filesystem lookup happens here.
 */
export function normalizeVerifiedReference(rawReference: string): string {
  const raw = rawReference.trim()
  if (!raw || raw.includes("\0")) {
    throw new SolutionAssemblyError("invalid-reference", "verified proposition reference is empty or invalid")
  }
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new SolutionAssemblyError("path-escape", `absolute verified proposition reference is forbidden: ${raw}`)
  }

  const normalized = raw.replaceAll("\\", "/")
  const components = normalized.split("/")
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new SolutionAssemblyError("path-escape", `verified proposition reference escapes its root: ${raw}`)
  }
  if (components.some((component) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component))) {
    throw new SolutionAssemblyError("invalid-reference", `invalid verified proposition reference: ${raw}`)
  }
  if (components.at(-1)?.toLowerCase().endsWith(".md")) {
    throw new SolutionAssemblyError("invalid-reference", `verified proposition references must omit .md: ${raw}`)
  }
  return components.join("/")
}

/** Extract unique references in first-appearance order. */
export function extractVerifiedReferences(text: string): string[] {
  const references: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(VERIFIED_REFERENCE_PATTERN)) {
    const label = normalizeVerifiedReference(match[1] ?? "")
    if (seen.has(label)) continue
    seen.add(label)
    references.push(label)
  }
  return references
}

async function canonicalVerifiedRoot(verifiedDir: string): Promise<string> {
  const lexicalRoot = path.resolve(verifiedDir)
  let rootInfo
  try {
    rootInfo = await lstat(lexicalRoot)
  } catch (error) {
    throw new SolutionAssemblyError("unsafe-verified-root", `verified_propositions is unavailable: ${lexicalRoot}`, {
      cause: String(error),
    })
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new SolutionAssemblyError(
      "unsafe-verified-root",
      `verified_propositions must be a real directory, not a file or symlink: ${lexicalRoot}`,
    )
  }
  return realpath(lexicalRoot)
}

async function resolveRegularFileWithin(
  root: string,
  lexicalPath: string,
  display: string,
): Promise<string> {
  if (!isInside(root, lexicalPath)) {
    throw new SolutionAssemblyError("path-escape", `proposition path escapes verified_propositions: ${display}`)
  }

  let canonicalPath: string
  try {
    canonicalPath = await realpath(lexicalPath)
  } catch (error) {
    throw new SolutionAssemblyError("missing-proposition", `missing verified proposition: ${display}`, {
      cause: String(error),
    })
  }
  if (!isInside(root, canonicalPath)) {
    throw new SolutionAssemblyError(
      "path-escape",
      `verified proposition symlink escapes verified_propositions: ${display}`,
      { resolvedPath: canonicalPath },
    )
  }
  const info = await stat(canonicalPath)
  if (!info.isFile()) {
    throw new SolutionAssemblyError("not-a-file", `verified proposition is not a regular file: ${display}`)
  }
  return canonicalPath
}

/**
 * Assemble solution.md in memory. It performs a fail-closed DFS and returns
 * dependencies before the propositions that cite them.
 */
export async function assembleSolution(options: AssembleSolutionOptions): Promise<AssembledSolution> {
  const root = await canonicalVerifiedRoot(options.verifiedDir)
  const lexicalRoot = path.resolve(options.verifiedDir)
  const lexicalFinal = path.resolve(options.finalPropositionPath)
  if (!isInside(lexicalRoot, lexicalFinal)) {
    throw new SolutionAssemblyError(
      "path-escape",
      `final proposition must be inside verified_propositions: ${options.finalPropositionPath}`,
    )
  }

  const finalRelative = path.relative(lexicalRoot, lexicalFinal).split(path.sep).join("/")
  if (!finalRelative.toLowerCase().endsWith(".md")) {
    throw new SolutionAssemblyError("invalid-reference", "final proposition must be a Markdown file")
  }
  const finalLabel = normalizeVerifiedReference(finalRelative.slice(0, -3))

  const ordered: OrderedProposition[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const stack: string[] = []

  const visit = async (label: string, lexicalPath: string): Promise<void> => {
    const canonicalPath = await resolveRegularFileWithin(root, lexicalPath, label)
    if (visited.has(canonicalPath)) return
    if (visiting.has(canonicalPath)) {
      throw new SolutionAssemblyError(
        "cyclic-reference",
        `cyclic proposition reference detected: ${[...stack, label].join(" -> ")}`,
      )
    }

    visiting.add(canonicalPath)
    stack.push(label)
    const content = await readFile(canonicalPath, "utf8")
    for (const reference of extractVerifiedReferences(content)) {
      const dependencyPath = path.resolve(root, ...reference.split("/")) + ".md"
      await visit(reference, dependencyPath)
    }
    stack.pop()
    visiting.delete(canonicalPath)
    visited.add(canonicalPath)
    ordered.push({ label, path: canonicalPath, content })
  }

  await visit(finalLabel, lexicalFinal)

  const output: string[] = [
    "# Solution",
    "",
    "## Problem",
    "",
    options.problemText.trim(),
    "",
    "## Verified Proposition Chain",
    "",
  ]
  ordered.forEach((proposition, index) => {
    output.push(
      `### ${index + 1}. ${path.posix.basename(proposition.label)}`,
      "",
      proposition.content.trim(),
      "",
    )
  })

  return {
    text: `${output.join("\n").trimEnd()}\n`,
    propositions: ordered,
  }
}

/**
 * Write a complete text file atomically using a same-filesystem temporary.
 * With replaceExisting=false, hard-link publication makes EEXIST fail closed.
 */
export async function writeTextAtomically(
  targetPath: string,
  text: string,
  options: AtomicWriteOptions = {},
): Promise<string> {
  const target = path.resolve(targetPath)
  const targetDirectory = path.dirname(target)
  const tempDirectory = path.resolve(options.tempDir ?? path.join(targetDirectory, ".alphasolve", "tmp"))
  await mkdir(targetDirectory, { recursive: true })
  await mkdir(tempDirectory, { recursive: true })

  const [targetDirectoryInfo, tempDirectoryInfo] = await Promise.all([
    stat(targetDirectory),
    stat(tempDirectory),
  ])
  if (targetDirectoryInfo.dev !== tempDirectoryInfo.dev) {
    throw new SolutionAssemblyError(
      "cross-device-temp",
      `atomic write temp directory is on another filesystem: ${tempDirectory}`,
    )
  }

  const temporary = path.join(tempDirectory, `solution-${process.pid}-${randomUUID()}.tmp`)
  let temporaryExists = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    temporaryExists = true
    try {
      await handle.writeFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (options.replaceExisting) {
      await rename(temporary, target)
      temporaryExists = false
    } else {
      await link(temporary, target)
      await unlink(temporary)
      temporaryExists = false
    }
    return target
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

/** Assemble, validate, and atomically publish solution.md. */
export async function writeSolutionAtomically(options: WriteSolutionOptions): Promise<WrittenSolution> {
  const assembled = await assembleSolution(options)
  const solutionPath = await writeTextAtomically(options.solutionPath, assembled.text, options)
  return { ...assembled, solutionPath }
}
