import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { RequestLogger } from "../request-logger.js";
import type { ProjectManager } from "../manager/project-manager.js";
import { managerHtml } from "./manager-dashboard.js";
import { registerProjectRoutes } from "./manager-project-routes.js";

export interface ManagerServerOptions {
  manager: ProjectManager;
  port: number;
  requestLogger?: RequestLogger;
}

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  path?: string;
  parent?: string;
  directories: BrowseEntry[];
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function rootDirectories(): Promise<BrowseEntry[]> {
  if (process.platform === "win32") {
    const drives: BrowseEntry[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      if (await isDirectory(root)) {
        drives.push({ name: root, path: root });
      }
    }
    return drives;
  }
  const home = os.homedir();
  return [
    { name: "/", path: "/" },
    ...(home !== "/" ? [{ name: home, path: home }] : []),
  ];
}

async function browse(target: string | undefined): Promise<BrowseResult> {
  const trimmed = target?.trim();
  if (!trimmed) {
    return { directories: await rootDirectories() };
  }
  const resolved = path.resolve(trimmed);
  if (!(await isDirectory(resolved))) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? undefined : parent,
    directories,
  };
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export async function startManagerServer(options: ManagerServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const requestStartedAt = new WeakMap<object, number>();

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, Date.now());
    const origin = request.headers.origin;
    // Credentials are submitted to this API; reject requests made by other
    // websites so a random page cannot drive the local daemon.
    if (origin && !isLoopbackOrigin(origin)) {
      return reply.code(403).send({ error: "Cross-origin requests are not allowed." });
    }
    return undefined;
  });

  app.addHook("onResponse", async (request, reply) => {
    options.requestLogger?.record({
      at: new Date().toISOString(),
      scope: "local",
      method: request.method,
      url: request.url.split("?", 1)[0],
      status: reply.statusCode,
      durationMs: Date.now() - (requestStartedAt.get(request) ?? Date.now()),
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: number }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 400;
    return reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 400).send({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return managerHtml();
  });

  registerProjectRoutes(app, options.manager);

  app.get("/api/manage/health", async () => ({ ok: true }));

  app.post<{ Body: { serverUrl?: string; email?: string; password?: string; cookie?: string } }>(
    "/api/manage/connect",
    async (request) => {
      const body = request.body ?? {};
      if (!body.serverUrl?.trim()) {
        throw new Error("Server URL is required.");
      }
      return options.manager.connect(body.serverUrl, {
        email: body.email?.trim() || undefined,
        password: body.password || undefined,
        cookie: body.cookie?.trim() || undefined,
      });
    },
  );

  app.get("/api/manage/servers", async () => ({ servers: options.manager.connectedServers() }));

  app.get("/api/manage/mappings", async () => ({ mappings: await options.manager.listMappings() }));

  app.post<{ Body: { serverUrl?: string; projectId?: string; projectName?: string; directory?: string } }>(
    "/api/manage/mappings",
    async (request) => {
      const body = request.body ?? {};
      if (!body.serverUrl || !body.projectId || !body.projectName || !body.directory) {
        throw new Error("serverUrl, projectId, projectName and directory are required.");
      }
      return options.manager.createMapping({
        serverUrl: body.serverUrl,
        projectId: body.projectId,
        projectName: body.projectName,
        directory: body.directory,
      });
    },
  );

  app.post<{ Params: { id: string } }>("/api/manage/mappings/:id/pause", async (request) => {
    return options.manager.pauseMapping(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/manage/mappings/:id/resume", async (request) => {
    return options.manager.resumeMapping(request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/manage/mappings/:id", async (request, reply) => {
    await options.manager.removeMapping(request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/manage/mappings/:id/sync", async (request) => {
    return options.manager.syncMapping(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/manage/mappings/:id/compile", async (request) => {
    return options.manager.compileMapping(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/manage/mappings/:id/conflicts", async (request) => {
    return options.manager.conflictsFor(request.params.id);
  });

  app.get<{ Querystring: { path?: string } }>("/api/manage/browse", async (request) => {
    return browse(request.query.path);
  });

  app.post<{ Body: { path?: string; name?: string } }>("/api/manage/browse/mkdir", async (request) => {
    const base = request.body?.path?.trim();
    const name = request.body?.name?.trim();
    if (!base || !name) {
      throw new Error("path and name are required.");
    }
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      throw new Error("Folder name must not contain path separators.");
    }
    const target = path.join(path.resolve(base), name);
    await fs.mkdir(target);
    return { path: target };
  });

  await app.listen({ port: options.port, host: "127.0.0.1" });
  return app;
}
