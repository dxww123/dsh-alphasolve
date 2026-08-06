/** Read-only Markdown navigation helpers for the AlphaSolve research reviewer. */

import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

import {
  canonicalWorkspace,
  normalizeRelativePath,
  readWorkspaceInput,
  resolveWorkspacePath,
  WorkspaceError,
} from './workspace.js'

export const RESEARCH_REVIEW_TOOL_NAMES = Object.freeze({
  progress: 'alphasolve_research_progress_review',
  inspectMarkdown: 'alphasolve_inspect_markdown',
} as const)

export interface MarkdownReviewEntry {
  readonly path: string
  readonly headings: readonly string[]
  readonly statementOrProgress: string
  readonly tail: string
  readonly totalLines: number
}

export interface ResearchProgressResult {
  readonly files: readonly MarkdownReviewEntry[]
  readonly scanned: number
  readonly truncated: boolean
  readonly suggestedInspectionPaths: readonly string[]
}

export interface InspectMarkdownOptions {
  readonly maxFiles?: number
  readonly tailLines?: number
  readonly statementLines?: number
}

const AUTO_ROOTS = ['problem.md', 'verified_propositions', 'knowledge'] as const
const REVIEW_SECTION = /\b(?:statement|current status|progress|remaining gaps?|open gaps?|blockers?|index)\b/i
const STATEMENT_SECTION = /\bstatement\b/i
const PROOF_SECTION = /\bproof\b/i
const GAP_SECTION = /\b(?:remaining gaps?|open gaps?|blockers?|obstacles?|todo|next steps?)\b/i
const GAP_SIGNAL = /\b(?:remaining gaps?|open gaps?|blockers?|obstacles?|unresolved|missing|todo|stuck|failed)\b/i
const CONCLUSION_SIGNAL = /\b(?:therefore|hence|thus|consequently|implies|proves?|proved|complete|solved|qed|optimal|exact)\b|(?:所以|因此|从而|故|得证|已解决|最优|精确)/i
const ANSWER_SIGNAL = /\b(?:answer|objective|optimum|optimal|exact|value|bound|classification|construction|target|stopping)\b|(?:答案|目标|最优|界|分类|构造|停止)/i
const FOCUS_STOPWORDS = new Set([
  'about', 'after', 'also', 'because', 'before', 'could', 'determine', 'find', 'from', 'given',
  'have', 'into', 'problem', 'prove', 'show', 'that', 'their', 'there', 'these', 'this', 'using',
  'what', 'when', 'where', 'which', 'with', 'would',
])

/** Hard cap for the complete JSON result returned by progressReview. */
export const RESEARCH_PROGRESS_CHARACTER_BUDGET = 24_000
/** Normal broad-workspace target count before the global budget is applied. */
export const RESEARCH_PROGRESS_DEFAULT_CANDIDATES = 16

type CandidateGroup = 'problem' | 'verified_index' | 'verified' | 'knowledge_index' | 'knowledge'

interface ReviewCandidate {
  readonly entry: MarkdownReviewEntry
  readonly group: CandidateGroup
  readonly score: number
  readonly depth: number
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(`${label} must be an integer from 1 to ${maximum}`)
  }
  return result
}

function allowedRelative(input: string): string {
  if (input === '.') return input
  const relative = normalizeRelativePath(input)
  if (relative === 'problem.md'
    || relative === 'knowledge'
    || relative.startsWith('knowledge/')
    || relative === 'verified_propositions'
    || relative.startsWith('verified_propositions/')) {
    return relative
  }
  throw new WorkspaceError(
    'research review is restricted to problem.md, knowledge/, and verified_propositions/',
    input,
  )
}

function posixRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/')
}

