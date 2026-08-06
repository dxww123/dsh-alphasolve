import { randomUUID } from "node:crypto"

export type VerifierVerdict = "pass" | "fail"

export interface ExternalReferenceParenthetical {
  lineNumber: number
  parenthetical: string
}

/**
 * Parse the output of AlphaSolve's independent verifier-verdict judge.
 *
 * The original implementation is intentionally fail-closed: an empty or
 * ambiguous answer, including one that contains both words, is a failure.
 */
export function parseVerifierVerdict(text: string | null | undefined): VerifierVerdict {
  const clean = (text ?? "").trim().toLowerCase()
  return clean.includes("pass") && !clean.includes("fail") ? "pass" : "fail"
}

/** Return true only when the theorem-checker answer contains AlphaSolve's yes marker. */
export function solvesOriginalProblem(text: string | null | undefined): boolean {
  return /solves\s+original\s+problem\s*:\s*yes\b/i.test(text ?? "")
}

/**
 * Extract the Statement section for the compact worker-completion summary.
 *
 * This preserves the slightly unusual leading newline of AlphaSolve main so
 * existing result rendering does not silently change during the port.
 */
export function extractStatement(text: string, limit = 800): string {
  const marker = "## statement"
  const markerStart = text.toLowerCase().indexOf(marker)
  if (markerStart === -1) return `\n${text.slice(0, limit)}`

  const contentStart = text.indexOf("\n", markerStart)
  if (contentStart === -1) return `\n${text.slice(0, limit)}`

  const nextHeading = text.indexOf("\n## ", contentStart + 1)
  const statement = nextHeading === -1
    ? text.slice(contentStart).trim()
    : text.slice(contentStart, nextHeading).trim()
  return `\n${statement.slice(0, limit)}`
}

/**
 * Sanitize the filename-only answer from AlphaSolve's proposition namer.
 * The caller may supply a deterministic fallback id for tests and recovery.
 */
export function parsePropositionFilename(
  text: string | null | undefined,
  fallbackId = randomUUID().replaceAll("-", "").slice(0, 8),
): string {
  let name = (text ?? "").trim().toLowerCase()
  name = name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-")
  if (name.length > 0 && name.length <= 140) return `${name}.md`

  const safeFallback = fallbackId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "unknown"
  return `proposition-${safeFallback}.md`
}

/**
 * Detect likely author/year or title/year parentheticals for the citation
 * verifier. This is only a triage hint; it never accepts or rejects a proof.
 */
export function findExternalReferenceParentheticals(text: string): ExternalReferenceParenthetical[] {
  const yearPattern = /(?<![A-Za-z0-9])(?:1[7-9]\d{2}|20\d{2}|2100)(?![A-Za-z0-9])/g
  const results: ExternalReferenceParenthetical[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(yearPattern)) {
    const yearStart = match.index
    const yearEnd = yearStart + match[0].length
    const lowerBound = Math.max(0, yearStart - 50)
    const left = text.lastIndexOf("(", yearStart - 1)
    if (left < lowerBound) continue

    let depth = 0
    let right = -1
    for (let index = left; index < text.length; index += 1) {
      if (text[index] === "(") depth += 1
      else if (text[index] === ")") {
        depth -= 1
        if (depth === 0) {
          right = index
          break
        }
        if (depth < 0) break
      }
    }
    if (right === -1 || right < yearEnd || right - yearEnd > 50) continue

    const parenthetical = text.slice(left + 1, right).trim().split(/\s+/).join(" ")
    if (!parenthetical) continue
    const lineNumber = text.slice(0, left).split("\n").length
    const key = `${lineNumber}\u0000${parenthetical}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ lineNumber, parenthetical })
  }

  return results
}
