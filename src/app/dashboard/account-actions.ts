"use server";

import { signIn } from "@/auth";

/**
 * Starts the GitHub OAuth flow for a user who is *already* signed in.
 *
 * Auth.js links the returning account to the current session's user instead
 * of creating a second workspace, so repositories installed under either
 * GitHub login end up side by side in one dashboard (ownership lookups match
 * on every linked account id — see `getGithubAccountIds`).
 *
 * `prompt=select_account` asks GitHub for its account chooser. Without it
 * GitHub silently reuses whichever account the browser is already signed in
 * as, which just re-links the account the user has, and the flow looks like
 * it did nothing.
 */

// select account before going to the dashbaord
export async function connectGithubAccount() {
  await signIn("github", { redirectTo: "/dashboard/repos" }, { prompt: "select_account" });
}
