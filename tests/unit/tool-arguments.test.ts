import { describe, it, expect } from "vitest";
import { parseToolArguments, repairJsonEscapes } from "@/lib/ai/tool-arguments";

/**
 * Every case here is a literal payload, written with `String.raw` so the test
 * file's own escaping never stands between the reader and the bytes the
 * provider actually sends.
 */
describe("parseToolArguments", () => {
  it("leaves well-formed arguments exactly as JSON.parse would", () => {
    const cases = [
      String.raw`{"path":"src/index.ts"}`,
      String.raw`{"text":"line one\nline two"}`,
      String.raw`{"text":"a literal backslash: \\"}`,
      String.raw`{"text":"an \"escaped\" quote"}`,
      String.raw`{"text":"\u0041\t\r\f\b"}`,
      String.raw`{"findings":[{"line":12,"title":"x"}]}`,
    ];
    for (const raw of cases) {
      expect(parseToolArguments(raw)).toEqual(JSON.parse(raw));
    }
  });

  it("recovers a regex the model wrote without escaping its backslashes", () => {
    // `\d` is not a legal JSON escape, so this whole tool call used to be
    // rejected and the chunk's findings lost with it.
    const raw = String.raw`{"suggestion":"/ssn[ -]*\d{4,}/iu"}`;
    expect(() => JSON.parse(raw)).toThrow();

    const parsed = parseToolArguments(raw) as { suggestion: string };
    expect(parsed.suggestion).toBe(String.raw`/ssn[ -]*\d{4,}/iu`);
    expect(new RegExp(String.raw`ssn[ -]*\d{4,}`, "iu").test("ssn 6789")).toBe(true);
  });

  it("recovers a Windows path and the other common illegal escapes", () => {
    expect(parseToolArguments(String.raw`{"p":"C:\Users\app"}`)).toEqual({ p: String.raw`C:\Users\app` });
    expect(parseToolArguments(String.raw`{"p":"\s+\w+"}`)).toEqual({ p: String.raw`\s+\w+` });
  });

  it("rethrows the original error when the payload is broken for another reason", () => {
    expect(() => parseToolArguments('{"unclosed": ')).toThrow(SyntaxError);
    expect(() => parseToolArguments("not json at all")).toThrow(SyntaxError);
  });
});

describe("repairJsonEscapes", () => {
  it("does not double-escape a backslash that is already escaped", () => {
    // Two characters in, two out: the pair is consumed together, so the `n`
    // is never mistaken for the start of a newline escape.
    expect(repairJsonEscapes(String.raw`"a\\nb"`)).toBe(String.raw`"a\\nb"`);
  });

  it("escapes a trailing lone backslash", () => {
    expect(repairJsonEscapes("\\")).toBe("\\\\");
  });

  it("leaves a string with no backslashes untouched", () => {
    expect(repairJsonEscapes('{"a":"b"}')).toBe('{"a":"b"}');
  });
});
