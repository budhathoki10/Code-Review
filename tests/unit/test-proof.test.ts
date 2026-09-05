import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, fetchFile } = vi.hoisted(() => ({ spawnMock: vi.fn(), fetchFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/github/file-content", () => ({ getFileContent: fetchFile }));
import { proofImage, reproduceFinding } from "@/lib/review/test-proof";
const image = `node@sha256:${"a".repeat(64)}`;
const finding = { file: "src/math.ts", title: "Changed return", explanation: "A regression", category: "bug" as const, severity: "high" as const };
const repo = { installationId: 1, owner: "test", repo: "repo", ref: "head" };
const test = { exportName: "calculate", args: [0], expected: 0 };

function executions(values: unknown[]) {
  spawnMock.mockImplementation((_command, args) => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stdin: EventEmitter & { end: ReturnType<typeof vi.fn> } };
    child.kill = vi.fn(); child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: vi.fn(() => queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(`PRSENTRY_RESULT:${JSON.stringify(values.shift())}\n`));
      child.emit("close", 0);
    })) });
    if (args[0] === "rm") queueMicrotask(() => child.emit("close", 0));
    return child;
  });
}
beforeEach(() => { vi.clearAllMocks(); fetchFile.mockResolvedValue("export function calculate(x: number) { return x; }"); vi.stubEnv("REVIEW_TEST_PROOF_IMAGE", image); });
afterEach(() => vi.unstubAllEnvs());

describe("isolated regression assertions", () => {
  it("requires explicit digest-pinned configuration", async () => {
    vi.stubEnv("REVIEW_TEST_PROOF_IMAGE", "node:latest");
    expect(proofImage()).toBeUndefined();
    expect((await reproduceFinding(finding, test, repo, "base")).status).toBe("unavailable");
    expect(spawnMock).not.toHaveBeenCalled();
  });
  it("only marks reproduced when base passes and head fails the same assertion", async () => {
    executions([0, 10]);
    expect((await reproduceFinding(finding, test, repo, "base")).status).toBe("reproduced");
    const runs = spawnMock.mock.calls.filter((call) => call[1][0] === "run");
    expect(runs).toHaveLength(2);
    for (const [command, args, options] of runs) {
      expect(command).toBe("docker"); expect(options.shell).toBe(false);
      expect(args).toEqual(expect.arrayContaining(["--network=none", "--read-only", "--cap-drop=ALL", "--pull=never", "--user=65534:65534"]));
      expect(args).not.toContain("-v"); expect(args).not.toContain("--env");
    }
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === "rm")).toHaveLength(2);
    expect(fetchFile).toHaveBeenCalledWith(1, "test", "repo", finding.file, "base", { signal: expect.any(AbortSignal) });
    expect(fetchFile).toHaveBeenCalledWith(1, "test", "repo", finding.file, "head", { signal: expect.any(AbortSignal) });
  });
  it("does not count a failing baseline as a newly introduced regression", async () => {
    executions([20]);
    expect((await reproduceFinding(finding, test, repo, "base")).status).toBe("not-reproduced");
    expect(spawnMock.mock.calls.filter((call) => call[1][0] === "run")).toHaveLength(1);
  });
  it("reports no reproduction when both versions pass", async () => {
    executions([0, 0]);
    expect((await reproduceFinding(finding, test, repo, "base")).status).toBe("not-reproduced");
  });
  it("rejects unsupported files and missing baselines without execution", async () => {
    expect((await reproduceFinding({ ...finding, file: "src/index.py" }, test, repo, "base")).status).toBe("unavailable");
    expect((await reproduceFinding(finding, test, repo, undefined)).status).toBe("unavailable");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
