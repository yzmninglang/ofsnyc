#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { startLocalServer } from "./api/local-server.js";
import { startManagerServer } from "./api/manager-server.js";
import { CredentialStore } from "./manager/credentials.js";
import { ProjectManager } from "./manager/project-manager.js";
import { ManagerRegistry } from "./manager/registry.js";
import { RequestLogger } from "./request-logger.js";
import { ShareLatexClient } from "./remote/sharelatex-client.js";
import { loadRuntime } from "./runtime.js";
import { StateStore } from "./state-store.js";
import type { SyncConfig } from "./types.js";
import { CompileScheduler } from "./sync/compile-scheduler.js";
import { ProjectPathFilter } from "./sync/path-filter.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { LocalWatcher } from "./watcher/local-watcher.js";
import { RemoteMonitor } from "./watcher/remote-monitor.js";

interface ParsedArguments {
  command?: string;
  values: Map<string, string>;
  flags: Set<string>;
}

function usage(): string {
  return `Usage:
  ofsync projects --server URL [--cookie-env NAME] [--email-env NAME --password-env NAME]
  ofsync init --server URL --project-name NAME --path DIRECTORY [--cookie-env NAME] [--email-env NAME --password-env NAME]
  ofsync sync --path DIRECTORY [--request-log]
  ofsync watch --path DIRECTORY [--port 43821] [--request-log]
  ofsync ui [--port 43821] [--request-log]
  ofsync status --path DIRECTORY
  ofsync resolve --path DIRECTORY --id CONFLICT_ID --choice local|remote

Authentication is read only from environment variables. The default cookie variable is OFSYNC_COOKIE.`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command, ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      throw new Error(`Unexpected argument: ${item}`);
    }
    const [key, inlineValue] = item.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      values.set(key, inlineValue);
    } else if (rest[index + 1] && !rest[index + 1].startsWith("--")) {
      values.set(key, rest[index + 1]);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { command, values, flags };
}

