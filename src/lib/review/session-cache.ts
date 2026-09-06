import { getFileContent } from "@/lib/github/file-content";
import type { RepoContext } from "@/lib/ai/review";

export interface CachedFile {
  path: string;
  content: string;
}

const MAX_FILES = Number(process.env.SESSION_CACHE_MAX_FILES ?? 8);
const FETCH_BUDGET_MS = 6000;

export async function loadFiles(ctx: RepoContext, paths: string[]): Promise<CachedFile[]> {
  const loaded: CachedFile[] = [];
  const signal = AbortSignal.timeout(FETCH_BUDGET_MS);
  for (const path of paths.slice(0, MAX_FILES)) {
    const content = await getFileContent(ctx.installationId, ctx.owner, ctx.repo, path, ctx.ref, { signal })
      .catch(() => undefined);
    if (content !== undefined) loaded.push({ path, content });
  }
  return loaded;
}

export function summarize(files: CachedFile[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i <= files.length; i++) {
    const file = files[i];
    const rendered = `--- ${file.path}\n${file.content}`;
    if (used + rendered.length > maxChars) break;
    parts.push(rendered);
    used += rendered.length;
  }
  return parts.join("\n\n");
}
