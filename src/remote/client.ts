import type { CompileResult, RemoteChanges } from "./sharelatex-client.js";
import type { ProjectTree, RemoteFile } from "../types.js";

export interface ShareLatexRemoteClient {
  getProjectTree(projectId: string): Promise<ProjectTree>;
  readFile(projectId: string, remoteFile: RemoteFile): Promise<Uint8Array>;
  uploadFile(projectId: string, tree: ProjectTree, remotePath: string, content: Uint8Array): Promise<RemoteFile>;
  deleteFile(projectId: string, remoteFile: RemoteFile): Promise<void>;
  getRemoteChanges(projectId: string, fromVersion: number): Promise<RemoteChanges | undefined>;
  compile(projectId: string, rootResourcePath?: string | null): Promise<CompileResult>;
  syncCode(projectId: string, file: string, line: number, column: number, buildId: string): Promise<unknown>;
  syncPdf(projectId: string, page: number, h: number, v: number, buildId: string): Promise<unknown>;
}
