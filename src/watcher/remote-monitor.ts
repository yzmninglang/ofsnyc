import { StateStore } from "../state-store.js";
import { ShareLatexClient } from "../remote/sharelatex-client.js";
import { SyncEngine } from "../sync/sync-engine.js";

export interface RemoteMonitorOptions {
  intervalMs: number;
  onError?: (error: Error) => void;
}

export class RemoteMonitor {
  private timer?: NodeJS.Timeout;
  private active = false;
  private historyUnavailable = false;

  constructor(
    private readonly client: ShareLatexClient,
    private readonly store: StateStore,
    private readonly engine: SyncEngine,
    private readonly options: RemoteMonitorOptions,
  ) {}

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    try {
      const config = await this.store.loadConfig();
      const state = await this.store.loadState();
      if (this.historyUnavailable) {
        await this.engine.syncAll();
        return;
      }
      if (state.remoteVersion === undefined) {
        const detected = await this.client.getRemoteChanges(config.projectId, 0);
        if (detected) {
          state.remoteVersion = detected.version;
          await this.store.saveState(state);
        } else {
          this.historyUnavailable = true;
          await this.engine.syncAll();
        }
        return;
      }
      const changes = await this.client.getRemoteChanges(config.projectId, state.remoteVersion);
      if (!changes) {
        this.historyUnavailable = true;
        await this.engine.syncAll();
        return;
      }
      if (changes.version !== state.remoteVersion) {
        await this.engine.syncPaths(changes.paths);
        const refreshed = await this.store.loadState();
        refreshed.remoteVersion = changes.version;
        await this.store.saveState(refreshed);
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      try {
        await this.engine.syncAll();
      } catch (fallbackError) {
        this.options.onError?.(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
      }
    } finally {
      this.active = false;
    }
  }
}
