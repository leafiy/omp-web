import { getAllowedFileRoots } from "@/lib/file-access";
import { createFileOperationHandler } from "@/lib/file-operation-http";

export const runtime = "nodejs";
export const POST = createFileOperationHandler(getAllowedFileRoots);
