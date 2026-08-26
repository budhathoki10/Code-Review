import { describe, it, expect } from "vitest";
import { isDuplicateKeyError } from "@/lib/db/mongo-errors";

describe("isDuplicateKeyError", () => {
  it("recognizes a MongoDB E11000 duplicate-key error", () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
  });

  it("rejects an error with a different code", () => {
    expect(isDuplicateKeyError({ code: 121 })).toBe(false);
  });

  it("rejects non-error values", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError("some string")).toBe(false);
    expect(isDuplicateKeyError(new Error("boom"))).toBe(false);
  });
});
