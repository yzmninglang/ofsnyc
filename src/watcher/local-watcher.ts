import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { isAlwaysIgnoredPath } from "../sync/path-filter.js";
import { toRemotePath } from "../util/paths.js";

export interface LocalWatcherOptions {
  projectDirectory: string;
  debounceMs: number;
  onPathsChanged: (paths: string[]) => Promise<void> | void;
  ignores?: (relativePath: string) => Promise<boolean>;
  onError?: (error: Error) => void;
}

export class LocalWatcher {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private changedPaths = new Set<string>();

  constructor(private readonly options: LocalWatcherOptions) {}

  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }
    this.watcher = watch(this.options.projectDirectory, {
      ignoreInitial: true,
      ignored: (filePath) => this.isIgnored(filePath),
      awaitWriteFinish: {
        stabilityThreshold: Math.max(100, this.options.debounceMs),
        pollInterval: 50,
      },
    });
    this.watcher.on("add", (filePath) => this.record(filePath));
    this.watcher.on("change", (filePath) => this.record(filePath));
    this.watcher.on("unlink", (filePath) => this.record(filePath));
    this.watcher.on("error", (error) => this.options.onError?.(error instanceof Error ? error : new Error(String(error))));
    await new Promise<void>((resolve, reject) => {
      this.watcher?.once("ready", resolve);
      this.watcher?.once("error", reject);
    });
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.watcher?.close();
    this.watcher = undefined;
    this.changedPaths.clear();
  }

  private record(filePath: string): void {
    void this.recordAsync(filePath).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async recordAsync(filePath: string): Promise<void> {
    const relativePath = toRemotePath(path.relative(this.options.projectDirectory, filePath));
    if (isAlwaysIgnoredPath(relativePath) || await this.options.ignores?.(relativePath)) {
      return;
    }
    this.changedPaths.add(relativePath);
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const paths = [...this.changedPaths];
      this.changedPaths.clear();
      Promise.resolve(this.options.onPathsChanged(paths)).catch((error: unknown) => {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }, this.options.debounceMs);
  }

  private isIgnored(filePath: string): boolean {
    const relativePath = toRemotePath(path.relative(this.options.projectDirectory, filePath));
    // chokidar evaluates `ignored` for the watched root as well. The empty
    // relative path must not be treated as a control path, or chokidar skips
    // the whole project directory and no events are ever emitted.
    if (!relativePath) {
      return false;
    }
    return isAlwaysIgnoredPath(relativePath);
  }
}
