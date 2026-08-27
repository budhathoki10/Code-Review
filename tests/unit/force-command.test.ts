import { describe, it, expect } from "vitest";
import { isForceCommand, FORCE_COMMAND } from "@/lib/review/gate";

/**
 * Authorization for `@prsentry review --force`.
 *
 * The webhook signature proves a payload came from GitHub, not that the
 * commenter may spend our tokens. On a public repo anyone can comment on any
 * PR, and a forced review bypasses the throttle, the size gate and the triage
 * filter while deleting the stored review row — so identity has to be checked.
 *
 * Mirrors the predicate in handleForceCommand; kept here so the rule is
 * pinned by a test rather than living only inside a route handler that has no
 * test harness.
 */
function isAuthorized(association: string | undefined, commenter?: string, prAuthor?: string): boolean {
  const isMaintainer = association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
  const isPrAuthor = Boolean(commenter && prAuthor && commenter === prAuthor);
  return isMaintainer || isPrAuthor;
}

describe("force command authorization", () => {
  it("allows repo owners, members and collaborators", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(isAuthorized(association)).toBe(true);
    }
  });

  it("allows the PR author to force a review of their own PR", () => {
    expect(isAuthorized("CONTRIBUTOR", "alice", "alice")).toBe(true);
  });

  it("refuses a drive-by commenter with no relationship to the repo", () => {
    // The abuse case: any GitHub account commenting on a public repo's PR.
    expect(isAuthorized("NONE", "randomuser", "alice")).toBe(false);
    expect(isAuthorized("FIRST_TIME_CONTRIBUTOR", "randomuser", "alice")).toBe(false);
    expect(isAuthorized(undefined, "randomuser", "alice")).toBe(false);
  });

  it("refuses a contributor commenting on someone else's PR", () => {
    expect(isAuthorized("CONTRIBUTOR", "bob", "alice")).toBe(false);
  });
});

describe("isForceCommand", () => {
  it("still matches the documented command", () => {
    expect(isForceCommand(FORCE_COMMAND)).toBe(true);
  });
});
