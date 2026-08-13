/** Fixed AlphaSolve worker workflow, independent of the concrete DSH role runner. */

import { randomUUID } from 'node:crypto'
import { cp, copyFile, lstat, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import path from 'node:path'

import {
  extractStatement,
  parsePropositionFilename,
  parseVerifierVerdict,
  solvesOriginalProblem,
} from './parsers.js'
import {
  ROLE_MAX_TURNS,
  VERIFIER_PROFILE_ORDER,
  buildGeneratorTask,
  buildPropositionFilenameTask,
  buildReviserTask,
  buildReviewVerdictTask,
  buildTheoremCheckerTask,
  buildVerifierTask,
  loadRolePrompt,
  type RolePromptName,
} from './prompts.js'
import { writeSolutionAtomically, writeTextAtomically } from './solution.js'
import type { FileStamp, VerifierProfile, WorkerRecord } from './types.js'
import type {
  WorkerExecutionContext,
  WorkerExecutor,
  WorkflowResult,
} from './worker-manager.js'
import {
  assertFileStamp,
  captureFileStamp,
  readWorkspaceInput,
  resolveWorkspacePath,
  workspaceFileExists,
} from './workspace.js'

export const MAX_VERIFY_ROUNDS = 6
export const THEOREM_CHECK_ATTEMPTS = 5

export type WorkflowRole =
  | 'generator'
  | 'verifier_format_references'
  | 'verifier_citation'
  | 'verifier_failure_modes'
  | 'verifier_stepwise'
  | 'verifier_premise_chain'
  | 'review_verdict_judge'
  | 'reviser'
  | 'theorem_checker'

export interface RoleInvocation {
  readonly role: WorkflowRole
  readonly workerId: string
  /** A fresh Agent must use this as its cwd. */
  readonly cwd: string
  readonly workspace: string
  readonly workerDirectory: string
  readonly propositionPath: string
  readonly theoremViewDirectory?: string
  readonly verifierProfile?: VerifierProfile
  readonly workflowRound?: number
  readonly verifierAttempt?: number
  readonly theoremAttempt?: number
  readonly expectedPropositionStamp?: FileStamp
  readonly persona: string
  readonly task: string
  readonly maxTurns: number
  readonly signal: AbortSignal
}

export interface RoleInvocationResult {
  readonly text: string
  readonly trace?: readonly unknown[]
  readonly artifactPaths?: readonly string[]
}

/** The implementation must create and dispose a fresh DSH Agent for every call. */
export interface RoleInvoker {
  invoke(request: RoleInvocation): Promise<RoleInvocationResult>
  /** Workspace-relative durable trace artifacts accumulated for this worker. */
  artifactPaths?(workerId: string): readonly string[]
}

export interface PropositionFilenameRequest {
  readonly workerId: string
  readonly propositionText: string
  readonly prompt: string
  readonly signal: AbortSignal
}

/** Return the raw filename-model answer; the workflow always sanitizes it. */
export type PropositionFilenameBuilder = (request: PropositionFilenameRequest) => Promise<string>

export interface SolutionPublishRequest {
  readonly workerId: string
  readonly workspace: string
  readonly problemText: string
  readonly verifiedDir: string
  readonly finalPropositionPath: string
  readonly solutionPath: string
  readonly signal: AbortSignal
}

export type SolutionPublisher = (request: SolutionPublishRequest) => Promise<string>

export interface FixedWorkflowOptions {
  readonly workspace: string
  readonly invoker: RoleInvoker
  readonly filenameBuilder?: PropositionFilenameBuilder
  readonly solutionPublisher?: SolutionPublisher
  /** Preflight must have explicitly authorized and backed up this replacement. */
  readonly replaceExistingSolution?: boolean
}

export class PropositionWriteConflictError extends Error {
  constructor(message = 'active proposition changed outside its owning role', options?: ErrorOptions) {
    super(message, options)
    this.name = 'PropositionWriteConflictError'
  }
}

interface WorkerPaths {
  readonly workerRelative: string
  readonly workerDirectory: string
  readonly propositionRelative: string
  readonly propositionPath: string
  readonly reviewRelative: string
  readonly reviewPath: string
  readonly theoremCheckRelative: string
  readonly theoremCheckPath: string
  readonly verifiedDir: string
  readonly solutionPath: string
}

interface CandidateView {
  readonly root: string
  readonly verifiedDir: string
  readonly candidatePath: string
  readonly candidateRelativeForAgent: string
}

interface VerificationFailure {
  readonly profile: VerifierProfile
  readonly review: string
}

/**
 * A role or its result-processing infrastructure failed before it produced a
 * completed mathematical verdict.  This is deliberately distinct from a
 * verifier's explicit (or completed-but-ambiguous) fail verdict: only the
 * latter is useful input to the reviser.
 */
class WorkflowInfrastructureError extends Error {
  constructor(
    readonly stage: string,
    error: unknown,
  ) {
    const detail = error instanceof Error ? error.message : String(error)
    super(`${stage} infrastructure failure: ${detail}`, { cause: error })
    this.name = 'WorkflowInfrastructureError'
  }
}

const PROFILE_TO_SHORT: Readonly<Record<(typeof VERIFIER_PROFILE_ORDER)[number], VerifierProfile>> = {
  verifier_format_references: 'format_references',
  verifier_citation: 'citation',
  verifier_failure_modes: 'failure_modes',
  verifier_stepwise: 'stepwise',
  verifier_premise_chain: 'premise_chain',
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('worker cancelled', 'AbortError')
}

function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function safeWorkerId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new TypeError(`unsafe worker id: ${id}`)
  return id
}

