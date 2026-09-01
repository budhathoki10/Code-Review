"use server";

import { signIn, signOut } from "@/auth";

/**
 * Signs out, then starts a fresh GitHub sign-in so the chosen account lands
 * in its own workspace.
 *
 * Dropping the session first is the whole point: Auth.js links a returning
 * OAuth account to whoever is *currently* signed in, so running `signIn`
 * with a live session would merge the two GitHub logins into one workspace
 * instead of moving between them. With no session there is nothing to link
 * to, and the account resolves to its own user (created on first sign-in).
 *
 * `prompt=select_account` asks GitHub for its account chooser. Without it
 * GitHub reuses whichever account the browser is already signed in as and
 * drops the user straight back where they started.
 */
export async function switchGithubAccount() {
  await signOut({ redirect: false });
  await signIn("github", { redirectTo: "/dashboard" }, { prompt: "select_account" });
}
