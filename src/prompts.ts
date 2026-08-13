import { readFileSync } from "node:fs"

import { findExternalReferenceParentheticals } from "./parsers.js"

function prompt(...lines: string[]): string {
  return lines.join("\n").trim()
}

export const VERIFIER_PROFILE_ORDER = [
  "verifier_format_references",
  "verifier_citation",
  "verifier_failure_modes",
  "verifier_stepwise",
  "verifier_premise_chain",
] as const

export type VerifierPromptProfile =
  | (typeof VERIFIER_PROFILE_ORDER)[number]
  | "format_references"
  | "citation"
  | "failure_modes"
  | "stepwise"
  | "premise_chain"

function loadPromptAsset(name: string): string {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8").trim()
}

export const REVIEW_VERDICT_JUDGE_PROMPT = loadPromptAsset("review_verdict_judge")
export const GENERATOR_PROMPT = loadPromptAsset("generator")
export const REVISER_PROMPT = loadPromptAsset("reviser")
export const THEOREM_CHECKER_PROMPT = loadPromptAsset("theorem_checker")
export const VERIFIER_PROMPT = loadPromptAsset("verifier")
export const VERIFIER_FORMAT_REFERENCES_PROMPT = loadPromptAsset("verifier_format_references")
export const VERIFIER_CITATION_PROMPT = loadPromptAsset("verifier_citation")
export const VERIFIER_FAILURE_MODES_PROMPT = loadPromptAsset("verifier_failure_modes")
export const VERIFIER_STEPWISE_PROMPT = loadPromptAsset("verifier_stepwise")
export const VERIFIER_PREMISE_CHAIN_PROMPT = loadPromptAsset("verifier_premise_chain")
export const COMPUTE_SUBAGENT_PROMPT = loadPromptAsset("compute")
export const NUMERICAL_EXPERIMENT_SUBAGENT_PROMPT = loadPromptAsset("numerical_experiment")
export const REASONING_SUBAGENT_PROMPT = loadPromptAsset("reasoning")
export const RESEARCH_REVIEWER_PROMPT = loadPromptAsset("research_reviewer")
export const CURATOR_PROMPT = loadPromptAsset("curator")
export const ORCHESTRATOR_PROMPT = loadPromptAsset("orchestrator")

export const ROLE_PROMPTS = Object.freeze({
  orchestrator: ORCHESTRATOR_PROMPT,
  generator: GENERATOR_PROMPT,
  reviser: REVISER_PROMPT,
  theorem_checker: THEOREM_CHECKER_PROMPT,
  verifier: VERIFIER_PROMPT,
  verifier_format_references: VERIFIER_FORMAT_REFERENCES_PROMPT,
  verifier_citation: VERIFIER_CITATION_PROMPT,
  verifier_failure_modes: VERIFIER_FAILURE_MODES_PROMPT,
  verifier_stepwise: VERIFIER_STEPWISE_PROMPT,
  verifier_premise_chain: VERIFIER_PREMISE_CHAIN_PROMPT,
  review_verdict_judge: REVIEW_VERDICT_JUDGE_PROMPT,
  compute: COMPUTE_SUBAGENT_PROMPT,
  numerical_experiment: NUMERICAL_EXPERIMENT_SUBAGENT_PROMPT,
  reasoning: REASONING_SUBAGENT_PROMPT,
  research_reviewer: RESEARCH_REVIEWER_PROMPT,
  curator: CURATOR_PROMPT,
})

/** AlphaSolve main turn budgets. DSH model routes are resolved separately. */
export const ROLE_MAX_TURNS = Object.freeze({
  orchestrator: 80,
  generator: 80,
  reviser: 80,
  theorem_checker: 60,
  verifier: 80,
  verifier_format_references: 80,
  verifier_citation: 40,
  verifier_failure_modes: 80,
  verifier_stepwise: 80,
  verifier_premise_chain: 80,
  review_verdict_judge: 80,
  compute: 80,
  numerical_experiment: 80,
  reasoning: 80,
  research_reviewer: 100,
  curator: 80,
})

