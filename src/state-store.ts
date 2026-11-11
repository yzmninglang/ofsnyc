import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { FileBaseline, SyncConfig, SyncConflict, SyncState } from "./types.js";
import { CONTROL_DIRECTORY, toLocalPath } from "./util/paths.js";

const EMPTY_STATE: SyncState = { version: 1, files: {} };

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

export class StateStore {
  readonly controlDirectory: string;
  readonly baselineDirectory: string;
  readonly conflictsDirectory: string;
  readonly outputDirectory: string;

  constructor(readonly projectDirectory: string) {
    this.controlDirectory = path.join(projectDirectory, CONTROL_DIRECTORY);
    this.baselineDirectory = path.join(this.controlDirectory, "baseline");
    this.conflictsDirectory = path.join(this.controlDirectory, "conflicts");
    this.outputDirectory = path.join(this.controlDirectory, "output");
  }

  get configPath(): string {
    return path.join(this.controlDirectory, "config.json");
  }

  get statePath(): string {
    return path.join(this.controlDirectory, "state.json");
  }

  get conflictsPath(): string {
    return path.join(this.controlDirectory, "conflicts.json");
  }

  get requestLogPath(): string {
    return path.join(this.controlDirectory, "requests.log");
  }

  async initialize(config: SyncConfig): Promise<void> {
    const existing = await readJson<SyncConfig | undefined>(this.configPath, undefined);
    if (existing && (existing.serverUrl !== config.serverUrl || existing.projectId !== config.projectId)) {
      throw new Error(
        `This directory is already initialized for ${existing.serverUrl} project ${existing.projectId}. Remove ${this.controlDirectory} only after resolving or backing up its state before binding a different project.`,
      );
    }
    await fs.mkdir(this.controlDirectory, { recursive: true });
    await fs.mkdir(this.baselineDirectory, { recursive: true });
    await fs.mkdir(this.conflictsDirectory, { recursive: true });
    await fs.mkdir(this.outputDirectory, { recursive: true });
    await writeJsonAtomically(this.configPath, config);
    if (!(await this.exists(this.statePath))) {
      await this.saveState(EMPTY_STATE);
    }
    if (!(await this.exists(this.conflictsPath))) {
      await writeJsonAtomically(this.conflictsPath, []);
    }
  }

  async loadConfig(): Promise<SyncConfig> {
    const config = await readJson<SyncConfig | undefined>(this.configPath, undefined);
    if (config === undefined) {
      throw new Error(`No ofsync configuration found in ${this.controlDirectory}. Run \`ofsync init\` first.`);
    }
    if (config.version !== 1) {
      throw new Error(`Unsupported ofsync configuration version: ${String(config.version)}`);
    }
    return config;
  }

  async loadState(): Promise<SyncState> {
    const state = await readJson<SyncState>(this.statePath, EMPTY_STATE);
    if (state.version !== 1 || typeof state.files !== "object") {
      throw new Error(`Invalid synchronization state in ${this.statePath}`);
    }
    return state;
  }

  async saveState(state: SyncState): Promise<void> {
    await writeJsonAtomically(this.statePath, state);
  }

  async listConflicts(): Promise<SyncConflict[]> {
    return readJson<SyncConflict[]>(this.conflictsPath, []);
  }

  async getConflict(id: string): Promise<SyncConflict | undefined> {
    return (await this.listConflicts()).find((conflict) => conflict.id === id);
  }

  async recordConflict(
    conflict: Omit<SyncConflict, "id" | "createdAt">,
    snapshots: { baseline?: Uint8Array; local?: Uint8Array; remote?: Uint8Array },
  ): Promise<SyncConflict> {
    const conflicts = await this.listConflicts();
    const existing = conflicts.find((item) => item.path === conflict.path);
    if (existing !== undefined) {
      const snapshotDirectory = path.join(this.conflictsDirectory, existing.id);
      await fs.mkdir(snapshotDirectory, { recursive: true });
      await this.writeOptionalFile(path.join(snapshotDirectory, "baseline"), snapshots.baseline);
      await this.writeOptionalFile(path.join(snapshotDirectory, "local"), snapshots.local);
      await this.writeOptionalFile(path.join(snapshotDirectory, "remote"), snapshots.remote);
      existing.reason = conflict.reason;
      existing.localExists = conflict.localExists;
      existing.remoteExists = conflict.remoteExists;
      existing.baselineHash = conflict.baselineHash;
      await writeJsonAtomically(this.conflictsPath, conflicts);
      return existing;
    }
    const record: SyncConflict = { ...conflict, id: randomUUID(), createdAt: new Date().toISOString() };
    const snapshotDirectory = path.join(this.conflictsDirectory, record.id);
    await fs.mkdir(snapshotDirectory, { recursive: true });
    await this.writeOptionalFile(path.join(snapshotDirectory, "baseline"), snapshots.baseline);
    await this.writeOptionalFile(path.join(snapshotDirectory, "local"), snapshots.local);
    await this.writeOptionalFile(path.join(snapshotDirectory, "remote"), snapshots.remote);
    conflicts.push(record);
    await writeJsonAtomically(this.conflictsPath, conflicts);
    return record;
  }

  async clearConflict(id: string): Promise<void> {
    const conflicts = await this.listConflicts();
    await writeJsonAtomically(this.conflictsPath, conflicts.filter((conflict) => conflict.id !== id));
    await fs.rm(path.join(this.conflictsDirectory, id), { recursive: true, force: true });
  }

  async readConflictSnapshot(id: string, name: "baseline" | "local" | "remote"): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(path.join(this.conflictsDirectory, id, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async readBaseline(relativePath: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.readFile(toLocalPath(this.baselineDirectory, relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async writeBaseline(relativePath: string, content: Uint8Array | undefined): Promise<void> {
    const baselinePath = toLocalPath(this.baselineDirectory, relativePath);
    if (content === undefined) {
      await fs.rm(baselinePath, { force: true });
      return;
    }
    await this.writeFileAtomically(baselinePath, content);
  }

  async updateBaseline(
    state: SyncState,
    relativePath: string,
    baseline: FileBaseline | undefined,
    content: Uint8Array | undefined,
  ): Promise<void> {
    if (baseline === undefined || content === undefined) {
      delete state.files[relativePath];
      await this.writeBaseline(relativePath, undefined);
      return;
    }
    state.files[relativePath] = baseline;
    await this.writeBaseline(relativePath, content);
  }

  async writeFileAtomically(filePath: string, content: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporaryPath, content, { mode: 0o666 });
    await fs.rename(temporaryPath, filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async writeOptionalFile(filePath: string, content: Uint8Array | undefined): Promise<void> {
    if (content !== undefined) {
      await fs.writeFile(filePath, content, { mode: 0o600 });
    } else {
      await fs.rm(filePath, { force: true });
    }
  }
}