function selectedSection(lines: readonly string[], maximum: number): string {
  const heading = lines.findIndex(line => /^#{1,6}\s+/.test(line) && REVIEW_SECTION.test(line))
  if (heading < 0) return lines.slice(0, Math.min(maximum, lines.length)).join('\n')
  let end = heading + 1
  while (end < lines.length && end - heading < maximum && !/^#{1,6}\s+/.test(lines[end] ?? '')) end += 1
  return lines.slice(heading, end).join('\n')
}

function reviewEntry(relative: string, content: string, tailLines: number, statementLines: number): MarkdownReviewEntry {
  const lines = content.split(/\r\n|\n|\r/)
  return {
    path: relative,
    headings: lines.filter(line => /^#{1,6}\s+/.test(line)).slice(0, 80),
    statementOrProgress: selectedSection(lines, statementLines),
    tail: lines.slice(Math.max(0, lines.length - tailLines)).join('\n'),
    totalLines: lines.length,
  }
}

function sectionMatching(lines: readonly string[], pattern: RegExp, maximum: number): string {
  const heading = lines.findIndex(line => /^#{1,6}\s+/.test(line) && pattern.test(line))
  if (heading < 0) return ''
  const marker = /^(#{1,6})\s+/.exec(lines[heading] ?? '')
  const level = marker?.[1]?.length ?? 6
  let end = heading + 1
  while (end < lines.length && end - heading < maximum) {
    const next = /^(#{1,6})\s+/.exec(lines[end] ?? '')
    if (next !== null && (next[1]?.length ?? 6) <= level) break
    end += 1
  }
  return lines.slice(heading, end).join('\n').trim()
}

function proofTail(lines: readonly string[], maximum: number): string {
  let proofHeading = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index] ?? '') && PROOF_SECTION.test(lines[index] ?? '')) proofHeading = index
  }
  if (proofHeading < 0) return lines.slice(Math.max(0, lines.length - maximum)).join('\n').trim()
  const marker = /^(#{1,6})\s+/.exec(lines[proofHeading] ?? '')
  const level = marker?.[1]?.length ?? 6
  let end = proofHeading + 1
  while (end < lines.length) {
    const next = /^(#{1,6})\s+/.exec(lines[end] ?? '')
    if (next !== null && (next[1]?.length ?? 6) <= level) break
    end += 1
  }
  return lines.slice(Math.max(proofHeading, end - maximum), end).join('\n').trim()
}

function truncateHead(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  if (maximum <= 1) return value.slice(0, maximum)
  return `${value.slice(0, maximum - 1).trimEnd()}…`
}

function truncateTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  if (maximum <= 1) return value.slice(-maximum)
  return `…${value.slice(-(maximum - 1)).trimStart()}`
}

function candidateGroup(relative: string): CandidateGroup {
  if (relative === 'problem.md') return 'problem'
  const basename = path.posix.basename(relative).toLowerCase()
  if (relative.startsWith('verified_propositions/')) {
    return basename === 'index.md' || basename === 'state.md' ? 'verified_index' : 'verified'
  }
  return basename === 'index.md' || basename === 'state.md' ? 'knowledge_index' : 'knowledge'
}

function groupPriority(group: CandidateGroup): number {
  return group === 'problem' ? 0
    : group === 'verified_index' ? 1
      : group === 'verified' ? 2
        : group === 'knowledge_index' ? 3 : 4
}

function focusTerms(problem: string): readonly string[] {
  const terms = problem.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []
  return [...new Set(terms.filter(term => !FOCUS_STOPWORDS.has(term)))].slice(0, 40)
}

function progressEntry(relative: string, content: string): MarkdownReviewEntry {
  const lines = content.split(/\r\n|\n|\r/)
  const group = candidateGroup(relative)
  let statementOrProgress: string
  let tail = ''
  if (group === 'problem') {
    statementOrProgress = lines.slice(0, 24).join('\n').trim()
  } else if (group === 'verified' || group === 'verified_index') {
    statementOrProgress = sectionMatching(lines, STATEMENT_SECTION, 20)
      || selectedSection(lines, 16).trim()
    tail = proofTail(lines, 12)
  } else {
    statementOrProgress = sectionMatching(lines, GAP_SECTION, 18)
      || selectedSection(lines, 16).trim()
    tail = GAP_SIGNAL.test(statementOrProgress)
      ? ''
      : lines.slice(Math.max(0, lines.length - 8)).join('\n').trim()
  }
  if (tail === statementOrProgress) tail = ''
  return {
    path: relative,
    headings: lines.filter(line => /^#{1,6}\s+/.test(line)).slice(0, 12),
    statementOrProgress,
    tail,
    totalLines: lines.length,
  }
}

function scoreCandidate(relative: string, content: string, problemTerms: readonly string[]): ReviewCandidate {
  const entry = progressEntry(relative, content)
  const lower = content.toLocaleLowerCase()
  const focus = problemTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0)
  const signalLines = content.split(/\r\n|\n|\r/)
  const gaps = Math.min(10, signalLines.filter(line => GAP_SIGNAL.test(line)).length)
  const conclusions = Math.min(8, signalLines.slice(-30)
    .filter(line => !/^\s*>/.test(line) && CONCLUSION_SIGNAL.test(line)).length)
  const answerChanging = ANSWER_SIGNAL.test(entry.tail) || ANSWER_SIGNAL.test(entry.statementOrProgress)
  const basename = path.posix.basename(relative).toLocaleLowerCase()
  const pathSignal = /(?:gap|blocker|progress|status|summary|result|objective|answer)/i.test(basename) ? 30 : 0
  const depth = relative.split('/').length
  const referencePenalty = relative.startsWith('knowledge/references/') ? 120 : 0
  return {
    entry,
    group: candidateGroup(relative),
    score: focus * 24 + gaps * 14 + conclusions * 12 + (answerChanging ? 40 : 0)
      + pathSignal - depth * 8 - referencePenalty,
    depth,
  }
}

function compareCandidates(left: ReviewCandidate, right: ReviewCandidate): number {
  return groupPriority(left.group) - groupPriority(right.group)
    || right.score - left.score
    || left.depth - right.depth
    || left.entry.path.localeCompare(right.entry.path)
}

function selectCandidates(candidates: readonly ReviewCandidate[]): readonly ReviewCandidate[] {
  const target = Math.min(RESEARCH_PROGRESS_DEFAULT_CANDIDATES, candidates.length)
  const selected: ReviewCandidate[] = []
  const selectedPaths = new Set<string>()
  const quotas: Readonly<Record<CandidateGroup, number>> = {
    problem: 1,
    verified_index: 1,
    verified: 8,
    knowledge_index: 1,
    knowledge: 5,
  }
  const add = (candidate: ReviewCandidate): void => {
    if (selected.length >= target || selectedPaths.has(candidate.entry.path)) return
    selected.push(candidate)
    selectedPaths.add(candidate.entry.path)
  }
  for (const group of ['problem', 'verified_index', 'verified', 'knowledge_index', 'knowledge'] as const) {
    for (const candidate of candidates.filter(item => item.group === group)
      .sort((left, right) => right.score - left.score
        || left.depth - right.depth || left.entry.path.localeCompare(right.entry.path))
      .slice(0, quotas[group])) add(candidate)
  }
  for (const candidate of [...candidates].sort(compareCandidates)) add(candidate)
  return selected.sort(compareCandidates)
}

function compactEntry(
  entry: MarkdownReviewEntry,
  limits: { readonly headings: number; readonly headingChars: number; readonly statement: number; readonly tail: number },
): MarkdownReviewEntry {
  return {
    ...entry,
    headings: entry.headings.slice(0, limits.headings).map(heading => truncateHead(heading, limits.headingChars)),
    statementOrProgress: truncateHead(entry.statementOrProgress, limits.statement),
    tail: truncateTail(entry.tail, limits.tail),
  }
}

function budgetedProgressResult(
  selected: readonly ReviewCandidate[],
  scanned: number,
  sourceTruncated: boolean,
): ResearchProgressResult {
  let files = selected.map(candidate => compactEntry(candidate.entry, {
    headings: 5,
    headingChars: 120,
    statement: candidate.group === 'problem' ? 1_400 : 650,
    tail: 500,
  }))
  const build = (): ResearchProgressResult => ({
    files,
    scanned,
    truncated: sourceTruncated || files.length < scanned,
    suggestedInspectionPaths: files.slice(0, 12).map(file => file.path),
  })
  const size = (): number => JSON.stringify(build()).length
  const normalMinimum = Math.min(10, files.length)
  while (size() > RESEARCH_PROGRESS_CHARACTER_BUDGET && files.length > normalMinimum) files = files.slice(0, -1)
  if (size() > RESEARCH_PROGRESS_CHARACTER_BUDGET) {
    files = files.map(file => compactEntry(file, {
      headings: 3,
      headingChars: 90,
      statement: file.path === 'problem.md' ? 700 : 360,
      tail: 260,
    }))
  }
  while (size() > RESEARCH_PROGRESS_CHARACTER_BUDGET && files.length > 1) files = files.slice(0, -1)
  if (size() > RESEARCH_PROGRESS_CHARACTER_BUDGET) {
    files = files.map(file => compactEntry(file, {
      headings: 1,
      headingChars: 60,
      statement: 120,
      tail: 100,
    }))
  }
  while (size() > RESEARCH_PROGRESS_CHARACTER_BUDGET && files.length > 1) files = files.slice(0, -1)
  return build()
}

/** Scans no path outside the research reviewer's frozen read boundary. */
export class ResearchReviewTools {
  private constructor(public readonly workspaceRoot: string) {}

  static async create(workspace: string): Promise<ResearchReviewTools> {
    return new ResearchReviewTools(await canonicalWorkspace(workspace))
  }

  private async collect(inputs: readonly string[], maximum: number): Promise<{
    readonly paths: readonly string[]
    readonly truncated: boolean
  }> {
    const requested = inputs.length === 0 ? ['.'] : inputs
    const roots = requested.flatMap(input => allowedRelative(input) === '.' ? [...AUTO_ROOTS] : [allowedRelative(input)])
    const found = new Set<string>()
    const pending = [...roots].reverse()
    let truncated = false

    while (pending.length > 0) {
      const relative = pending.pop()
      if (relative === undefined || found.has(relative)) continue
      const absolute = await resolveWorkspacePath(this.workspaceRoot, relative, { mustExist: true })
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new WorkspaceError('research review does not follow symbolic links', relative)
      if (info.isFile()) {
        if (path.extname(relative).toLowerCase() !== '.md') {
          throw new WorkspaceError('research review accepts only Markdown files', relative)
        }
        if (found.size >= maximum) {
          truncated = true
          break
        }
        found.add(relative)
        continue
      }
      if (!info.isDirectory()) throw new WorkspaceError('research review path is not a file or directory', relative)
      const children = await readdir(absolute, { withFileTypes: true })
      for (const child of children.sort((left, right) => right.name.localeCompare(left.name))) {
        const childAbsolute = path.join(absolute, child.name)
        const childRelative = posixRelative(this.workspaceRoot, childAbsolute)
        allowedRelative(childRelative)
        if (child.isSymbolicLink()) throw new WorkspaceError('research review does not follow symbolic links', childRelative)
        if (child.isDirectory() || (child.isFile() && child.name.toLowerCase().endsWith('.md'))) {
          pending.push(childRelative)
        }
      }
    }
    return { paths: [...found], truncated }
  }

  /** Share broad scan capacity across roots so one large tree cannot hide the others. */
  private async collectProgress(inputs: readonly string[], maximum: number): Promise<{
    readonly paths: readonly string[]
    readonly truncated: boolean
  }> {
    const requested = inputs.length === 0 ? ['.'] : inputs
    const roots = [...new Set(requested.flatMap(input => (
      allowedRelative(input) === '.' ? [...AUTO_ROOTS] : [allowedRelative(input)]
    )))]
    const paths: string[] = []
    const seen = new Set<string>()
    let remaining = maximum
    let truncated = false
    for (let index = 0; index < roots.length; index += 1) {
      if (remaining <= 0) {
        truncated = true
        break
      }
      const slots = Math.max(1, Math.floor(remaining / (roots.length - index)))
      const collected = await this.collect([roots[index] as string], slots)
      truncated ||= collected.truncated
      for (const relative of collected.paths) {
        if (seen.has(relative) || paths.length >= maximum) continue
        seen.add(relative)
        paths.push(relative)
        remaining -= 1
      }
    }
    return { paths, truncated }
  }

  async inspectMarkdown(
    requestedPath = '.',
    options: InspectMarkdownOptions = {},
  ): Promise<ResearchProgressResult> {
    const maxFiles = boundedInteger(options.maxFiles, 8, 100, 'maxFiles')
    const tailLines = boundedInteger(options.tailLines, 40, 200, 'tailLines')
    const statementLines = boundedInteger(options.statementLines, 80, 300, 'statementLines')
    const collected = await this.collect([requestedPath], maxFiles)
    const files = await Promise.all(collected.paths.map(async relative => {
      const input = await readWorkspaceInput(this.workspaceRoot, relative, { nonEmpty: false })
      return reviewEntry(relative, input.content, tailLines, statementLines)
    }))
    return {
      files,
      scanned: files.length,
      truncated: collected.truncated,
      suggestedInspectionPaths: files.map(file => file.path),
    }
  }

  async progressReview(options: {
    readonly path?: string
    readonly paths?: readonly string[]
    readonly maxFiles?: number
  } = {}): Promise<ResearchProgressResult> {
    // maxFiles bounds the structural scan, not the returned context size.
    // The latter is independently capped by a candidate count and character budget.
    const maxFiles = boundedInteger(options.maxFiles, 200, 500, 'maxFiles')
    const requested = options.paths !== undefined && options.paths.length > 0
      ? options.paths
      : [options.path ?? '.']
    const collected = await this.collectProgress(requested, maxFiles)
    const contents = await Promise.all(collected.paths.map(async relative => {
      const input = await readWorkspaceInput(this.workspaceRoot, relative, { nonEmpty: false })
      return { relative, content: input.content }
    }))
    let problem = contents.find(item => item.relative === 'problem.md')?.content ?? ''
    if (problem === '') {
      try {
        problem = (await readWorkspaceInput(this.workspaceRoot, 'problem.md', { nonEmpty: false })).content
      } catch (error) {
        if (!(error instanceof WorkspaceError && error.message.startsWith('required path does not exist'))) throw error
      }
    }
    const problemTerms = focusTerms(problem)
    const candidates = contents.map(item => scoreCandidate(item.relative, item.content, problemTerms))
    return budgetedProgressResult(selectCandidates(candidates), candidates.length, collected.truncated)
  }
}

export async function createResearchReviewTools(workspace: string): Promise<ResearchReviewTools> {
  return ResearchReviewTools.create(workspace)
}
