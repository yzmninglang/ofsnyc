import { promises as fs } from "node:fs";
import path from "node:path";
import { RequestLogger } from "../request-logger.js";
import { normalizeServerUrl, ShareLatexClient, type ShareLatexCredentials } from "../remote/sharelatex-client.js";
import { StateStore } from "../state-store.js";
import { CompileScheduler } from "../sync/compile-scheduler.js";
import { ProjectPathFilter } from "../sync/path-filter.js";
import { SyncEngine } from "../sync/sync-engine.js";
import type { SyncConfig } from "../types.js";
import { LocalWatcher } from "../watcher/local-watcher.js";
import { RemoteMonitor } from "../watcher/remote-monitor.js";
import { CredentialStore } from "./credentials.js";
import { ManagerRegistry, newMappingId, type ProjectMapping } from "./registry.js";

export type ManagedPhase = "idle" | "syncing" | "watching" | "error" | "paused" | "awaiting-auth";

export interface ManagedProjectStatus {
  id: string;
  serverUrl: string;
  projectId: string;
  projectName: string;
  directory: string;
  paused: boolean;
  running: boolean;
  phase: ManagedPhase;
  conflicts: number;
  lastSyncAt?: string;
  lastError?: string;
}

export interface CreateMappingInput {
  serverUrl: string;
  projectId: string;
  projectName: string;
  directory: string;
}

export interface ConnectResult {
  serverUrl: string;
  projects: Array<{ id: string; name: string; archived: boolean; trashed: boolean }>;
}

interface ManagedRuntime {
  mapping: ProjectMapping;
  store: StateStore;
  client: ShareLatexClient;
  engine: SyncEngine;
  watcher: LocalWatcher;
  monitor: RemoteMonitor;
  compiler: CompileScheduler;
  disposed: boolean;
}

export interface ProjectManagerOptions {
  requestLogging?: boolean;
  onError?: (message: string) => void;
}

