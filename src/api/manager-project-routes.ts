import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ManagerError, type ProjectManager } from "../manager/project-manager.js";
import { sendSyncTexError } from "./synctex-error.js";

/** Matches the largest single-file upload accepted by Overleaf and ShareLaTeX. */
const FILE_WRITE_LIMIT = 50 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".bib",
  ".bst",
  ".cfg",
  ".cls",
  ".csv",
  ".def",
  ".json",
  ".md",
  ".sty",
  ".tex",
  ".txt",
  ".yaml",
  ".yml",
]);

function contentTypeFor(relativePath: string): string {
  return TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  throw new ManagerError("Send the file contents as the raw request body.", 415);
}

function requiredPath(query: { path?: string }): string {
  const relativePath = query.path?.trim();
  if (!relativePath) {
    throw new ManagerError("A ?path= query parameter is required.", 400);
  }
  return relativePath;
}

/**
 * Per-project API. The `:pid` segment is the mapping id from manager.json, so
 * one process and one port can serve every mapped project without collisions.
 */
export function registerProjectRoutes(app: FastifyInstance, manager: ProjectManager): void {
  // File writes arrive as raw bytes (or plain text); JSON routes are unaffected.
  app.addContentTypeParser(
    ["application/octet-stream", "text/plain"],
    { parseAs: "buffer", bodyLimit: FILE_WRITE_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.get<{ Params: { pid: string } }>("/api/projects/:pid/status", async (request) => {
    return manager.projectStatus(request.params.pid);
  });

  app.get<{ Params: { pid: string } }>("/api/projects/:pid/conflicts", async (request) => {
    return manager.conflictsFor(request.params.pid);
  });

  app.post<{ Params: { pid: string; cid: string }; Body: { choice?: "local" | "remote" } }>(
    "/api/projects/:pid/conflicts/:cid/resolve",
    async (request, reply) => {
      const choice = request.body?.choice;
      if (choice !== "local" && choice !== "remote") {
        return reply.code(400).send({ error: "The conflict choice must be 'local' or 'remote'." });
      }
      await manager.resolveMappingConflict(request.params.pid, request.params.cid, choice);
      return { ok: true };
    },
  );

  app.post<{ Params: { pid: string }; Body: { paths?: unknown } }>(
    "/api/projects/:pid/sync",
    async (request, reply) => {
      let paths: string[] | undefined;
      const requestedPaths = request.body?.paths;
      if (requestedPaths !== undefined) {
        if (!Array.isArray(requestedPaths) || !requestedPaths.every((item) => typeof item === "string")) {
          return reply.code(400).send({ error: "paths must be an array of strings." });
        }
        paths = requestedPaths;
      }
      return manager.syncMapping(request.params.pid, paths);
    },
  );

  app.post<{ Params: { pid: string } }>("/api/projects/:pid/compile", async (request) => {
    return manager.compileMapping(request.params.pid);
  });

  app.get<{ Params: { pid: string } }>("/api/projects/:pid/pdf", async (request, reply) => {
    const pdf = await manager.readCompiledPdf(request.params.pid);
    if (pdf === undefined) {
      return reply.code(404).send({ error: "No compiled PDF is cached yet." });
    }
    reply.type("application/pdf");
    return reply.send(pdf);
  });

  app.get<{ Params: { pid: string }; Querystring: { path?: string } }>(
    "/api/projects/:pid/file",
    async (request, reply) => {
      const relativePath = requiredPath(request.query);
      const content = await manager.readProjectFile(request.params.pid, relativePath);
      if (content === undefined) {
        return reply.code(404).send({ error: `File not found: ${relativePath}` });
      }
      reply.type(contentTypeFor(relativePath));
      return reply.send(content);
    },
  );

  app.put<{ Params: { pid: string }; Querystring: { path?: string }; Body: unknown }>(
    "/api/projects/:pid/file",
    { bodyLimit: FILE_WRITE_LIMIT },
    async (request) => {
      const relativePath = requiredPath(request.query);
      const content = bodyBuffer(request.body);
      const written = await manager.writeProjectFile(request.params.pid, relativePath, content);
      return { ok: true, path: written.path, bytes: content.length };
    },
  );

  app.post<{ Params: { pid: string }; Body: { file?: string; line?: number; column?: number; buildId?: string } }>(
    "/api/projects/:pid/synctex/code",
    async (request, reply) => {
      const { file, line, column, buildId } = request.body ?? {};
      if (!file || line === undefined || column === undefined || !buildId) {
        return reply.code(400).send({ error: "file, line, column, and buildId are required." });
      }
      try {
        return await manager.syncCode(request.params.pid, file, line, column, buildId);
      } catch (error) {
        return sendSyncTexError(reply, error);
      }
    },
  );

  app.post<{ Params: { pid: string }; Body: { page?: number; h?: number; v?: number; buildId?: string } }>(
    "/api/projects/:pid/synctex/pdf",
    async (request, reply) => {
      const { page, h, v, buildId } = request.body ?? {};
      if (page === undefined || h === undefined || v === undefined || !buildId) {
        return reply.code(400).send({ error: "page, h, v, and buildId are required." });
      }
      try {
        return await manager.syncPdf(request.params.pid, page, h, v, buildId);
      } catch (error) {
        return sendSyncTexError(reply, error);
      }
    },
  );
}
