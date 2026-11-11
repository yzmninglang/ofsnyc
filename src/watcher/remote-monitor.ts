import { StateStore } from "../state-store.js";
import { ShareLatexClient } from "../remote/sharelatex-client.js";
import { SyncEngine } from "../sync/sync-engine.js";

export const DEFAULT_FULL_SCAN_INTERVAL_MS = 30_000;

export interface RemoteMonitorOptions {
  intervalMs: number;
  /**
   * Minimum spacing between the expensive full scans used when the history API
   * is unavailable. Without this backoff every poll would re-download every
   * remote file for comparison.
   */
  fullScanIntervalMs?: number;
  onError?: (error: Error) => void;
}

export class RemoteMonitor {
  private timer?: NodeJS.Timeout;
  private active = false;
  private historyUnavailable = false;
  private lastFullScanAt?: number;

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
        if (await this.runFullScanIfDue()) {
          // Retry the history endpoint after a scan; a transient failure must
          // not pin the monitor to full scans for the life of the process.
          this.historyUnavailable = false;
        }
        return;
      }
      if (state.remoteVersion === undefined) {
        const detected = await this.client.getRemoteChanges(config.projectId, 0);
        if (detected) {
          state.remoteVersion = detected.version;
          await this.store.saveState(state);
        } else {
          this.historyUnavailable = true;
          if (await this.runFullScanIfDue()) {
            this.historyUnavailable = false;
          }
        }
        return;
      }
      const changes = await this.client.getRemoteChanges(config.projectId, state.remoteVersion);
      if (!changes) {
        this.historyUnavailable = true;
        if (await this.runFullScanIfDue()) {
          this.historyUnavailable = false;
        }
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
        await this.runFullScanIfDue();
      } catch (fallbackError) {
        this.options.onError?.(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
      }
    } finally {
      this.active = false;
    }
  }

  /** Runs a full scan unless the backoff window has not elapsed yet. */
  private async runFullScanIfDue(): Promise<boolean> {
    const interval = this.options.fullScanIntervalMs ?? DEFAULT_FULL_SCAN_INTERVAL_MS;
    const now = Date.now();
    if (this.lastFullScanAt !== undefined && now - this.lastFullScanAt < interval) {
      return false;
    }
    this.lastFullScanAt = now;
    await this.engine.syncAll();
    return true;
  }
}
