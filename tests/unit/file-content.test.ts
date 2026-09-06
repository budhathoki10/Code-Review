import { describe, it, expect, vi, beforeEach } from "vitest";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("@/lib/github/app", () => ({
  getInstallationOctokit: vi.fn().mockResolvedValue({ request: requestMock }),
}));

import { getFileContent, clearFileContentCache, GitHubRateLimitError } from "@/lib/github/file-content";

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/** An Octokit-shaped 403 carrying the rate-limit headers. */
function rateLimited(resetEpochSeconds: number) {
  return Object.assign(new Error("API rate limit exceeded"), {
    status: 403,
    response: {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpochSeconds),
      },
    },
  });
}

const CONTENTS = "GET /repos/{owner}/{repo}/contents/{path}";
const BLOBS = "GET /repos/{owner}/{repo}/git/blobs/{file_sha}";

describe("getFileContent", () => {
  beforeEach(() => {
    requestMock.mockReset();
    clearFileContentCache();
    delete process.env.MAX_RATE_LIMIT_WAIT_MS;
  });

  it("decodes base64 file content", async () => {
    requestMock.mockResolvedValue({ data: { type: "file", content: b64("hello world"), sha: "abc" } });

    expect(await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1")).toBe("hello world");
  });

  it("optional context respects cancellation before making any request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(getFileContent(1, "acme", "widgets", "a.ts", "sha", { signal: controller.signal })).rejects.toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("optional context never waits through rate limits or caches the failure", async () => {
    const controller = new AbortController();
    requestMock.mockRejectedValueOnce(rateLimited(Math.floor(Date.now() / 1000) + 60));
    await expect(getFileContent(1, "acme", "widgets", "a.ts", "sha", { signal: controller.signal })).rejects.toThrow();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(CONTENTS, expect.objectContaining({ request: { signal: controller.signal } }));
    requestMock.mockResolvedValue({ data: { type: "file", content: b64("recovered"), sha: "blob" } });
    expect(await getFileContent(1, "acme", "widgets", "a.ts", "sha")).toBe("recovered");
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("never fetches the same path:ref twice", async () => {
    requestMock.mockResolvedValue({ data: { type: "file", content: b64("cached"), sha: "abc" } });

    await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1");
    await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1");
    await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1");

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("treats a different ref for the same path as a separate entry", async () => {
    requestMock.mockResolvedValue({ data: { type: "file", content: b64("x"), sha: "abc" } });

    await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1");
    await getFileContent(1, "acme", "widgets", "src/a.ts", "sha2");

    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("caches a miss so an unreadable path isn't re-fetched either", async () => {
    requestMock.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    expect(await getFileContent(1, "acme", "widgets", "nope.ts", "sha1")).toBeUndefined();
    expect(await getFileContent(1, "acme", "widgets", "nope.ts", "sha1")).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Blobs API when the Contents API says the file is too large", async () => {
    requestMock.mockImplementation((route: string) => {
      if (route === CONTENTS) {
        return Promise.resolve({
          data: { type: "file", content: "", encoding: "too_large", sha: "blobsha", size: 2_000_000 },
        });
      }
      return Promise.resolve({ data: { encoding: "base64", content: b64("the big file") } });
    });

    const content = await getFileContent(1, "acme", "widgets", "src/big.ts", "sha1");

    expect(content).toBe("the big file");
    expect(requestMock).toHaveBeenCalledWith(BLOBS, expect.objectContaining({ file_sha: "blobsha" }));
  });

  it("returns undefined for a binary blob rather than feeding bytes to the model", async () => {
    requestMock.mockImplementation((route: string) => {
      if (route === CONTENTS) {
        return Promise.resolve({ data: { type: "file", content: "", encoding: "too_large", sha: "blobsha" } });
      }
      const binary = Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]).toString("base64");
      return Promise.resolve({ data: { encoding: "base64", content: binary } });
    });

    expect(await getFileContent(1, "acme", "widgets", "img.png", "sha1")).toBeUndefined();
  });

  it("returns undefined for a directory listing", async () => {
    requestMock.mockResolvedValue({ data: [{ type: "file", name: "a.ts" }] });

    expect(await getFileContent(1, "acme", "widgets", "src", "sha1")).toBeUndefined();
  });

  it("waits out the reset window and retries once when rate limited", async () => {
    // Reset one second out, so the wait is real but negligible.
    const resetAt = Math.floor(Date.now() / 1000) + 1;
    requestMock
      .mockRejectedValueOnce(rateLimited(resetAt))
      .mockResolvedValueOnce({ data: { type: "file", content: b64("recovered"), sha: "abc" } });

    expect(await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1")).toBe("recovered");
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("throws GitHubRateLimitError when still limited after the retry", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 1;
    requestMock.mockRejectedValue(rateLimited(resetAt));

    await expect(getFileContent(1, "acme", "widgets", "src/a.ts", "sha1")).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("refuses to wait for a reset further out than the cap, and reports it", async () => {
    process.env.MAX_RATE_LIMIT_WAIT_MS = "1000";
    const resetAt = Math.floor(Date.now() / 1000) + 3600;
    requestMock.mockRejectedValue(rateLimited(resetAt));

    await expect(getFileContent(1, "acme", "widgets", "src/a.ts", "sha1")).rejects.toBeInstanceOf(GitHubRateLimitError);
    // One attempt only — it did not sleep for an hour and it did not retry.
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a permissions 403, which has no rate-limit headers", async () => {
    requestMock.mockRejectedValue(Object.assign(new Error("Resource not accessible"), { status: 403, response: { headers: {} } }));

    expect(await getFileContent(1, "acme", "widgets", "src/a.ts", "sha1")).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