function required(args: ParsedArguments, key: string): string {
  const value = args.values.get(key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function projectDirectory(args: ParsedArguments): string {
  return path.resolve(required(args, "path"));
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${option} must be a positive integer`);
  }
  return parsed;
}

async function initialize(args: ParsedArguments): Promise<void> {
  const serverUrl = required(args, "server");
  const projectName = required(args, "project-name");
  const directory = projectDirectory(args);
  const cookieEnv = args.values.get("cookie-env") ?? "OFSYNC_COOKIE";
  const emailEnv = args.values.get("email-env");
  const passwordEnv = args.values.get("password-env");
  const client = new ShareLatexClient(serverUrl);
  await client.authenticate({
    cookie: process.env[cookieEnv],
    email: emailEnv ? process.env[emailEnv] : undefined,
    password: passwordEnv ? process.env[passwordEnv] : undefined,
  });
  const project = await client.findProjectByName(projectName);
  const config: SyncConfig = {
    version: 1,
    serverUrl,
    projectId: project.id,
    projectName: project.name,
    cookieEnv,
    emailEnv,
    passwordEnv,
    remotePollIntervalMs: positiveInteger(args.values.get("remote-poll-ms") ?? "3000", "remote-poll-ms"),
    localDebounceMs: positiveInteger(args.values.get("local-debounce-ms") ?? "750", "local-debounce-ms"),
    propagateDeletes: args.flags.has("propagate-deletes"),
    respectGitignore: !args.flags.has("no-gitignore"),
  };
  const store = new StateStore(directory);
  await store.initialize(config);
  const engine = new SyncEngine(config, store, client);
  const summary = await engine.syncAll();
  console.log(JSON.stringify({ initialized: true, directory, project: { id: project.id, name: project.name }, cookieEnv, summary }, null, 2));
}

async function listProjects(args: ParsedArguments): Promise<void> {
  const serverUrl = required(args, "server");
  const cookieEnv = args.values.get("cookie-env") ?? "OFSYNC_COOKIE";
  const emailEnv = args.values.get("email-env");
  const passwordEnv = args.values.get("password-env");
  const client = new ShareLatexClient(serverUrl);
  await client.authenticate({
    cookie: process.env[cookieEnv],
    email: emailEnv ? process.env[emailEnv] : undefined,
    password: passwordEnv ? process.env[passwordEnv] : undefined,
  });
  console.log(JSON.stringify({ projects: await client.listProjects() }, null, 2));
}

async function synchronize(args: ParsedArguments): Promise<void> {
  const runtime = await loadRuntime(projectDirectory(args), args.flags.has("request-log"));
  const summary = await runtime.engine.syncAll();
  console.log(JSON.stringify(summary, null, 2));
}

async function showStatus(args: ParsedArguments): Promise<void> {
  const runtime = await loadRuntime(projectDirectory(args), args.flags.has("request-log"));
  console.log(JSON.stringify(await runtime.engine.status(), null, 2));
}

async function resolve(args: ParsedArguments): Promise<void> {
  const runtime = await loadRuntime(projectDirectory(args), args.flags.has("request-log"));
  const choice = required(args, "choice");
  if (choice !== "local" && choice !== "remote") {
    throw new Error("--choice must be either local or remote");
  }
  await runtime.engine.resolveConflict(required(args, "id"), choice);
  console.log(JSON.stringify({ resolved: true }, null, 2));
}

async function watchProject(args: ParsedArguments): Promise<void> {
  const runtime = await loadRuntime(projectDirectory(args), args.flags.has("request-log"));
  const port = positiveInteger(args.values.get("port") ?? "43821", "port");
  if (port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  const logError = (error: Error) => console.error(`[ofsync] ${error.message}`);
  const compiler = new CompileScheduler(runtime.engine, 1_000, logError);
  runtime.engine.on("summary", (summary) => compiler.observe(summary));
  const localWatcher = new LocalWatcher({
    projectDirectory: runtime.store.projectDirectory,
    debounceMs: runtime.config.localDebounceMs,
    onPathsChanged: async (paths) => {
      await runtime.engine.syncPaths(paths);
    },
    ignores: async (relativePath) => (await ProjectPathFilter.load(runtime.store.projectDirectory, runtime.config)).ignores(relativePath),
    onError: logError,
  });
  const remoteMonitor = new RemoteMonitor(runtime.client, runtime.store, runtime.engine, {
    intervalMs: runtime.config.remotePollIntervalMs,
    onError: logError,
  });
  const server = await startLocalServer({ engine: runtime.engine, store: runtime.store, port, requestLogger: runtime.requestLogger });
  runtime.engine.setWatching(true);
  await runtime.engine.syncAll();
  await localWatcher.start();
  await remoteMonitor.start();
  console.log(`ofsync is watching ${runtime.store.projectDirectory}`);
  console.log(`Local dashboard: http://127.0.0.1:${port}`);

  const shutdown = async () => {
    runtime.engine.setWatching(false);
    compiler.stop();
    remoteMonitor.stop();
    await localWatcher.close();
    await server.close();
  };
  await new Promise<void>((resolve) => {
    const stop = () => void shutdown().finally(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening the browser is best-effort; the URL is printed regardless.
  }
}

async function runManager(args: ParsedArguments): Promise<void> {
  const port = positiveInteger(args.values.get("port") ?? "43821", "port");
  if (port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  const requestLogging = args.flags.has("request-log");
  const logError = (error: Error) => console.error(`[ofsync] ${error.message}`);
  const registry = new ManagerRegistry();
  const managerLogPath = requestLogging ? path.join(path.dirname(registry.filePath), "manager-requests.log") : undefined;
  const manager = new ProjectManager(registry, new CredentialStore(), new RequestLogger(), {
    requestLogging,
    onError: (message) => logError(new Error(message)),
  });
  await manager.initialize();
  const server = await startManagerServer({
    manager,
    port,
    requestLogger: new RequestLogger(managerLogPath),
  });
  const url = `http://127.0.0.1:${port}`;
  console.log(`ofsync manager is running at ${url}`);
  console.log(`Project mappings: ${registry.filePath}`);
  openBrowser(url);

  const shutdown = async () => {
    await manager.stopAll();
    await server.close();
  };
  await new Promise<void>((resolve) => {
    const stop = () => void shutdown().finally(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case "projects":
      await listProjects(args);
      return;
    case "init":
      await initialize(args);
      return;
    case "sync":
      await synchronize(args);
      return;
    case "watch":
      await watchProject(args);
      return;
    case "ui":
      await runManager(args);
      return;
    case "status":
      await showStatus(args);
      return;
    case "resolve":
      await resolve(args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(usage());
      return;
    default:
      throw new Error(`Unknown command: ${args.command}\n\n${usage()}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
