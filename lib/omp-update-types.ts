export type OmpUpdatePhase = "idle" | "updating" | "restarting" | "succeeded" | "failed";

export interface OmpUpdateStatus {
  available: boolean;
  unavailableReason?: string;
  phase: OmpUpdatePhase;
  id?: string;
  previousVersion?: string;
  currentVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  output: string;
  error?: string;
}
