import { describe, expect, it } from "vitest"

import {
  ORCHESTRATOR_PROMPT,
  RESEARCH_REVIEWER_PROMPT,
  REVIEW_VERDICT_JUDGE_PROMPT,
  ROLE_MAX_TURNS,
  ROLE_PROMPTS,
  ROLE_SUBAGENTS,
  THEOREM_CHECKER_PROMPT,
  VERIFIER_PROFILE_ORDER,
  buildCuratorDigestTask,
  buildGeneratorTask,
  buildPropositionFilenameTask,
  buildReviserTask,
  buildReviewVerdictTask,
  buildTheoremCheckerTask,
  buildVerifierTask,
  loadRolePrompt,
} from "../src/prompts.js"

describe("role prompt catalog", () => {
  it("exposes the five main verifier profiles in fixed order", () => {
    expect(VERIFIER_PROFILE_ORDER).toEqual([
      "verifier_format_references",
      "verifier_citation",
      "verifier_failure_modes",
      "verifier_stepwise",
      "verifier_premise_chain",
    ])
    expect(loadRolePrompt("generator")).toBe(ROLE_PROMPTS.generator)
    expect(REVIEW_VERDICT_JUDGE_PROMPT).toContain("exactly one lowercase word")
    expect(ROLE_MAX_TURNS.verifier_citation).toBe(40)
    expect(ROLE_MAX_TURNS.theorem_checker).toBe(60)
    expect(ROLE_SUBAGENTS.theorem_checker).toEqual([])
    expect(ROLE_SUBAGENTS.generator).toContain("research_reviewer")
    expect(ROLE_SUBAGENTS.verifier_citation).toEqual(["reasoning"])
  })

  it("corrects main's misleading theorem-checker Agent instruction", () => {
    expect(THEOREM_CHECKER_PROMPT).toContain("no auxiliary subagent")
    expect(THEOREM_CHECKER_PROMPT).not.toContain("Use the `Agent` tool")
    expect(THEOREM_CHECKER_PROMPT).toContain("Solves original problem: yes")
  })

  it("requires an explicit safe choice after problem.md changes", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("restoring the activation-time problem")
    expect(ORCHESTRATOR_PROMPT).toContain("beginning a new problem generation")
    expect(ORCHESTRATOR_PROMPT).toContain("non-promoted research context")
    expect(ORCHESTRATOR_PROMPT).toContain("call `alphasolve_stop`")
  })

  it("restores AlphaSolve main's mathematical research strategy", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("proposition-producing workflow")
    expect(ORCHESTRATOR_PROMPT).toContain("three to five completed worker lifecycles")
    expect(ORCHESTRATOR_PROMPT).toMatch(/infrastructure/i)
    expect(RESEARCH_REVIEWER_PROMPT).toContain("exact system/interface proposition")
    expect(RESEARCH_REVIEWER_PROMPT).toContain("choice-classification proposition")
    expect(RESEARCH_REVIEWER_PROMPT).toContain("verified Statement is authoritative")
  })
})

describe("workflow task builders", () => {
  it("builds a generator task with optional human and worker guidance", () => {
    const task = buildGeneratorTask({
      problem: "Prove P.",
      hint: "Try parity.",
      instruction: "Isolate the odd case.",
      workerRelativePath: "unverified_propositions/prop-abcd1234",
    })
    expect(task).toContain("# Problem\n\nProve P.")
    expect(task).toContain("# General Hint\n\nTry parity.")
    expect(task).toContain("# Task Guidance\n\nIsolate the odd case.")
    expect(task).toContain("`proposition.md`")
  })

  it("adds external-year triage only to the citation verifier task", () => {
    const base = {
      problem: "Prove P.",
      propositionPath: "unverified_propositions/prop-a/proposition.md",
      propositionText: "We invoke a theorem (Example Author 1977).",
      workflowIndex: 1,
      attemptIndex: 2,
      attemptTotal: 5,
    } as const
    const citation = buildVerifierTask({ ...base, profile: "verifier_citation" })
    const stepwise = buildVerifierTask({ ...base, profile: "stepwise" })
    expect(citation).toContain("line 1: (Example Author 1977)")
    expect(citation).toContain("Verifier config: verifier_citation")
    expect(stepwise).not.toContain("Example Author 1977")
    expect(stepwise).toContain("Verifier config: verifier_stepwise")
    expect(citation).not.toContain("# Problem")
    expect(citation).not.toContain("Prove P.")
    expect(stepwise).not.toContain("# Problem")
    expect(stepwise).toContain("failure to solve, advance, resemble, or mention")
  })

  it("builds judge, reviser, and theorem tasks without hidden conversation state", () => {
    expect(buildReviewVerdictTask("Verdict: pass", 2, 4)).toContain("# Attempt\n4")
    const reviser = buildReviserTask("Problem", "prop.md", "Gap", 3)
    expect(reviser).toContain("Revision after verifier workflow: 3")
    expect(reviser).not.toContain("# Problem")
    expect(reviser).not.toContain("Problem\n")
    expect(reviser).toContain("never expand an auxiliary proposition")
    expect(buildTheoremCheckerTask("Problem", "verified_propositions/candidate.md")).toContain(
      "# Newly Verified Proposition File\nverified_propositions/candidate.md",
    )
  })
})

describe("curator and filename tasks", () => {
  it("distinguishes ordinary traces from final verifier reviews", () => {
    const ordinary = buildCuratorDigestTask({ traceKind: "subagent", trace: [{ content: "idea" }] })
    const verifier = buildCuratorDigestTask({
      traceKind: "verifier",
      trace: [{ role: "verifier_attempt", content: "gap" }],
      finalVerifierReview: true,
    })
    expect(ordinary).toContain("Do not modify `knowledge/common-errors.md`")
    expect(verifier).toContain("up to three reusable error patterns")
    expect(verifier).toContain("at most 15 patterns")
  })

  it("limits the filename namer's proposition payload to 3000 characters", () => {
    const task = buildPropositionFilenameTask("x".repeat(4000))
    expect(task).toContain("kebab-case filename")
    expect(task.endsWith("x".repeat(3000))).toBe(true)
  })
})
