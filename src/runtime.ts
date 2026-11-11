import { ShareLatexClient, type ShareLatexCredentials } from "./remote/sharelatex-client.js";
import { StateStore } from "./state-store.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { RequestLogger } from "./request-logger.js";
import type { SyncConfig } from "./types.js";

export interface OfsyncRuntime {
  config: SyncConfig;
  store: StateStore;
  client: ShareLatexClient;
  engine: SyncEngine;
  requestLogger: RequestLogger;
}

export function credentialsFromEnvironment(config: SyncConfig): ShareLatexCredentials {
  return {
    cookie: process.env[config.cookieEnv],
    email: config.emailEnv ? process.env[config.emailEnv] : undefined,
    password: config.passwordEnv ? process.env[config.passwordEnv] : undefined,
  };
}

export async function loadRuntime(projectDirectory: string, enableRequestLogging = false): Promise<OfsyncRuntime> {
  const store = new StateStore(projectDirectory);
  const config = await store.loadConfig();
  const requestLogPath = config.requestLogPath ?? (enableRequestLogging ? store.requestLogPath : undefined);
  if (requestLogPath) {
    config.requestLogPath = requestLogPath;
  }
  const requestLogger = new RequestLogger(requestLogPath);
  const client = new ShareLatexClient(config.serverUrl, {}, requestLogger);
  await client.authenticate(credentialsFromEnvironment(config));
  return { config, store, client, engine: new SyncEngine(config, store, client), requestLogger };
}
