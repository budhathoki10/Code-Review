/**
 * Whether a commenter is allowed to make this bot spend tokens.
 *
 * The webhook signature proves a payload came from GitHub, not that the
 * commenter has any relationship to the repo — on a public repo, any account
 * can comment on any PR. Every comment path that costs a provider call gates
 * on this: the force command (which bypasses the throttle, the size gate and
 * the triage filter) and a reply to a finding.
 *
 * The PR's own author is trusted regardless of association, since they're the
 * person most likely to be legitimately talking to the bot about their own
 * code — a first-time contributor asking why a finding on their PR is wrong
 * is the case this feature exists for.
 *
 * Lives in its own module rather than inside the route handler so the rule is
 * pinned by tests against the real implementation, not a copy of it.
 */
export function isTrustedCommenter(
  association: string | undefined,
  commenterLogin: string | undefined,
  prAuthorLogin: string | undefined,
): boolean {
  const isMaintainer =
    association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
  const isPrAuthor = Boolean(commenterLogin && prAuthorLogin && commenterLogin === prAuthorLogin);
  return isMaintainer || isPrAuthor;
}