async function makeWorkerPaths(workspace: string, workerId: string): Promise<WorkerPaths> {
  const id = safeWorkerId(workerId)
  const workerRelative = `unverified_propositions/prop-${id}`
  const propositionRelative = `${workerRelative}/proposition.md`
  const reviewRelative = `${workerRelative}/review.md`
  const theoremCheckRelative = `${workerRelative}/theorem_check.md`
  const [workerDirectory, propositionPath, reviewPath, theoremCheckPath, verifiedDir, solutionPath] = await Promise.all([
    resolveWorkspacePath(workspace, workerRelative, { mustExist: false }),
    resolveWorkspacePath(workspace, propositionRelative, { mustExist: false }),
    resolveWorkspacePath(workspace, reviewRelative, { mustExist: false }),
    resolveWorkspacePath(workspace, theoremCheckRelative, { mustExist: false }),
    resolveWorkspacePath(workspace, 'verified_propositions', { mustExist: true }),
    resolveWorkspacePath(workspace, 'solution.md', { mustExist: false }),
  ])
  return {
    workerRelative,
    workerDirectory,
    propositionRelative,
    propositionPath,
    reviewRelative,
    reviewPath,
    theoremCheckRelative,
    theoremCheckPath,
    verifiedDir,
    solutionPath,
  }
}

function rolePromptName(role: WorkflowRole): RolePromptName {
  return role
}

function roleMaxTurns(role: WorkflowRole): number {
  return ROLE_MAX_TURNS[rolePromptName(role)]
}

async function invoke(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
  paths: WorkerPaths,
  request: Omit<RoleInvocation, 'workerId' | 'workspace' | 'workerDirectory' | 'propositionPath' | 'signal' | 'maxTurns'>,
): Promise<RoleInvocationResult> {
  throwIfAborted(context.signal)
  return options.invoker.invoke({
    ...request,
    workerId: context.id,
    workspace: options.workspace,
    workerDirectory: paths.workerDirectory,
    propositionPath: paths.propositionPath,
    signal: context.signal,
    maxTurns: roleMaxTurns(request.role),
  })
}

async function assertPropositionUnchanged(
  workspace: string,
  relativePath: string,
  stamp: FileStamp,
): Promise<void> {
  try {
    await assertFileStamp(workspace, relativePath, stamp)
  } catch (error) {
    throw new PropositionWriteConflictError(undefined, { cause: error })
  }
}

