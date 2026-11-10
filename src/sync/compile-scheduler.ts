import { SyncEngine, type SyncSummary } from "./sync-engine.js";

export class CompileScheduler {
  private timer?: NodeJS.Timeout;
  private compiling = false;

  constructor(
    private readonly engine: SyncEngine,
    private readonly delayMs: number,
    private readonly onError: (error: Error) => void,
  ) {}

  observe(summary: SyncSummary): void {
    if (summary.uploaded.length === 0 && summary.downloaded.length === 0) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.compile(), this.delayMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async compile(): Promise<void> {
    this.timer = undefined;
    if (this.compiling) {
      return;
    }
    this.compiling = true;
    try {
      await this.engine.compile();
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.compiling = false;
    }
  }
}