const DEFAULT_REMOTE_POLL_MS = 3_000;
const DEFAULT_LOCAL_DEBOUNCE_MS = 750;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class ProjectManager {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly runtimeErrors = new Map<string, string>();
  private mappings: ProjectMapping[] = [];

  constructor(
    private readonly registry: ManagerRegistry,
    private readonly credentials: CredentialStore,
    private readonly requestLogger: RequestLogger,
    private readonly options: ProjectManagerOptions = {},
  ) {}

  /** Loads persisted mappings and resumes the ones that are not paused. */
  async initialize(): Promise<void> {
    this.mappings = await this.registry.load();
    for (const mapping of this.mappings) {
      if (mapping.paused || this.runtimes.has(mapping.id)) {
        continue;
      }
      try {
        await this.startMapping(mapping);
      } catch (error) {
        this.runtimeErrors.set(mapping.id, this.errorMessage(error));
      }
    }
  }

  async connect(serverUrl: string, credentials: ShareLatexCredentials): Promise<ConnectResult> {
    const normalized = normalizeServerUrl(serverUrl);
    if (!credentials.cookie && !(credentials.email && credentials.password)) {
      throw new Error("Enter an email and password, or paste a browser cookie.");
    }
    const client = new ShareLatexClient(normalized, {}, this.requestLogger);
    await client.authenticate(credentials);
    const projects = await client.listProjects();
    this.credentials.set(normalized, credentials);
    // A login can unblock mappings that could not auto-start at process launch.
    await this.resumeServer(normalized);
    return {
      serverUrl: normalized,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        archived: project.archived === true,
        trashed: project.trashed === true,
      })),
    };
  }

  connectedServers(): string[] {
    return this.credentials.servers();
  }

  async listMappings(): Promise<ManagedProjectStatus[]> {
    return Promise.all(this.mappings.map((mapping) => this.statusFor(mapping)));
  }

  async createMapping(input: CreateMappingInput): Promise<ManagedProjectStatus> {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const projectId = input.projectId.trim();
    const projectName = input.projectName.trim();
    if (!projectId || !projectName) {
      throw new Error("Choose a project before adding a mapping.");
    }
    if (!input.directory.trim()) {
      throw new Error("Choose a local folder for this project.");
    }
    const directory = path.resolve(input.directory.trim());
    if (this.mappings.some((mapping) => mapping.serverUrl === serverUrl && mapping.projectId === projectId)) {
      throw new Error(`Project ${projectName} is already mapped to ${this.mappingDirectory(serverUrl, projectId)}.`);
    }
    if (!this.credentials.has(serverUrl)) {
      throw new Error("Connect to the server again before adding this mapping.");
    }

    await fs.mkdir(directory, { recursive: true });
    const stats = await fs.stat(directory);
    if (!stats.isDirectory()) {
      throw new Error(`${directory} is not a directory.`);
    }

    const mapping: ProjectMapping = {
      id: newMappingId(),
      serverUrl,
      projectId,
      projectName,
      directory,
      paused: false,
      createdAt: new Date().toISOString(),
    };
    const runtime = await this.buildRuntime(mapping);
    this.runtimes.set(mapping.id, runtime);
    this.runtimeErrors.delete(mapping.id);
    this.mappings.push(mapping);
    try {
      await this.registry.save(this.mappings);
    } catch (error) {
      this.mappings = this.mappings.filter((item) => item.id !== mapping.id);
      await this.stopRuntime(runtime);
      throw error;
    }
    this.launch(runtime);
    return this.statusFor(mapping);
  }

  async pauseMapping(id: string): Promise<ManagedProjectStatus> {
    const mapping = this.requireMapping(id);
    await this.stopRuntimeById(id);
    mapping.paused = true;
    this.runtimeErrors.delete(id);
    await this.registry.save(this.mappings);
    return this.statusFor(mapping);
  }

  async resumeMapping(id: string): Promise<ManagedProjectStatus> {
    const mapping = this.requireMapping(id);
    if (!this.runtimes.has(id)) {
      await this.startMapping(mapping);
    }
    mapping.paused = false;
    this.runtimeErrors.delete(id);
    await this.registry.save(this.mappings);
    return this.statusFor(mapping);
  }

  async removeMapping(id: string): Promise<void> {
    const mapping = this.requireMapping(id);
    await this.stopRuntimeById(id);
    this.mappings = this.mappings.filter((item) => item.id !== id);
    this.runtimeErrors.delete(id);
    await this.registry.save(this.mappings);
  }

  async syncMapping(id: string): Promise<unknown> {
    return this.requireRuntime(id).engine.syncAll();
  }

  async compileMapping(id: string): Promise<unknown> {
    return this.requireRuntime(id).engine.compile();
  }

  async conflictsFor(id: string): Promise<unknown> {
    const mapping = this.requireMapping(id);
    const runtime = this.runtimes.get(id);
    return runtime ? runtime.store.listConflicts() : new StateStore(mapping.directory).listConflicts();
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      await this.stopRuntimeById(id);
    }
  }

  private async resumeServer(serverUrl: string): Promise<void> {
    for (const mapping of this.mappings) {
      if (mapping.serverUrl !== serverUrl || mapping.paused || this.runtimes.has(mapping.id)) {
        continue;
      }
      try {
        await this.startMapping(mapping);
      } catch (error) {
        this.runtimeErrors.set(mapping.id, this.errorMessage(error));
      }
    }
  }

  private async startMapping(mapping: ProjectMapping): Promise<void> {
    const runtime = await this.buildRuntime(mapping);
    this.runtimes.set(mapping.id, runtime);
    this.runtimeErrors.delete(mapping.id);
    this.launch(runtime);
  }

  private async buildRuntime(mapping: ProjectMapping): Promise<ManagedRuntime> {
    const credentials = this.credentials.get(mapping.serverUrl);
    if (!credentials) {
      throw new Error(`Log in to ${mapping.serverUrl} before syncing ${mapping.projectName}.`);
    }
    const store = new StateStore(mapping.directory);
    const config = await this.configFor(mapping, store);
    const client = new ShareLatexClient(config.serverUrl, {}, new RequestLogger(config.requestLogPath));
    await client.authenticate(credentials);
    const engine = new SyncEngine(config, store, client);
    const reportError = (error: Error) => this.options.onError?.(`[${mapping.projectName}] ${error.message}`);
    const compiler = new CompileScheduler(engine, 1_000, reportError);
    engine.on("summary", (summary) => compiler.observe(summary));
    const watcher = new LocalWatcher({
      projectDirectory: store.projectDirectory,
      debounceMs: config.localDebounceMs,
      onPathsChanged: async (paths) => {
        await engine.syncPaths(paths);
      },
      ignores: async (relativePath) => (await ProjectPathFilter.load(store.projectDirectory, config)).ignores(relativePath),
      onError: reportError,
    });
    const monitor = new RemoteMonitor(client, store, engine, {
      intervalMs: config.remotePollIntervalMs,
      onError: reportError,
    });
    return { mapping, store, client, engine, watcher, monitor, compiler, disposed: false };
  }

  private async configFor(mapping: ProjectMapping, store: StateStore): Promise<SyncConfig> {
    if (await pathExists(store.configPath)) {
      const existing = await store.loadConfig();
      if (existing.serverUrl !== mapping.serverUrl || existing.projectId !== mapping.projectId) {
        throw new Error(
          `${mapping.directory} is already bound to ${existing.serverUrl} project ${existing.projectId}. `
          + "Choose another folder or remove its .ofsync directory after backing it up.",
        );
      }
      if (this.options.requestLogging && !existing.requestLogPath) {
        existing.requestLogPath = store.requestLogPath;
      }
      return existing;
    }
    const config: SyncConfig = {
      version: 1,
      serverUrl: mapping.serverUrl,
      projectId: mapping.projectId,
      projectName: mapping.projectName,
      cookieEnv: "OFSYNC_COOKIE",
      emailEnv: "OFSYNC_EMAIL",
      passwordEnv: "OFSYNC_PASSWORD",
      remotePollIntervalMs: DEFAULT_REMOTE_POLL_MS,
      localDebounceMs: DEFAULT_LOCAL_DEBOUNCE_MS,
      propagateDeletes: false,
      respectGitignore: true,
    };
    if (this.options.requestLogging) {
      config.requestLogPath = store.requestLogPath;
    }
    await store.initialize(config);
    return config;
  }

  /**
   * Performs the initial synchronization in the background so the management UI
   * stays responsive while a large project is downloaded for the first time.
   */
  private launch(runtime: ManagedRuntime): void {
    runtime.engine.setWatching(true);
    void (async () => {
      try {
        await runtime.engine.syncAll();
        if (runtime.disposed || this.runtimes.get(runtime.mapping.id) !== runtime) {
          return;
        }
        await runtime.watcher.start();
        await runtime.monitor.start();
      } catch (error) {
        this.runtimeErrors.set(runtime.mapping.id, this.errorMessage(error));
        this.options.onError?.(`[${runtime.mapping.projectName}] ${this.errorMessage(error)}`);
        await this.stopRuntimeById(runtime.mapping.id);
      }
    })();
  }

  private requireMapping(id: string): ProjectMapping {
    const mapping = this.mappings.find((item) => item.id === id);
    if (!mapping) {
      throw new Error("Unknown project mapping.");
    }
    return mapping;
  }

  private requireRuntime(id: string): ManagedRuntime {
    this.requireMapping(id);
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throw new Error("This mapping is paused. Resume it before syncing.");
    }
    return runtime;
  }

  private async stopRuntimeById(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(id);
    await this.stopRuntime(runtime);
  }

  private async stopRuntime(runtime: ManagedRuntime): Promise<void> {
    runtime.disposed = true;
    runtime.compiler.stop();
    runtime.monitor.stop();
    runtime.engine.setWatching(false);
    await runtime.watcher.close();
  }

  private async statusFor(mapping: ProjectMapping): Promise<ManagedProjectStatus> {
    const runtime = this.runtimes.get(mapping.id);
    const base = {
      id: mapping.id,
      serverUrl: mapping.serverUrl,
      projectId: mapping.projectId,
      projectName: mapping.projectName,
      directory: mapping.directory,
      paused: mapping.paused,
      running: runtime !== undefined,
    };
    if (!runtime) {
      return {
        ...base,
        phase: mapping.paused ? "paused" : "awaiting-auth",
        conflicts: 0,
        lastError: this.runtimeErrors.get(mapping.id),
      };
    }
    const status = await runtime.engine.status();
    return {
      ...base,
      phase: status.phase,
      conflicts: status.conflicts.length,
      lastSyncAt: status.lastSyncAt,
      lastError: this.runtimeErrors.get(mapping.id) ?? status.lastError,
    };
  }

  private mappingDirectory(serverUrl: string, projectId: string): string {
    return this.mappings.find((mapping) => mapping.serverUrl === serverUrl && mapping.projectId === projectId)?.directory
      ?? "another folder";
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