async function readCurrentInputs(context: WorkerExecutionContext, workspace: string): Promise<{
  readonly problem: string
  readonly hint?: string
}> {
  await context.assertInputsCurrent()
  const problem = await readWorkspaceInput(workspace, 'problem.md', { nonEmpty: true })
  if (!await workspaceFileExists(workspace, 'hint.md')) return { problem: problem.content }
  const hint = await readWorkspaceInput(workspace, 'hint.md', { nonEmpty: false })
  return { problem: problem.content, hint: hint.content }
}

async function chooseCandidateFilename(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
  paths: WorkerPaths,
  propositionText: string,
): Promise<string> {
  let raw = ''
  if (options.filenameBuilder !== undefined) {
    try {
      raw = await options.filenameBuilder({
        workerId: context.id,
        propositionText,
        prompt: buildPropositionFilenameTask(propositionText),
        signal: context.signal,
      })
    } catch (error) {
      if (context.signal.aborted) throw error
      raw = ''
    }
  }
  const parsed = parsePropositionFilename(raw, context.id)
  const extension = path.extname(parsed)
  const stem = path.basename(parsed, extension)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filename = attempt === 0 ? parsed : `${stem}-${randomUUID().slice(0, 6)}${extension}`
    try {
      await lstat(path.join(paths.verifiedDir, filename))
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return filename
      throw error
    }
  }
  throw new Error('unable to allocate a unique verified proposition filename')
}

