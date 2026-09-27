import { ObjectId } from "mongodb";
import getMongoClient from "@/lib/mongodb";

interface GithubAccountDoc {
  userId: ObjectId;
  provider: string;
  /** GitHub's numeric account id, as a string — what installations are keyed by. */
  providerAccountId: string;
  /**
   * The GitHub login, recorded by the `signIn` event. Auth.js's adapter only
   * stores the numeric id, which is useless for telling a user *which*
   * accounts they have connected. Absent on accounts linked before this
   * field existed, until their next sign-in.
   */
  githubLogin?: string;
}

async function githubAccountsCollection() {
  const client = await getMongoClient();
  return client
    .db(process.env.MONGODB_DB)
    .collection<GithubAccountDoc>("accounts");
}

async function findGithubAccounts(userId: string): Promise<GithubAccountDoc[]> {
  if (!ObjectId.isValid(userId)) return [];
  const accounts = await githubAccountsCollection();
  return accounts.find({ userId: new ObjectId(userId), provider: "github" }).toArray();
}

/**
 * Every GitHub account id linked to an Auth.js user, via the adapter's
 * `accounts` collection.
 *
 * Normally one, since signing in with another GitHub login switches to that
 * login's own workspace (see `switchGithubAccount`). Accounts linked before
 * that was the behavior still have two, so ownership filters match on all of
 * them — reading just the first would hide every repo connected under the
 * others, and which one comes back first is arbitrary.
 */
export async function getGithubAccountIds(userId: string): Promise<string[]> {
  const accounts = await findGithubAccounts(userId);
  return [...new Set(accounts.map((account) => account.providerAccountId))];
}

export interface LinkedGithubAccount {
  id: string;
  /** Absent for accounts linked before logins were recorded. */
  login?: string;
}

/** The user's linked GitHub accounts, for naming them in the connect menu. */
export async function getLinkedGithubAccounts(userId: string): Promise<LinkedGithubAccount[]> {
  const accounts = await findGithubAccounts(userId);
  const byId = new Map<string, LinkedGithubAccount>();
  for (const account of accounts) {
    byId.set(account.providerAccountId, { id: account.providerAccountId, login: account.githubLogin });
  }
  return [...byId.values()];
}

/** Stores the login GitHub reported at sign-in on the matching account document. */
export async function rememberGithubLogin(providerAccountId: string, login: string): Promise<void> {
  const accounts = await githubAccountsCollection();
  await accounts.updateMany(
    { provider: "github", providerAccountId },
    { $set: { githubLogin: login } },
  );
}

/**
 * The Auth.js user a GitHub account id belongs to — the inverse of
 * `getGithubAccountIds`.
 *
 * Needed by the worker, which starts from a webhook and knows only the GitHub
 * side of the relationship: installation -> githubUserId. Anything stored
 * against the app's own user (their chosen model and API key) is unreachable
 * without this hop.
 *
 * Returns the first match. The adapter enforces one account row per
 * (provider, providerAccountId), so there cannot be a second.
 */
export async function getUserIdForGithubAccount(providerAccountId: string): Promise<string | undefined> {
  if (!providerAccountId) return undefined;
  const accounts = await githubAccountsCollection();
  const account = await accounts.findOne({ provider: "github", providerAccountId });
  return account ? String(account.userId) : undefined;
}
