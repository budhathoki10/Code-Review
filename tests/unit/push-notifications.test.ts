import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { parsePushSubscription } from "@/lib/push/subscription";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  setVapidDetails: vi.fn(),
  findReviewAndUpdate: vi.fn(),
  deleteSubscription: vi.fn(),
}));

vi.mock("web-push", () => ({ default: { sendNotification: mocks.send, setVapidDetails: mocks.setVapidDetails } }));
vi.mock("@/lib/db/collections", () => ({
  installations: async () => ({ findOne: async () => ({ githubUserId: "123" }) }),
  pushSubscriptions: async () => ({
    find: () => ({ limit: () => ({ toArray: async () => [{
      userId: "user-1", endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    }] }) }),
    deleteOne: mocks.deleteSubscription,
  }),
  reviews: async () => ({ findOneAndUpdate: mocks.findReviewAndUpdate }),
  pullRequests: async () => ({ findOne: async () => ({ repositoryId: new ObjectId().toHexString() }) }),
}));
vi.mock("@/lib/github/account", () => ({ getUserIdForGithubAccount: async () => "user-1" }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test",
  keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("push subscriptions", () => {
  it("accepts browser endpoints and rejects server-side request targets", () => {
    expect(parsePushSubscription(subscription)).toEqual(subscription);
    expect(parsePushSubscription({ ...subscription, endpoint: "http://127.0.0.1/admin" })).toBeNull();
    expect(parsePushSubscription({ ...subscription, endpoint: "https://fcm.googleapis.com.evil.test/send" })).toBeNull();
    expect(parsePushSubscription({ ...subscription, keys: { p256dh: "bad", auth: "bad" } })).toBeNull();
  });

  it("claims the review once before delivering to a subscribed browser", async () => {
    vi.stubEnv("VAPID_SUBJECT", "mailto:test@example.com");
    vi.stubEnv("VAPID_PUBLIC_KEY", "public");
    vi.stubEnv("VAPID_PRIVATE_KEY", "private");
    mocks.findReviewAndUpdate.mockResolvedValueOnce({ findings: [{}, {}] }).mockResolvedValueOnce(null);
    mocks.send.mockResolvedValue({});
    const { notifyReviewOutcome } = await import("@/lib/push/delivery");
    const data = {
      reviewId: new ObjectId().toHexString(),
      pullRequestId: new ObjectId().toHexString(),
      headSha: "abc",
      githubInstallationId: 1,
      owner: "someone",
      repo: "example",
      prNumber: 12,
    };
    await notifyReviewOutcome(data, "completed");
    await notifyReviewOutcome(data, "completed");
    expect(mocks.findReviewAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", pushNotifiedAt: { $exists: false } }),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.send.mock.calls[0][1])).toMatchObject({ title: "Code review ready", body: "someone/example #12: 2 findings." });
  });
});
