import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FindingDoc } from "@/lib/db/collections";
import type { RepoContext } from "@/lib/ai/review";
import { getFileContent } from "@/lib/github/file-content";

type Test = NonNullable<FindingDoc["proof"]>["test"];
type Execution = { ok: true; value: unknown } | { ok: false };

// Trusted harness. Only source and JSON test data arrive on stdin. No generated
// shell commands, host mounts, secrets, dependency installation or networking.f
const HARNESS = `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync('/tmp/subject.' + input.extension, input.source);
(async () => {
  const module = await import('file:///tmp/subject.' + input.extension);
  if (typeof module[input.test.exportName] !== 'function') process.exit(2);
  const value = await module[input.test.exportName](...input.test.args);
  if (value === undefined) process.exit(2);
  process.stdout.write('PRSENTRY_RESULT:' + JSON.stringify(value) + '\\n');
})().catch(() => process.exit(2));
`;

/** Requires an explicitly configured, preinstalled digest-pinned Node 24 image. */
export function proofImage(): string | undefined {
  const image = process.env.REVIEW_TEST_PROOF_IMAGE;
  return image && /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image) ? image : undefined;
}

function execute(image: string, source: string, extension: string, test: Test): Promise<Execution> {
  const name = `prsentry-proof-${randomUUID()}`;
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawn("docker", [
      "run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=128m", "--memory-swap=128m",
      "--cpus=0.5", "--pids-limit=32", "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=8m",
      "-i", "--entrypoint=node", image, "--disable-proto=throw", "--experimental-strip-types", "-e", HARNESS,
    ], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (result: Execution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      // Killing the CLI alone does not guarantee the container stopped.
      const cleanup = spawn("docker", ["rm", "-f", name], { shell: false, windowsHide: true, stdio: "ignore" });
      const cleanupTimer = setTimeout(() => { cleanup.kill(); resolve(result); }, 3000);
      cleanup.once("error", () => { clearTimeout(cleanupTimer); resolve(result); });
      cleanup.once("close", () => { clearTimeout(cleanupTimer); resolve(result); });
    };
    const timer = setTimeout(() => finish({ ok: false }), 8000);
    child.once("error", () => finish({ ok: false }));
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (Buffer.byteLength(output) > 16000) finish({ ok: false });
    });
    child.once("close", (code) => {
      const results = output.split("\n").filter((line) => line.startsWith("PRSENTRY_RESULT:"));
      if (code !== 0 || results.length !== 1) return finish({ ok: false });
      try { finish({ ok: true, value: JSON.parse(results[0].slice("PRSENTRY_RESULT:".length)) }); }
      catch { finish({ ok: false }); }
    });
    child.stdin.on("error", () => finish({ ok: false }));
    child.stdin.end(JSON.stringify({ source, extension, test }));
  });
}

/** Limited to one self-contained exported function and JSON input/output. */
export async function reproduceFinding(finding: FindingDoc, test: Test, repo: RepoContext, baseSha: string | undefined): Promise<NonNullable<FindingDoc["proof"]>> {
  const result: NonNullable<FindingDoc["proof"]> = { status: "unavailable", reason: "Isolated test runner unavailable or unsupported function.", headSha: repo.ref, baseSha, test };
  const image = proofImage();
  const extension = finding.file.match(/\.(mjs|js|ts)$/)?.[1];
  if (!image || !extension || !baseSha || baseSha === repo.ref || !/^[A-Za-z_$][\w$]*$/.test(test.exportName) || JSON.stringify(test).length > 4000) return result;
  const signal = AbortSignal.timeout(5000);
  const [base, head] = await Promise.all([baseSha, repo.ref].map((sha) => getFileContent(repo.installationId, repo.owner, repo.repo, finding.file, sha, { signal }).catch(() => undefined)));
  if (base === undefined || head === undefined || base.length > 100000 || head.length > 100000) return result;
  // .js repository files can be ESM regardless of the source repository's package.json.
  const runnableExtension = extension === "js" ? "mjs" : extension;
  const before = await execute(image, base, runnableExtension, test);
  if (!before.ok) return result;
  if (!isDeepStrictEqual(before.value, test.expected)) return { ...result, status: "not-reproduced", reason: "The proposed expectation does not pass on the base commit." };
  const after = await execute(image, head, runnableExtension, test);
  if (!after.ok) return result;
  return isDeepStrictEqual(after.value, test.expected)
    ? { ...result, status: "not-reproduced", reason: "The same test passes on both commits." }
    : { ...result, status: "reproduced", reason: "The proposed JSON-output assertion passes on base and fails on head. Review the expectation for intended behavior." };
}
