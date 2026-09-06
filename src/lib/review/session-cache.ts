import { getFileContent } from "@/lib/github/file-content";
import type { RepoContext } from "@/lib/ai/review";

export interface CachedFile {
  path: string;
  content: string;
}

const MAX_FILES = 8;

export async function loadFiles(ctx: RepoContext, paths: string[]): Promise<CachedFile[]> {
  const loaded: CachedFile[] = [];
  for (const path of paths.slice(0, MAX_FILES)) {
    const content = await getFileContent(ctx.installationId, ctx.owner, ctx.repo, path, ctx.ref);
    if (content !== undefined) loaded.push({ path, content });
  }
  return loaded;
}