async function buildCandidateView(
  workspace: string,
  workerId: string,
  paths: WorkerPaths,
  filename: string,
): Promise<CandidateView> {
  const relativeRoot = `.alphasolve/tmp/theorem-${safeWorkerId(workerId)}-${randomUUID().slice(0, 8)}`
  const root = await resolveWorkspacePath(workspace, relativeRoot, { mustExist: false })
  const verifiedDir = path.join(root, 'verified_propositions')
  await mkdir(root, { recursive: false, mode: 0o700 })
  try {
    await cp(paths.verifiedDir, verifiedDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
    })
    const candidatePath = path.join(verifiedDir, filename)
    await copyFile(paths.propositionPath, candidatePath)
    return {
      root,
      verifiedDir,
      candidatePath,
      candidateRelativeForAgent: `verified_propositions/${filename}`,
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function promoteCandidate(
  paths: WorkerPaths,
  preferredFilename: string,
  content: string,
  tempDir: string,
): Promise<{
  readonly path: string
  readonly relativePath: string
}> {
  const extension = path.extname(preferredFilename)
  const stem = path.basename(preferredFilename, extension)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const filename = attempt === 0
      ? preferredFilename
      : `${stem}-${randomUUID().slice(0, 6)}${extension}`
    const target = path.join(paths.verifiedDir, filename)
    try {
      await writeTextAtomically(target, content, { tempDir })
      return { path: target, relativePath: `verified_propositions/${filename}` }
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error
    }
  }
  throw new Error('unable to atomically promote a verified proposition after filename conflicts')
}

function artifactPaths(paths: WorkerPaths, extras: readonly string[] = []): string[] {
  return [paths.workerRelative, paths.propositionRelative, paths.reviewRelative, ...extras]
}

function workflowArtifactPaths(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
  paths: WorkerPaths,
  extras: readonly string[] = [],
): string[] {
  return [...new Set([
    ...artifactPaths(paths),
    ...(options.invoker.artifactPaths?.(context.id) ?? []),
    ...extras,
  ])]
}

async function runVerificationRound(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
  paths: WorkerPaths,
  propositionText: string,
  propositionStamp: FileStamp,
  round: number,
): Promise<VerificationFailure | undefined> {
  for (const [index, role] of VERIFIER_PROFILE_ORDER.entries()) {
    const profile = PROFILE_TO_SHORT[role]
    await context.assertInputsCurrent()
    await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    await context.progress({ phase: 'verifier', round, verifierProfile: profile })

    let review: string
    try {
      const verifier = await invoke(options, context, paths, {
        role,
        cwd: options.workspace,
        persona: loadRolePrompt(role),
        task: buildVerifierTask({
          propositionPath: paths.propositionRelative,
          propositionText,
          workflowIndex: round,
          attemptIndex: index + 1,
          attemptTotal: VERIFIER_PROFILE_ORDER.length,
          profile,
        }),
        verifierProfile: profile,
        workflowRound: round,
        verifierAttempt: index + 1,
        expectedPropositionStamp: propositionStamp,
      })
      review = verifier.text
      await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    } catch (error) {
      if (context.signal.aborted) throw error
      if (error instanceof PropositionWriteConflictError) throw error
      throw new WorkflowInfrastructureError(`verifier:${profile}`, error)
    }

    try {
      await writeTextAtomically(paths.reviewPath, review, { replaceExisting: true })
    } catch (error) {
      throw new WorkflowInfrastructureError(`verifier:${profile}:review_artifact`, error)
    }
    let verdict: 'pass' | 'fail' = 'fail'
    try {
      const judge = await invoke(options, context, paths, {
        role: 'review_verdict_judge',
        cwd: options.workspace,
        persona: loadRolePrompt('review_verdict_judge'),
        task: buildReviewVerdictTask(review, round, index + 1),
        verifierProfile: profile,
        workflowRound: round,
        verifierAttempt: index + 1,
        expectedPropositionStamp: propositionStamp,
      })
      verdict = parseVerifierVerdict(judge.text)
      await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    } catch (error) {
      if (context.signal.aborted) throw error
      if (error instanceof PropositionWriteConflictError) throw error
      throw new WorkflowInfrastructureError(`review_verdict_judge:${profile}`, error)
    }
    if (verdict !== 'pass') return { profile, review }
  }
  return undefined
}

async function defaultSolutionPublisher(
  request: SolutionPublishRequest,
  replaceExisting: boolean,
): Promise<string> {
  throwIfAborted(request.signal)
  const written = await writeSolutionAtomically({
    problemText: request.problemText,
    verifiedDir: request.verifiedDir,
    finalPropositionPath: request.finalPropositionPath,
    solutionPath: request.solutionPath,
    replaceExisting,
  })
  return written.solutionPath
}

async function executeFixedWorkflow(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
): Promise<WorkflowResult> {
  const paths = await makeWorkerPaths(options.workspace, context.id)
  const artifacts = (): string[] => workflowArtifactPaths(options, context, paths)
  let ownsWinnerClaim = false
  let winnerPromotedPath: string | undefined
  let publishedSolutionPath: string | undefined
  let currentStatement: string | undefined
  const rollbackPublishedSolution = async (): Promise<void> => {
    const cleanupErrors: unknown[] = []
    for (const target of [publishedSolutionPath, winnerPromotedPath]) {
      if (target === undefined) continue
      try {
        await unlink(target)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'failed to roll back solution publication files')
    }
  }
  try {
    throwIfAborted(context.signal)
    const inputs = await readCurrentInputs(context, options.workspace)
    await mkdir(paths.workerDirectory, { recursive: false, mode: 0o700 })
    if (context.instruction.trim()) {
      await writeTextAtomically(path.join(paths.workerDirectory, 'worker_hint.md'), context.instruction)
    }

    await context.progress({ phase: 'generator', round: 0, artifactPaths: artifacts() })
    await invoke(options, context, paths, {
      role: 'generator',
      cwd: options.workspace,
      persona: loadRolePrompt('generator'),
      task: buildGeneratorTask({
        problem: inputs.problem,
        workerRelativePath: paths.workerRelative,
        instruction: context.instruction,
        ...(inputs.hint === undefined ? {} : { hint: inputs.hint }),
      }),
    })
    throwIfAborted(context.signal)

    let proposition
    try {
      proposition = await readWorkspaceInput(options.workspace, paths.propositionRelative, { nonEmpty: true })
    } catch (error) {
      return {
        status: 'rejected',
        producedVerifiedProposition: false,
        solved: false,
        failureStage: 'generator',
        reason: `generator did not produce a readable, non-empty proposition.md: ${error instanceof Error ? error.message : String(error)}`,
        artifactPaths: [paths.workerRelative],
      }
    }
    let propositionText = proposition.content
    currentStatement = extractStatement(propositionText).trim()
    let propositionStamp = await captureFileStamp(options.workspace, paths.propositionRelative)
    await context.progress({ propositionPath: paths.propositionRelative })

    let finalFailure: VerificationFailure | undefined
    for (let round = 1; round <= MAX_VERIFY_ROUNDS; round += 1) {
      finalFailure = await runVerificationRound(
        options,
        context,
        paths,
        propositionText,
        propositionStamp,
        round,
      )
      if (finalFailure === undefined) break
      if (round === MAX_VERIFY_ROUNDS) {
        return {
          status: 'rejected',
          producedVerifiedProposition: false,
          solved: false,
          statement: extractStatement(propositionText).trim(),
          failureStage: `verifier:${finalFailure.profile}`,
          reason: finalFailure.review.slice(0, 4_000),
          artifactPaths: artifacts(),
        }
      }

      await context.assertInputsCurrent()
      await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
      await context.progress({ phase: 'reviser', round })
      await invoke(options, context, paths, {
        role: 'reviser',
        cwd: options.workspace,
        persona: loadRolePrompt('reviser'),
        task: buildReviserTask(paths.propositionRelative, finalFailure.review, round),
        workflowRound: round,
        expectedPropositionStamp: propositionStamp,
      })
      throwIfAborted(context.signal)
      proposition = await readWorkspaceInput(options.workspace, paths.propositionRelative, { nonEmpty: true })
      propositionText = proposition.content
      currentStatement = extractStatement(propositionText).trim()
      propositionStamp = await captureFileStamp(options.workspace, paths.propositionRelative)
    }

    await context.assertInputsCurrent()
    await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    const candidateFilename = await chooseCandidateFilename(options, context, paths, propositionText)
    const candidateView = await buildCandidateView(options.workspace, context.id, paths, candidateFilename)
    let solved = true
    let theoremInfrastructureFailure: WorkflowInfrastructureError | undefined
    const theoremAnswers: string[] = []
    try {
      for (let attempt = 1; attempt <= THEOREM_CHECK_ATTEMPTS; attempt += 1) {
        await context.assertInputsCurrent()
        await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
        await context.progress({ phase: 'theorem_checker', theoremChecks: attempt })
        try {
          const check = await invoke(options, context, paths, {
            role: 'theorem_checker',
            cwd: candidateView.root,
            theoremViewDirectory: candidateView.root,
            persona: loadRolePrompt('theorem_checker'),
            task: buildTheoremCheckerTask(inputs.problem, candidateView.candidateRelativeForAgent),
            theoremAttempt: attempt,
            expectedPropositionStamp: propositionStamp,
          })
          theoremAnswers.push(check.text)
          if (!solvesOriginalProblem(check.text)) {
            solved = false
            break
          }
        } catch (error) {
          if (context.signal.aborted) throw error
          if (error instanceof PropositionWriteConflictError) throw error
          theoremInfrastructureFailure = new WorkflowInfrastructureError(`theorem_checker:${attempt}`, error)
          theoremAnswers.push(theoremInfrastructureFailure.message)
          solved = false
          break
        }
      }
    } finally {
      await rm(candidateView.root, { recursive: true, force: true })
    }

    const theoremCheckText = [
      '# Theorem Check',
      '',
      ...theoremAnswers.flatMap((answer, index) => [`## Attempt ${index + 1}`, '', answer.trim(), '']),
    ].join('\n').trimEnd() + '\n'
    await writeTextAtomically(paths.theoremCheckPath, theoremCheckText)

    await context.assertInputsCurrent()
    await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    await context.progress({ phase: 'arbitrating' })
    if (solved) {
      const winner = await context.claimSolvedWinner()
      if (!winner) {
        return {
          status: 'discarded_after_solution',
          producedVerifiedProposition: false,
          solved: true,
          statement: extractStatement(propositionText).trim(),
          reason: 'another worker committed the solved winner first',
          artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative]),
        }
      }
      ownsWinnerClaim = true
      // Revalidate after the atomic claim and immediately before any shared write.
      await context.assertInputsCurrent()
      await assertPropositionUnchanged(options.workspace, paths.propositionRelative, propositionStamp)
    }

    await context.progress({ phase: 'promoting' })
    const promoted = await promoteCandidate(
      paths,
      candidateFilename,
      propositionText,
      path.join(options.workspace, '.alphasolve', 'tmp'),
    )
    if (solved) winnerPromotedPath = promoted.path
    await context.progress({ verifiedPath: promoted.relativePath })
    const statement = extractStatement(propositionText).trim()

    if (!solved) {
      if (theoremInfrastructureFailure !== undefined) {
        return {
          status: 'failed',
          producedVerifiedProposition: true,
          solved: false,
          statement,
          propositionPath: promoted.relativePath,
          failureStage: theoremInfrastructureFailure.stage,
          reason: theoremInfrastructureFailure.message,
          artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative]),
        }
      }
      return {
        status: 'verified',
        producedVerifiedProposition: true,
        solved: false,
        statement,
        propositionPath: promoted.relativePath,
        artifactPaths: workflowArtifactPaths(options, context, paths, [paths.theoremCheckRelative]),
      }
    }

    // A second final boundary protects the solution from a problem edit that
    // races with promotion. The winner proposition is immutable after copy.
    await context.assertInputsCurrent()
    throwIfAborted(context.signal)
    const publish = options.solutionPublisher
      ?? ((request: SolutionPublishRequest) => defaultSolutionPublisher(request, options.replaceExistingSolution ?? false))
    const publishedSolution = await publish({
      workerId: context.id,
      workspace: options.workspace,
      problemText: inputs.problem,
      verifiedDir: paths.verifiedDir,
      finalPropositionPath: promoted.path,
      solutionPath: paths.solutionPath,
      signal: context.signal,
    })
    publishedSolutionPath = paths.solutionPath
    if (path.resolve(publishedSolution) !== path.resolve(paths.solutionPath)) {
      throw new Error('solution publisher returned an unexpected path')
    }
    // Publishing is atomic, but the digest can change while a slow publisher
    // is assembling/writing. Revalidate after it returns and roll back both
    // shared files in the catch path before releasing the provisional claim.
    await context.assertInputsCurrent()
    throwIfAborted(context.signal)
    return {
      status: 'solved',
      producedVerifiedProposition: true,
      solved: true,
      statement,
      propositionPath: promoted.relativePath,
      artifactPaths: workflowArtifactPaths(options, context, paths, [
        paths.theoremCheckRelative,
        path.relative(options.workspace, path.resolve(publishedSolution)),
      ]),
      rollbackPublishedSolution,
    }
  } catch (error) {
    if (ownsWinnerClaim) {
      let cleanupFailure: unknown
      try {
        await rollbackPublishedSolution()
      } catch (cleanupError) {
        cleanupFailure = cleanupError
      }
      await context.releaseSolvedWinner?.()
      if (cleanupFailure !== undefined) {
        throw new AggregateError([error, cleanupFailure], 'failed to roll back an invalidated solution publication')
      }
    }
    if (error instanceof PropositionWriteConflictError) {
      return {
        status: 'write_conflict',
        producedVerifiedProposition: false,
        solved: false,
        failureStage: 'proposition_stamp',
        reason: error.message,
        artifactPaths: artifacts(),
      }
    }
    if (error instanceof WorkflowInfrastructureError) {
      return {
        status: 'failed',
        producedVerifiedProposition: false,
        solved: false,
        ...(currentStatement === undefined || currentStatement === '' ? {} : { statement: currentStatement }),
        failureStage: error.stage,
        reason: error.message,
        artifactPaths: artifacts(),
      }
    }
    throw error
  }
}

/** Create the WorkerManager-compatible executor for one locked session. */
export function createFixedWorkerExecutor(options: FixedWorkflowOptions): WorkerExecutor {
  const workspace = path.resolve(options.workspace)
  return context => executeFixedWorkflow({ ...options, workspace }, context)
}

/** Exported for focused tests and alternate schedulers. */
export async function runFixedWorkerWorkflow(
  options: FixedWorkflowOptions,
  context: WorkerExecutionContext,
): Promise<WorkflowResult> {
  return executeFixedWorkflow({ ...options, workspace: path.resolve(options.workspace) }, context)
}
