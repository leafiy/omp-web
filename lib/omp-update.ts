// Compatibility for cached browsers and the existing /api/omp/update endpoint.
// All four tools use the same coordinator and lock; this endpoint still only updates OMP.
import { getToolUpdates, getToolUpdateView, startToolUpdate } from "./tool-update";
export { ToolUpdateError as OmpUpdateError } from "./tool-update";

export function getOmpUpdateStatus() {
  return getToolUpdates().tools.find((tool) => tool.tool === "omp")!;
}

export async function getOmpUpdateView() {
  return (await getToolUpdateView()).tools.find((tool) => tool.tool === "omp")!;
}

export async function startOmpUpdate() {
  return (await startToolUpdate("omp")).tools.find((tool) => tool.tool === "omp")!;
}
