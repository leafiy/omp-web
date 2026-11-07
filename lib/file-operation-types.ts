export type FileOperation = "copy" | "move" | "delete" | "new-file" | "new-directory";

export interface FileOperationRequest {
  operation: FileOperation;
  source?: string;
  sourceVersion?: string;
  destination?: string;
  confirm?: boolean;
}

export interface FileOperationResult {
  operation: FileOperation;
  source?: string;
  destination?: string;
}

export type FileOperationErrorCode =
  | "invalid" | "denied" | "protected" | "conflict" | "changed" | "not-found"
  | "unsupported" | "too-large" | "busy" | "failed";
