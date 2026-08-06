import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  SolutionAssemblyError,
  assembleSolution,
  extractVerifiedReferences,
  normalizeVerifiedReference,
  writeSolutionAtomically,
  writeTextAtomically,
} from "../src/solution.js"

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-alphasolve-solution-"))
  try {
    await mkdir(path.join(workspace, "verified_propositions"), { recursive: true })
    await run(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

describe("verified reference parsing", () => {
  it("normalizes AlphaSolve backslash paths and preserves first-use order", () => {
    expect(normalizeVerifiedReference(" topic\\base-lemma ")).toBe("topic/base-lemma")
    expect(extractVerifiedReferences("\\ref{b} then \\ref{a} and \\ref{b}")).toEqual(["b", "a"])
  })

  it("rejects escape and extension-bearing references", () => {
    expect(() => normalizeVerifiedReference("..\\outside")).toThrow(SolutionAssemblyError)
    expect(() => normalizeVerifiedReference("topic/lemma.md")).toThrow(/omit \.md/)
  })
})

describe("assembleSolution", () => {
  it("resolves backslash references and emits dependencies first", async () => {
    await withWorkspace(async (workspace) => {
      const verified = path.join(workspace, "verified_propositions")
      await mkdir(path.join(verified, "topic"))
      await writeFile(
        path.join(verified, "topic", "base.md"),
        "## Statement\n\nBase.\n\n## Proof\n\nProof of base.\n",
      )
      await writeFile(
        path.join(verified, "final.md"),
        "## Statement\n\nAnswer.\n\n## Proof\n\nBy \\ref{topic\\base}.\n",
      )

      const result = await assembleSolution({
        problemText: "Prove the answer.",
        verifiedDir: verified,
        finalPropositionPath: path.join(verified, "final.md"),
      })

      expect(result.propositions.map((item) => item.label)).toEqual(["topic/base", "final"])
      expect(result.text).toContain("# Solution\n\n## Problem\n\nProve the answer.")
      expect(result.text.indexOf("### 1. base")).toBeLessThan(result.text.indexOf("### 2. final"))
      expect(result.text.endsWith("\n")).toBe(true)
    })
  })

  it("fails closed on a missing dependency", async () => {
    await withWorkspace(async (workspace) => {
      const verified = path.join(workspace, "verified_propositions")
      const final = path.join(verified, "final.md")
      await writeFile(final, "## Statement\n\nAnswer.\n\n## Proof\n\n\\ref{missing}.\n")

      await expect(assembleSolution({
        problemText: "Problem",
        verifiedDir: verified,
        finalPropositionPath: final,
      })).rejects.toMatchObject({ code: "missing-proposition" })
    })
  })

  it("detects cycles using canonical paths", async () => {
    await withWorkspace(async (workspace) => {
      const verified = path.join(workspace, "verified_propositions")
      await writeFile(path.join(verified, "a.md"), "## Statement\n\nA.\n\n## Proof\n\n\\ref{b}.\n")
      await writeFile(path.join(verified, "b.md"), "## Statement\n\nB.\n\n## Proof\n\n\\ref{a}.\n")

      await expect(assembleSolution({
        problemText: "Problem",
        verifiedDir: verified,
        finalPropositionPath: path.join(verified, "a.md"),
      })).rejects.toMatchObject({ code: "cyclic-reference" })
    })
  })

  it.skipIf(process.platform === "win32")("rejects a symlink that escapes verified_propositions", async () => {
    await withWorkspace(async (workspace) => {
      const verified = path.join(workspace, "verified_propositions")
      const outside = path.join(workspace, "outside.md")
      await writeFile(outside, "## Statement\n\nOutside.\n\n## Proof\n\nNo.\n")
      await symlink(outside, path.join(verified, "linked.md"))
      await writeFile(
        path.join(verified, "final.md"),
        "## Statement\n\nAnswer.\n\n## Proof\n\n\\ref{linked}.\n",
      )

      await expect(assembleSolution({
        problemText: "Problem",
        verifiedDir: verified,
        finalPropositionPath: path.join(verified, "final.md"),
      })).rejects.toMatchObject({ code: "path-escape" })
    })
  })
})

describe("atomic publication", () => {
  it("writes a complete solution and refuses an unapproved overwrite", async () => {
    await withWorkspace(async (workspace) => {
      const verified = path.join(workspace, "verified_propositions")
      const final = path.join(verified, "final.md")
      const solution = path.join(workspace, "solution.md")
      await writeFile(final, "## Statement\n\nAnswer.\n\n## Proof\n\nDone.\n")

      const result = await writeSolutionAtomically({
        problemText: "Find the answer.",
        verifiedDir: verified,
        finalPropositionPath: final,
        solutionPath: solution,
      })
      expect(await readFile(solution, "utf8")).toBe(result.text)
      await expect(writeTextAtomically(solution, "replacement\n")).rejects.toMatchObject({ code: "EEXIST" })
    })
  })
})
