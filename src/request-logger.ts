import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface RequestLogEntry {
  at: string;
  scope: "remote" | "local";
  method: string;
  url: string;
  status?: number;
  durationMs: number;
  error?: string;
}

export class RequestLogger {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private filePath?: string) {}

  get enabled(): boolean {
    return this.filePath !== undefined;
  }

  enable(filePath: string): void {
    this.filePath = filePath;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  record(entry: RequestLogEntry): void {
    if (!this.filePath) {
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(path.dirname(this.filePath!), { recursive: true });
        await appendFile(this.filePath!, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => undefined);
  }
}

export function sanitizeRequestUrl(input: URL): string {
  const url = new URL(input.toString());
  for (const key of ["_csrf", "token", "password", "cookie"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }
  return url.toString();
}
