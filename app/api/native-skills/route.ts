import { realpath, stat } from "node:fs/promises";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getNativeSkills } from "@/lib/native-skills";
import { createNativeSkillsHandler } from "@/lib/native-skills-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createNativeSkillsHandler({
  getSkills: getNativeSkills,
  async resolveCwd(cwd) {
    if (!(await stat(cwd)).isDirectory() || !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return undefined;
    return realpath(cwd);
  },
});
