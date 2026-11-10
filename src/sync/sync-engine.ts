import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { StateStore } from "../state-store.js";
import type { DaemonStatus, ProjectTree, RemoteFile, SyncConfig, SyncState } from "../types.js";
import { hashContent } from "../util/hash.js";
import { isControlPath, toLocalPath, toRemotePath } from "../util/paths.js";
import type { ShareLatexRemoteClient } from "../remote/client.js";
import { reconcileFile } from "./reconcile.js";

export interface SyncSummary {
  downloaded: string[];
  uploaded: string[];
  conflicted: string[];
  ignored: string[];
  unchanged: string[];
}

type SyncEvent = "status" | "summary";

export class SyncEngine extends EventEmitter {
  private activeSync?: Promise<SyncSummary>;
  private pendingPaths = new Set<string>();
  private phase: DaemonStatus["phase"] = "idle";
  private watching = false;
  private lastError?: string;
  private lastSyncAt?: string;

  constructor(
    readonly config: SyncConfig,
    readonly store: StateStore,
    readonly client: ShareLatexRemoteClient,
  ) {
    super();
  }

  on(event: SyncEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  queuePath(relativePath: string): void {
    const normalized = toRemotePath(relativePath);
    if (normalized && !isControlPath(normalized)) {
      this.pendingPaths.add(normalized);
      this.emitStatus();
    }
  }

  async syncAll(): Promise<SyncSummary> {
    return this.runSerialized(() => this.synchronize());
  }

  setWatching(watching: boolean): void {
    this.watching = watching;
    if (this.phase !== "syncing" && this.phase !== "error") {
      this.phase = watching ? "watching" : "idle";
    }
    this.emitStatus();
  }

  async syncPaths(paths: Iterable<string>): Promise<SyncSummary> {
    const requestedPaths = new Set(
      [...paths].map(toRemotePath).filter((filePath) => filePath.length > 0 && !isControlPath(filePath)),
    );
    if (requestedPaths.size === 0) {
      return { downloaded: [], uploaded: [], conflicted: [], ignored: [], unchanged: [] };
    }
    return this.runSerialized(() => this.synchronize(requestedPaths));
  }

  async flushQueuedPaths(): Promise<SyncSummary> {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();
    return this.syncPaths(paths);
  }

  async compile(): Promise<{ pdfPath?: string; outputPath?: string; raw: unknown }> {
    const result = await this.client.compile(this.config.projectId);
    if (result.pdf) {
      const outputPath = path.join(this.store.outputDirectory, "output.pdf");
      await this.store.writeFileAtomically(outputPath, result.pdf);
      return { pdfPath: result.pdfPath, outputPath, raw: result.raw };
    }
    return { raw: result.raw };
  }

  async resolveConflict(id: string, choice: "local" | "remote"): Promise<void> {
    const conflict = await this.store.getConflict(id);
    if (!conflict) {
      throw new Error(`No conflict with id ${id}`);
    }
    const local = await this.store.readConflictSnapshot(id, "local");
    const remoteSnapshot = await this.store.readConflictSnapshot(id, "remote");
    const tree = await this.client.getProjectTree(this.config.projectId);
    const remoteFile = tree.files.get(conflict.path);
    const localPath = toLocalPath(this.store.projectDirectory, conflict.path);
    const currentLocal = await this.readLocalFile(localPath);
    const state = await this.store.loadState();

    if (hashContent(currentLocal) !== hashContent(local)) {
      throw new Error(
        `Local file ${conflict.path} changed again after this conflict was recorded. Synchronize again before resolving the conflict.`,
      );
    }

    if (choice === "local") {
      const currentRemote = remoteFile ? await this.client.readFile(this.config.projectId, remoteFile) : undefined;
      if (hashContent(currentRemote) !== hashContent(remoteSnapshot)) {
        throw new Error(
          `Remote file ${conflict.path} changed again after this conflict was recorded. Synchronize again before choosing the local version.`,
        );
      }
    }

    if (choice === "local") {
      if (local === undefined) {
        if (remoteFile && this.config.propagateDeletes) {
          await this.client.deleteFile(this.config.projectId, remoteFile);
          await this.store.updateBaseline(state, conflict.path, undefined, undefined);
        } else {
          throw new Error(`Cannot resolve ${conflict.path} to a local deletion while delete propagation is disabled.`);
        }
      } else {
        const uploaded = await this.client.uploadFile(this.config.projectId, tree, conflict.path, local);
        await this.store.writeFileAtomically(localPath, local);
        await this.store.updateBaseline(state, conflict.path, { hash: hashContent(local)!, remoteId: uploaded.id, kind: uploaded.kind }, local);
      }
    } else {
      const currentRemote = remoteFile ? await this.client.readFile(this.config.projectId, remoteFile) : undefined;
      if (currentRemote === undefined) {
        if (!this.config.propagateDeletes) {
          throw new Error(`Remote file ${conflict.path} no longer exists and delete propagation is disabled.`);
        }
        await fs.rm(localPath, { force: true });
        await this.store.updateBaseline(state, conflict.path, undefined, undefined);
      } else {
        await this.store.writeFileAtomically(localPath, currentRemote);
        await this.store.updateBaseline(
          state,
          conflict.path,
          { hash: hashContent(currentRemote)!, remoteId: remoteFile!.id, kind: remoteFile!.kind },
          currentRemote,
        );
      }
    }
    await this.store.saveState(state);
    await this.store.clearConflict(id);
    this.emitStatus();
  }

  async syncCode(file: string, line: number, column: number, buildId: string): Promise<unknown> {
    return this.client.syncCode(this.config.projectId, file, line, column, buildId);
  }

  async syncPdf(page: number, h: number, v: number, buildId: string): Promise<unknown> {
    return this.client.syncPdf(this.config.projectId, page, h, v, buildId);
  }

  async status(): Promise<DaemonStatus> {
    return {
      phase: this.phase,
      project: {
        serverUrl: this.config.serverUrl,
        projectId: this.config.projectId,
        projectName: this.config.projectName,
      },
      pendingPaths: [...this.pendingPaths].sort(),
      conflicts: await this.store.listConflicts(),
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  private async runSerialized(operation: () => Promise<SyncSummary>): Promise<SyncSummary> {
    if (this.activeSync) {
      await this.activeSync;
      return this.runSerialized(operation);
    }
    this.activeSync = operation();
    try {
      return await this.activeSync;
    } finally {
      this.activeSync = undefined;
    }
  }

  private async synchronize(requestedPaths?: Set<string>): Promise<SyncSummary> {
    this.phase = "syncing";
    this.lastError = undefined;
    this.emitStatus();
    const summary: SyncSummary = { downloaded: [], uploaded: [], conflicted: [], ignored: [], unchanged: [] };
    try {
      const [tree, state, localPaths] = await Promise.all([
        this.client.getProjectTree(this.config.projectId),
        this.store.loadState(),
        requestedPaths === undefined ? this.listLocalPaths() : Promise.resolve(new Set<string>()),
      ]);
      let remoteChangedPaths: Set<string> | undefined;
      if (state.remoteVersion !== undefined) {
        try {
          const changes = await this.client.getRemoteChanges(this.config.projectId, state.remoteVersion);
          if (changes) {
            remoteChangedPaths = changes.paths;
            state.remoteVersion = changes.version;
          }
        } catch {
          remoteChangedPaths = undefined;
        }
      }
      const paths = requestedPaths ?? new Set<string>([...tree.files.keys(), ...Object.keys(state.files), ...localPaths]);
      for (const filePath of paths) {
        this.pendingPaths.delete(filePath);
      }
      const existingConflicts = new Set((await this.store.listConflicts()).map((conflict) => conflict.path));

      for (const relativePath of [...paths].filter((item) => !isControlPath(item)).sort()) {
        await this.syncPath(relativePath, tree, state, summary, existingConflicts, remoteChangedPaths, requestedPaths);
      }

      state.lastSyncAt = new Date().toISOString();
      if (state.remoteVersion === undefined) {
        try {
          const detected = await this.client.getRemoteChanges(this.config.projectId, 0);
          if (detected) {
            state.remoteVersion = detected.version;
          }
        } catch {
          // A number of ShareLaTeX versions do not expose project history. The next pass falls back to a file scan.
        }
      }
      await this.store.saveState(state);
      this.lastSyncAt = state.lastSyncAt;
      this.phase = this.watching ? "watching" : "idle";
      this.emit("summary", summary);
      return summary;
    } catch (error) {
      this.phase = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.emitStatus();
    }
  }

  private async syncPath(
    relativePath: string,
    tree: ProjectTree,
    state: SyncState,
    summary: SyncSummary,
    existingConflicts: Set<string>,
    remoteChangedPaths?: Set<string>,
    requestedPaths?: Set<string>,
  ): Promise<void> {
    const localPath = toLocalPath(this.store.projectDirectory, relativePath);
    const localContent = await this.readLocalFile(localPath);
    const remoteFile = tree.files.get(relativePath);
    const baseline = state.files[relativePath];
    const localHash = hashContent(localContent);
    let remoteContent: Uint8Array | undefined;
    let remoteHash: string | undefined;
    const remoteCanUseBaseline =
      remoteFile !== undefined &&
      baseline !== undefined &&
      baseline.remoteId === remoteFile.id &&
      remoteChangedPaths !== undefined &&
      !remoteChangedPaths.has(relativePath) &&
      !requestedPaths?.has(relativePath) &&
      localHash === baseline.hash;
    if (remoteFile && remoteCanUseBaseline) {
      remoteHash = baseline.hash;
    } else if (remoteFile) {
      remoteContent = await this.client.readFile(this.config.projectId, remoteFile);
      remoteHash = hashContent(remoteContent);
    }
    const decision = reconcileFile({
      localHash,
      remoteHash,
      baselineHash: baseline?.hash,
      propagateDeletes: this.config.propagateDeletes,
    });

    if (decision.action === "noop") {
      if (localContent !== undefined && remoteContent !== undefined && remoteFile) {
        await this.store.updateBaseline(state, relativePath, { hash: hashContent(localContent)!, remoteId: remoteFile.id, kind: remoteFile.kind }, localContent);
      } else if (localContent === undefined && remoteContent === undefined) {
        await this.store.updateBaseline(state, relativePath, undefined, undefined);
      }
      summary.unchanged.push(relativePath);
      return;
    }
    if (decision.action === "ignore") {
      summary.ignored.push(relativePath);
      return;
    }
    if (decision.action === "conflict") {
      await this.store.recordConflict(
        {
          path: relativePath,
          reason: localContent === undefined || remoteContent === undefined ? "delete-conflict" : "changed-on-both-sides",
          localExists: localContent !== undefined,
          remoteExists: remoteContent !== undefined,
          baselineHash: baseline?.hash,
        },
        { baseline: await this.store.readBaseline(relativePath), local: localContent, remote: remoteContent },
      );
      existingConflicts.add(relativePath);
      summary.conflicted.push(relativePath);
      return;
    }
    if (decision.action === "download") {
      if (remoteContent === undefined || !remoteFile) {
        if (!this.config.propagateDeletes) {
          summary.ignored.push(relativePath);
          return;
        }
        await fs.rm(localPath, { force: true });
        await this.store.updateBaseline(state, relativePath, undefined, undefined);
      } else {
        await this.store.writeFileAtomically(localPath, remoteContent);
        await this.store.updateBaseline(state, relativePath, { hash: hashContent(remoteContent)!, remoteId: remoteFile.id, kind: remoteFile.kind }, remoteContent);
      }
      summary.downloaded.push(relativePath);
      return;
    }
    if (localContent === undefined) {
      if (!remoteFile || !this.config.propagateDeletes) {
        summary.ignored.push(relativePath);
        return;
      }
      await this.client.deleteFile(this.config.projectId, remoteFile);
      tree.files.delete(relativePath);
      await this.store.updateBaseline(state, relativePath, undefined, undefined);
      summary.uploaded.push(relativePath);
      return;
    }
    const uploaded = await this.client.uploadFile(this.config.projectId, tree, relativePath, localContent);
    await this.store.updateBaseline(state, relativePath, { hash: hashContent(localContent)!, remoteId: uploaded.id, kind: uploaded.kind }, localContent);
    summary.uploaded.push(relativePath);
  }

  private async listLocalPaths(): Promise<Set<string>> {
    const paths = new Set<string>();
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isControlPath(relativePath) || entry.isSymbolicLink()) {
          continue;
        }
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath, relativePath);
        } else if (entry.isFile()) {
          paths.add(relativePath);
        }
      }
    };
    await walk(this.store.projectDirectory, "");
    return paths;
  }

  private async readLocalFile(filePath: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private emitStatus(): void {
    void this.status().then((status) => this.emit("status", status));
  }
}