/** Role-scoped helper types; an empty tuple means the Agent tool must be absent. */
export const ROLE_SUBAGENTS = Object.freeze({
  generator: ["compute", "numerical_experiment", "research_reviewer", "reasoning"],
  verifier_format_references: [],
  verifier_citation: ["reasoning"],
  verifier_failure_modes: ["compute", "numerical_experiment", "reasoning"],
  verifier_stepwise: ["compute", "numerical_experiment", "reasoning"],
  verifier_premise_chain: ["compute", "numerical_experiment", "reasoning"],
  reviser: ["compute", "numerical_experiment", "reasoning"],
  theorem_checker: [],
  curator: ["compute", "reasoning"],
  compute: [],
  numerical_experiment: [],
  reasoning: [],
  research_reviewer: [],
  review_verdict_judge: [],
} as const)

export type RolePromptName = keyof typeof ROLE_PROMPTS

export function loadRolePrompt(role: RolePromptName): string {
  return ROLE_PROMPTS[role]
}

export interface GeneratorTaskInput {
  problem: string
  workerRelativePath: string
  hint?: string | null
  instruction?: string | null
}

export function buildGeneratorTask(input: GeneratorTaskInput): string {
  const sections = ["# Problem", input.problem]
  if (input.hint) sections.push("# General Hint", input.hint)
  if (input.instruction) sections.push("# Task Guidance", input.instruction)
  sections.push(
    "# Output",
    `Create \`proposition.md\` directly in your own directory \`${input.workerRelativePath}\`. `
      + "It must contain exactly `## Statement` followed by `## Proof`, with no remarks or extra headings. "
      + "The Statement must be pure mathematics, without a theorem-like label. "
      + "Cite established propositions with `\\ref{path-without-extension}` relative to `verified_propositions/`, "
      + "using backslashes between subdirectories.",
  )
  return sections.join("\n\n")
}

export interface VerifierTaskInput {
  propositionPath: string
  propositionText: string
  workflowIndex: number
  attemptIndex: number
  attemptTotal: number
  profile: VerifierPromptProfile
}

export function buildVerifierTask(input: VerifierTaskInput): string {
  const profile = input.profile.startsWith("verifier_") ? input.profile : `verifier_${input.profile}`
  let instruction: string
  if (profile === "verifier_format_references") {
    instruction = "Perform the first format/reference-source gate. Check the exact two-section format, pure Statement, absence of remarks, and whether every external mathematical source is present under `knowledge/references/`. End with `Verdict: pass` or `Verdict: fail`."
  } else if (profile === "verifier_citation") {
    instruction = "Perform the citation/reference audit. Resolve every `\\ref{...}` under `verified_propositions/`, reject knowledge used as established mathematics, and check the hypotheses of every cited proposition with a bounded reasoning subagent. End with `Verdict: pass` or `Verdict: fail`."
    const parentheticals = findExternalReferenceParentheticals(input.propositionText)
    if (parentheticals.length > 0) {
      instruction += "\n\nPotential external paper/book citation parentheticals detected; inspect whether they are unsupported external dependencies:\n"
        + parentheticals.map(({ lineNumber, parenthetical }) => `- line ${lineNumber}: (${parenthetical})`).join("\n")
    }
  } else {
    instruction = "Write a rigorous review of the Statement and Proof under this verifier profile. Focus on correctness, completeness, hidden assumptions, and logical rigor; earlier profiles handle format and citations. End with `Verdict: pass` or `Verdict: fail`."
  }

  return prompt(
    "# Verification Target",
    input.propositionPath,
    "",
    instruction,
    "",
    "Judge only defects in this candidate Statement or Proof under the assigned profile. Its failure to solve, advance, resemble, or mention the original problem is never a valid reason to fail.",
    "",
    `Verifier workflow: ${input.workflowIndex}`,
    `Independent verification attempt: ${input.attemptIndex} of ${input.attemptTotal}`,
    `Verifier config: ${profile}`,
  )
}

