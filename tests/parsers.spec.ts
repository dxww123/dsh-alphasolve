import { describe, expect, it } from "vitest"

import {
  extractStatement,
  findExternalReferenceParentheticals,
  parsePropositionFilename,
  parseVerifierVerdict,
  solvesOriginalProblem,
} from "../src/parsers.js"

describe("parseVerifierVerdict", () => {
  it("accepts an unambiguous pass and fails closed otherwise", () => {
    expect(parseVerifierVerdict("pass")).toBe("pass")
    expect(parseVerifierVerdict("**PASS**")).toBe("pass")
    expect(parseVerifierVerdict("fail")).toBe("fail")
    expect(parseVerifierVerdict("pass, but another line says fail")).toBe("fail")
    expect(parseVerifierVerdict("")).toBe("fail")
  })
})

describe("solvesOriginalProblem", () => {
  it("uses the AlphaSolve theorem-check marker", () => {
    expect(solvesOriginalProblem("Solves original problem: yes")).toBe(true)
    expect(solvesOriginalProblem("SOLVES   ORIGINAL PROBLEM : YES." )).toBe(true)
    expect(solvesOriginalProblem("Solves original problem: no")).toBe(false)
    expect(solvesOriginalProblem("yes")).toBe(false)
  })
})

describe("extractStatement", () => {
  it("extracts only the Statement section and preserves main's leading newline", () => {
    expect(extractStatement("## Statement\n\nFor every x, x=x.\n\n## Proof\n\nReflexivity.")).toBe(
      "\nFor every x, x=x.",
    )
  })

  it("falls back to the start of malformed content", () => {
    expect(extractStatement("plain text", 5)).toBe("\nplain")
  })
})

describe("parsePropositionFilename", () => {
  it("normalizes the namer output", () => {
    expect(parsePropositionFilename("  Matrix Rank: Bound!!  ", "fallback")).toBe("matrix-rank-bound.md")
  })

  it("uses a deterministic fallback for an invalid or overlong result", () => {
    expect(parsePropositionFilename("---", "ABC-123")).toBe("proposition-abc123.md")
    expect(parsePropositionFilename("x".repeat(141), "deadbeef")).toBe("proposition-deadbeef.md")
  })
})

describe("findExternalReferenceParentheticals", () => {
  it("matches the local main implementation's bounded parenthetical scan", () => {
    const text = [
      "Intro line.",
      "The proof invokes theorem (Hughes-Kato-Marsden 1977, Theorem II). A bare 1978 is ignored.",
      `A far parenthesis (${"x".repeat(55)}1979) is ignored.`,
      "The identifier A1980B is ignored. Another source (Book title 2100) is noted. Unmatched (1981 is ignored.",
    ].join("\n")

    expect(findExternalReferenceParentheticals(text)).toEqual([
      { lineNumber: 2, parenthetical: "Hughes-Kato-Marsden 1977, Theorem II" },
      { lineNumber: 4, parenthetical: "Book title 2100" },
    ])
  })
})
