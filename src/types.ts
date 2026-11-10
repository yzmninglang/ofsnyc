export type FileKind = "doc" | "file";

export interface RemoteFile {
  path: string;
  id: string;
  kind: FileKind;
  parentFolderId: string;
  content?: Uint8Array;
}

export interface RemoteFolder {
  id: string;
  path: string;
  parentFolderId?: string;
}

export interface ProjectTree {
  id: string;
  name: string;
  files: Map<string, RemoteFile>;
  folders: Map<string, RemoteFolder>;
}

export interface SyncConfig {
  version: 1;
  serverUrl: string;
  projectId: string;
  projectName: string;
  cookieEnv: string;
  emailEnv?: string;
  passwordEnv?: string;
  remotePollIntervalMs: number;
  localDebounceMs: number;
  propagateDeletes: boolean;
}

export interface FileBaseline {
  hash: string;
  remoteId: string;
  kind: FileKind;
}

export interface SyncState {
  version: 1;
  files: Record<string, FileBaseline>;
  remoteVersion?: number;
  lastSyncAt?: string;
}

export type ConflictReason = "changed-on-both-sides" | "delete-conflict";

export interface SyncConflict {
  id: string;
  path: string;
  reason: ConflictReason;
  createdAt: string;
  localExists: boolean;
  remoteExists: boolean;
  baselineHash?: string;
}

export interface DaemonStatus {
  phase: "idle" | "syncing" | "watching" | "error";
  project: Pick<SyncConfig, "serverUrl" | "projectId" | "projectName">;
  pendingPaths: string[];
  conflicts: SyncConflict[];
  lastSyncAt?: string;
  lastError?: string;
}

export type ReconcileAction = "upload" | "download" | "noop" | "conflict" | "ignore";

export interface ReconcileDecision {
  action: ReconcileAction;
  reason: string;
}
