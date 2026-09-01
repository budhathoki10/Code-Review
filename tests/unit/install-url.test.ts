import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchAppSlug = vi.fn<() => Promise<string | undefined>>();
vi.mock("@/lib/github/app", () => ({ fetchAppSlug: () => fetchAppSlug() }));

/** Fresh module per case — the resolved slug is cached for the life of the process. */
async function loadInstallUrl() {
  vi.resetModules();
  return import("@/lib/github/install-url");
}

const originalSlug = process.env.GITHUB_APP_SLUG;

beforeEach(() => {
  fetchAppSlug.mockReset();
});

afterEach(() => {
  if (originalSlug === undefined) delete process.env.GITHUB_APP_SLUG;
  else process.env.GITHUB_APP_SLUG = originalSlug;
});

describe("slugifyAppName", () => {
  it("turns an app's display name into the slug GitHub derives from it", async () => {
    const { slugifyAppName } = await loadInstallUrl();
    expect(slugifyAppName("AI-Code_Reviewer")).toBe("ai-code-reviewer");
    expect(slugifyAppName("Guardreviewer")).toBe("guardreviewer");
    expect(slugifyAppName("  My  App!  ")).toBe("my-app");
  });

  it("leaves an already-correct slug alone", async () => {
    const { slugifyAppName } = await loadInstallUrl();
    expect(slugifyAppName("guardreviewer")).toBe("guardreviewer");
    expect(slugifyAppName("ai-code-reviewer")).toBe("ai-code-reviewer");
  });
});

describe("getInstallUrl", () => {
  it("prefers the slug GitHub reports over a stale configured one", async () => {
    process.env.GITHUB_APP_SLUG = "AI-Code_Reviewer";
    fetchAppSlug.mockResolvedValue("guardreviewer");

    const { getInstallUrl } = await loadInstallUrl();
    expect(await getInstallUrl()).toBe("https://github.com/apps/guardreviewer/installations/new");
  });

  it("resolves the slug once and reuses it", async () => {
    process.env.GITHUB_APP_SLUG = "guardreviewer";
    fetchAppSlug.mockResolvedValue("guardreviewer");

    const { getInstallUrl } = await loadInstallUrl();
    await getInstallUrl();
    await getInstallUrl();
    expect(fetchAppSlug).toHaveBeenCalledTimes(1);
  });

  it("falls back to the normalized configured slug when GitHub can't be reached", async () => {
    process.env.GITHUB_APP_SLUG = "AI-Code_Reviewer";
    fetchAppSlug.mockRejectedValue(new Error("credentials missing"));

    const { getInstallUrl } = await loadInstallUrl();
    expect(await getInstallUrl()).toBe("https://github.com/apps/ai-code-reviewer/installations/new");
  });

  it("retries GitHub after a failure rather than pinning the fallback", async () => {
    process.env.GITHUB_APP_SLUG = "AI-Code_Reviewer";
    fetchAppSlug.mockRejectedValueOnce(new Error("network")).mockResolvedValue("guardreviewer");

    const { getInstallUrl } = await loadInstallUrl();
    expect(await getInstallUrl()).toBe("https://github.com/apps/ai-code-reviewer/installations/new");
    expect(await getInstallUrl()).toBe("https://github.com/apps/guardreviewer/installations/new");
  });

  it("has no install URL when the app isn't configured at all", async () => {
    delete process.env.GITHUB_APP_SLUG;
    fetchAppSlug.mockRejectedValue(new Error("Missing GITHUB_APP_ID"));

    const { getInstallUrl } = await loadInstallUrl();
    expect(await getInstallUrl()).toBeUndefined();
  });
});
