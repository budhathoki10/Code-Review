import { describe, it, expect } from "vitest";
import { canonicalRuleKey, dedupeLintFindings } from "@/lib/review/static-analysis";
import type { FindingDoc } from "@/lib/db/collections";

/**
 * Three linters run over every JS/TS file (ESLint+typescript-eslint, Biome,
 * oxlint) because each carries rules the others don't. The cost is overlap:
 * on PR #58 a single unnecessary escape produced three inline comments in
 * three different phrasings, and Biome's per-operator reporting produced two
 * identical comments on one line that happened to contain two `!`s.
 */
function lint(overrides: Partial<FindingDoc> = {}): FindingDoc {
  return {
    severity: "low",
    category: "quality",
    file: "src/greet.ts",
    line: 10,
    title: "ESLint: no-useless-escape",
    explanation: "Unnecessary escape character: \\-.",
    confidence: "high",
    source: "static-analysis",
    ...overrides,
  };
}

describe("canonicalRuleKey", () => {
  it("strips each linter's own title prefix", () => {
    expect(canonicalRuleKey("ESLint: no-var")).toBe("no-var");
    expect(canonicalRuleKey("oxlint: eslint(no-var)")).toBe("no-var");
  });

  it("unwraps oxlint's originating-plugin parentheses", () => {
    expect(canonicalRuleKey("oxlint: typescript(no-explicit-any)")).toBe("no-explicit-any");
  });

  it("strips Biome's lint/<group>/ namespace", () => {
    expect(canonicalRuleKey("Biome: lint/suspicious/noDoubleEquals")).toBe("eqeqeq");
  });

  it("folds cross-tool synonyms for the same defect onto one key", () => {
    // The exact trio seen on PR #58: same escape, three names.
    expect(canonicalRuleKey("ESLint: no-useless-escape")).toBe("no-useless-escape");
    expect(canonicalRuleKey("oxlint: eslint(no-useless-escape)")).toBe("no-useless-escape");
    expect(canonicalRuleKey("Biome: lint/complexity/noUselessEscapeInRegex")).toBe("no-useless-escape");
  });

  it("keeps unrelated rules distinct", () => {
    expect(canonicalRuleKey("Biome: lint/correctness/noUnusedImports")).not.toBe(
      canonicalRuleKey("ESLint: no-unused-vars"),
    );
  });
});

describe("dedupeLintFindings", () => {
  it("collapses one defect reported by all three linters", () => {
    const result = dedupeLintFindings([
      lint({ title: "ESLint: no-useless-escape", explanation: "Unnecessary escape character: \\-." }),
      lint({ title: "Biome: lint/complexity/noUselessEscapeInRegex", explanation: "The character doesn't need to be escaped." }),
      lint({ title: "oxlint: eslint(no-useless-escape)", explanation: "Unnecessary escape character '-'" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("keeps the first reporter's wording and severity", () => {
    const result = dedupeLintFindings([
      lint({ title: "ESLint: no-useless-escape", severity: "medium" }),
      lint({ title: "oxlint: eslint(no-useless-escape)", severity: "low" }),
    ]);

    expect(result[0].title).toBe("ESLint: no-useless-escape");
    expect(result[0].severity).toBe("medium");
  });

  it("collapses one rule firing twice on the same line", () => {
    // `computeLineContents([file()])!.get("x")!` — two `!` operators, two
    // Biome diagnostics, both anchored to the same line.
    const result = dedupeLintFindings([
      lint({ line: 197, title: "Biome: lint/style/noNonNullAssertion" }),
      lint({ line: 197, title: "Biome: lint/style/noNonNullAssertion" }),
    ]);

    expect(result).toHaveLength(1);
  });

  it("keeps the same rule on different lines", () => {
    const result = dedupeLintFindings([
      lint({ line: 197, title: "Biome: lint/style/noNonNullAssertion" }),
      lint({ line: 207, title: "Biome: lint/style/noNonNullAssertion" }),
    ]);

    expect(result).toHaveLength(2);
  });

  it("keeps different rules on the same line", () => {
    const result = dedupeLintFindings([
      lint({ line: 10, title: "ESLint: no-useless-escape" }),
      lint({ line: 10, title: "ESLint: eqeqeq" }),
    ]);

    expect(result).toHaveLength(2);
  });

  it("preserves a rule only one linter implements", () => {
    const result = dedupeLintFindings([
      lint({ title: "ESLint: no-useless-escape" }),
      lint({ title: "Biome: lint/correctness/noUnusedImports" }),
    ]);

    expect(result).toHaveLength(2);
  });
});
