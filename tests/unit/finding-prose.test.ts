import { describe, expect, it } from "vitest";
import { explanationLines, explanationParagraphs, PROSE_BUDGET, tighten } from "@/lib/review/finding-prose";

/**
 * Keeping a finding short enough that somebody reads it.
 *
 * The case these were written against is real, from a review of this
 * repository: one finding ran eleven lines of the tool's own vocabulary
 * before saying what would actually break, and the renderer then collapsed its
 * paragraph breaks so it arrived as a single block. Two separate faults, both
 * of which made the finding unreadable rather than wrong.
 */

// Verbatim from the review that prompted this, lightly shortened.
const WALL = [
  "The consensus function returns true for 'withdraw' + 'maintain_rejection' (both agree it's NOT a defect)",
  "but returns false for 'confirm' + 'confirm' when severity differs by 2+ steps.",
  "This means two reviewers agreeing a defect exists but disagreeing on severity goes to arbitration.",
  "The logic is asymmetric.",
  "When both reviewers agree a defect exists, a severity gap of 2+ steps prevents consensus.",
  "But when one withdraws and the other maintains rejection, it's treated as consensus.",
  "This could cause real defects to be escalated unnecessarily while false rejections are silently accepted.",
].join(" ");

describe("trimming a finding to something readable", () => {
  it("keeps only the first sentences of a wall of text", () => {
    const result = tighten(WALL, 2, 320);
    expect(result.length).toBeLessThanOrEqual(320);
    expect(result.startsWith("The consensus function returns true")).toBe(true);
    expect(result).not.toContain("The logic is asymmetric");
  });

  it("never cuts mid-sentence", () => {
    // A cut mid-clause reads as a bug in the tool, not as brevity.
    expect(tighten(WALL, 2, 320).trimEnd()).toMatch(/[.!?]$/);
  });

  it("returns one long sentence whole rather than half of it", () => {
    const single = `The loop runs one past the end of ${"a".repeat(400)} and throws.`;
    const result = tighten(single, 2, 100);
    expect(result).toBe(single);
  });

  it("leaves an already-short finding alone", () => {
    const short = "The loop condition uses <= so it reads one past the end. That throws a TypeError.";
    expect(tighten(short, 2, 320)).toBe(short);
  });

  it("handles absent text", () => {
    expect(tighten(undefined, 2, 320)).toBe("");
    expect(tighten("   ", 2, 320)).toBe("");
  });
});

describe("the explanation a reader sees", () => {
  it("is three short paragraphs, not one block", () => {
    const parts = explanationParagraphs({
      problem: WALL,
      whyItIsABug: "Real defects get escalated while false rejections pass. That wastes an arbitration call and hides a wrong answer.",
      triggerScenario: "Two reviewers agree a defect exists but rate it critical and low.",
    });
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(320);
  });

  it("drops parts the reviewer did not supply", () => {
    const parts = explanationParagraphs({ problem: "The loop reads past the end.", whyItIsABug: "It throws." });
    expect(parts).toEqual(["The loop reads past the end.", "It throws."]);
  });

  it("holds the whole explanation under a page", () => {
    const parts = explanationParagraphs({ problem: WALL, whyItIsABug: WALL, triggerScenario: WALL });
    const total = parts.join(" ").length;
    const budget = PROSE_BUDGET.problem.chars + PROSE_BUDGET.impact.chars + PROSE_BUDGET.trigger.chars;
    expect(total).toBeLessThanOrEqual(budget);
  });
});

describe("rendering the paragraphs back", () => {
  it("round-trips what the writer separated", () => {
    const parts = explanationParagraphs({
      problem: "The loop reads past the end.",
      whyItIsABug: "It throws a TypeError.",
      triggerScenario: "Any non-empty array.",
    });
    expect(explanationLines(parts.join("\n\n"))).toEqual(parts);
  });

  it("survives a stored explanation with irregular spacing", () => {
    expect(explanationLines("first para\n\n\n  \n second para")).toEqual(["first para", "second para"]);
  });

  it("returns nothing for an empty explanation", () => {
    expect(explanationLines("")).toEqual([]);
    expect(explanationLines(undefined)).toEqual([]);
  });

  it("keeps a single-paragraph explanation as one", () => {
    expect(explanationLines("Just the one thing.")).toEqual(["Just the one thing."]);
  });
});
