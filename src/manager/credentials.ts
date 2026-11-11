import type { ShareLatexCredentials } from "../remote/sharelatex-client.js";
import { normalizeServerUrl } from "../remote/sharelatex-client.js";

/**
 * Holds login credentials for the lifetime of the `ofsync ui` process only.
 * Nothing in this class is written to disk; restarting the manager requires
 * logging in again.
 */
export class CredentialStore {
  private readonly sessions = new Map<string, ShareLatexCredentials>();

  set(serverUrl: string, credentials: ShareLatexCredentials): void {
    this.sessions.set(normalizeServerUrl(serverUrl), { ...credentials });
  }

  get(serverUrl: string): ShareLatexCredentials | undefined {
    const credentials = this.sessions.get(normalizeServerUrl(serverUrl));
    return credentials ? { ...credentials } : undefined;
  }

  has(serverUrl: string): boolean {
    return this.sessions.has(normalizeServerUrl(serverUrl));
  }

  servers(): string[] {
    return [...this.sessions.keys()];
  }

  clear(): void {
    this.sessions.clear();
  }
}
