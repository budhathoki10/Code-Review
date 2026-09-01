import { fetchAppSlug } from "@/lib/github/app";

/**
 * GitHub derives an app's URL slug from its name: lowercased, with every run
 * of non-alphanumeric characters collapsed into a single hyphen. Setting
 * GITHUB_APP_SLUG to the app's display name instead ("AI-Code_Reviewer",
 * "Guardreviewer") is an easy mistake to make and the only symptom is a 404
 * on the install page, so normalize whatever is configured before using it.
 */
export function slugifyAppName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolved once per process — the slug only changes if the app itself is renamed. */
let cachedSlug: string | undefined;

/**
 * The app's slug as GitHub itself computes it, which is the only value
 * guaranteed to resolve at github.com/apps/<slug>. Falls back to the
 * normalized GITHUB_APP_SLUG when the app credentials are missing or GitHub
 * can't be reached — a best guess beats dropping the connect button, and the
 * failure isn't worth taking a dashboard render down for.
 */
export async function getGithubAppSlug(): Promise<string | undefined> {
  if (cachedSlug) return cachedSlug;

  const configured = process.env.GITHUB_APP_SLUG?.trim();
  const fallback = configured ? slugifyAppName(configured) : undefined;

  try {
    const slug = await fetchAppSlug();
    cachedSlug = slug ?? fallback;
    return cachedSlug;
  } catch {
    // Not cached: a transient GitHub failure shouldn't pin the fallback for
    // the lifetime of the process.
    return fallback;
  }
}

/**
 * Where "connect a repo" sends the user — GitHub's installation picker, which
 * is also where an existing installation's repository list is edited.
 * `undefined` when the app isn't configured at all, which the callers render
 * as a setup hint instead of a dead link.
 */
export async function getInstallUrl(): Promise<string | undefined> {
  const slug = await getGithubAppSlug();
  return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
}