export function buildReviewVerdictTask(review: string, workflowIndex: number, attemptIndex: number): string {
  return prompt(
    "# Verifier Workflow",
    String(workflowIndex),
    "",
    "# Attempt",
    String(attemptIndex),
    "",
    "# Attempt Review",
    review,
    "",
    "Ignore criticism based only on failure to solve or advance the original problem. Such criticism is outside verifier scope.",
    "",
    "Return exactly either `pass` or `fail`.",
  )
}

export function buildReviserTask(
  propositionPath: string,
  review: string,
  workflowIndex: number,
): string {
  return prompt(
    "# Candidate Proposition File",
    propositionPath,
    "",
    "# Review",
    review,
    "",
    "Rewrite the same proposition Markdown file in place, addressing every candidate-local mathematical, logical, format, dependency, or citation issue.",
    "Ignore any criticism based only on failure to solve or advance the original problem, and never expand an auxiliary proposition into the original solution for that reason.",
    "",
    `Revision after verifier workflow: ${workflowIndex}`,
  )
}

export function buildTheoremCheckerTask(problem: string, verifiedPropositionPath: string): string {
  return prompt(
    "# Problem",
    problem,
    "",
    "# Newly Verified Proposition File",
    verifiedPropositionPath,
    "",
    "Assess this proposition against the original problem using the theorem-checker rules.",
  )
}

export interface CuratorDigestInput {
  traceKind: string
  trace: readonly unknown[]
  callerContext?: Readonly<Record<string, unknown>> | null
  finalVerifierReview?: boolean
}

export function buildCuratorDigestTask(input: CuratorDigestInput): string {
  const payload = input.callerContext
    ? { trace_kind: input.traceKind, caller_context: input.callerContext, subagent_trace: input.trace }
    : { trace_kind: input.traceKind, trace: input.trace }
  const commonErrors = input.finalVerifierReview
    ? "This is a verifier's final review. When useful, append up to three reusable error patterns to `knowledge/common-errors.md`, deduplicating and keeping at most 15 patterns."
    : "Do not modify `knowledge/common-errors.md`."
  return prompt(
    "# Trace Segment for Knowledge Base",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "Update `knowledge/` from this trace. Metadata is private triage context: never copy worker, role, round, attempt, source-label, or session identifiers into the wiki.",
    "Read `knowledge/index.md` first. Preserve reusable derivations, observations, failed routes, and open gaps; split oversized topics into focused folders with local indexes.",
    commonErrors,
    "Before finishing, ensure `knowledge/index.md` accurately routes the current entries.",
  )
}

export function buildCuratorHealthCheckTask(scanText = ""): string {
  const scanSection = scanText.trim()
    ? `\n\nProgram scan before curator:\n${scanText.trim()}\nUse this only as triage; inspect files before changing them.`
    : ""
  return prompt(
    "# Knowledge Base Health Check",
    "",
    "Read `knowledge/index.md` first, then make focused maintenance fixes.",
    "- Every index tracks only immediate child files and folders.",
    "- Ordinary pages over 250 lines should usually be split; keep `common-errors.md` compressed and at most 15 patterns.",
    "- Protect human material in `knowledge/references/`; never rewrite it, and split only by exact line ranges.",
    "- Check stale links, confusing names, redundant pages, missing local indexes, and untracked files.",
    "- Do not add new common-error patterns during a health check.",
    "- Never record pipeline identifiers or maintenance history.",
    scanSection,
  )
}

export const PROPOSITION_FILENAME_PROMPT_PREFIX = prompt(
  "Read the following verified mathematical proposition and return a descriptive kebab-case filename",
  "(5-15 words, lowercase, hyphens only, no extension) that exactly captures its mathematical content.",
  "Return ONLY the filename, nothing else.",
)

export function buildPropositionFilenameTask(propositionText: string): string {
  return `${PROPOSITION_FILENAME_PROMPT_PREFIX}\n\n${propositionText.slice(0, 3000)}`
}
