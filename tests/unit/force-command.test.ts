import { describe, it, expect } from "vitest";
import { isForceCommand, FORCE_COMMAND } from "@/lib/review/gate";
import { isTrustedCommenter } from "@/lib/github/commenter";

/**
 * Authorization for the token-spending comment paths — the force command and
 * a reply to a finding, which share this predicate.
 *
 * The webhook signature proves a payload came from GitHub, not that the
 * commenter may spend our tokens. On a public repo anyone can comment on any
 * PR, and a forced review bypasses the throttle, the size gate and the triage
 * filter while deleting the stored review row — so identity has to be checked.
 *
 * Tests the real implementation rather than a copy of it: this used to
 * duplicate the predicate here because it lived inside the route handler,
 * which meant the test could pass while the route drifted.
 */
const isAuthorized = isTrustedCommenter;

describe("comment authorization", () => {
  it("allows repo owners, members and collaborators", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(isAuthorized(association, "someone", "alice")).toBe(true);
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
