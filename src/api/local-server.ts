import { promises as fs } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { StateStore } from "../state-store.js";
import { SyncEngine } from "../sync/sync-engine.js";

export interface LocalServerOptions {
  engine: SyncEngine;
  store: StateStore;
  port: number;
}

export async function startLocalServer(options: LocalServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const { engine, store } = options;

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return dashboardHtml();
  });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/status", async () => engine.status());
  app.get("/api/conflicts", async () => store.listConflicts());
  app.post("/api/sync", async () => engine.syncAll());
  app.post("/api/compile", async () => engine.compile());
  app.post<{ Params: { id: string }; Body: { choice?: "local" | "remote" } }>("/api/conflicts/:id/resolve", async (request, reply) => {
    const choice = request.body?.choice;
    if (choice !== "local" && choice !== "remote") {
      return reply.code(400).send({ error: "The conflict choice must be 'local' or 'remote'." });
    }
    await engine.resolveConflict(request.params.id, choice);
    return { ok: true };
  });
  app.get("/api/pdf", async (_request, reply) => {
    const pdfPath = `${store.outputDirectory}/output.pdf`;
    try {
      const pdf = await fs.readFile(pdfPath);
      reply.type("application/pdf");
      return reply.send(pdf);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "No compiled PDF is cached yet." });
      }
      throw error;
    }
  });
  app.post<{ Body: { file?: string; line?: number; column?: number; buildId?: string } }>("/api/synctex/code", async (request, reply) => {
    const { file, line, column, buildId } = request.body ?? {};
    if (!file || line === undefined || column === undefined || !buildId) {
      return reply.code(400).send({ error: "file, line, column, and buildId are required." });
    }
    return engine.syncCode(file, line, column, buildId);
  });
  app.post<{ Body: { page?: number; h?: number; v?: number; buildId?: string } }>("/api/synctex/pdf", async (request, reply) => {
    const { page, h, v, buildId } = request.body ?? {};
    if (page === undefined || h === undefined || v === undefined || !buildId) {
      return reply.code(400).send({ error: "page, h, v, and buildId are required." });
    }
    return engine.syncPdf(page, h, v, buildId);
  });

  await app.listen({ port: options.port, host: "127.0.0.1" });
  return app;
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ofsync</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #111827; color: #e5e7eb; display: grid; grid-template-columns: minmax(280px, 32%) 1fr; height: 100vh; }
    aside { padding: 20px; overflow: auto; border-right: 1px solid #374151; }
    main { display: grid; grid-template-rows: auto 1fr; min-width: 0; }
    header { padding: 16px 20px; border-bottom: 1px solid #374151; display: flex; align-items: center; gap: 10px; }
    button { background: #2563eb; color: white; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    pre { background: #030712; border: 1px solid #374151; border-radius: 6px; padding: 12px; white-space: pre-wrap; word-break: break-word; }
    iframe { border: 0; width: 100%; height: 100%; background: white; }
    .muted { color: #9ca3af; font-size: .9rem; }
  </style>
</head>
<body>
  <aside>
    <h1>ofsync</h1>
    <p class="muted">Local ShareLaTeX synchronization daemon</p>
    <p><button id="sync">Sync now</button> <button id="compile">Compile</button></p>
    <h2>Status</h2><pre id="status">Loading…</pre>
    <h2>Conflicts</h2><pre id="conflicts">Loading…</pre>
  </aside>
  <main>
    <header><strong>Remote PDF preview</strong><span class="muted">Refreshes after a successful compile</span></header>
    <iframe id="pdf" src="/api/pdf" title="Compiled PDF"></iframe>
  </main>
  <script>
    const status = document.getElementById('status');
    const conflicts = document.getElementById('conflicts');
    const pdf = document.getElementById('pdf');
    async function refresh() {
      status.textContent = JSON.stringify(await fetch('/api/status').then(r => r.json()), null, 2);
      conflicts.textContent = JSON.stringify(await fetch('/api/conflicts').then(r => r.json()), null, 2);
    }
    document.getElementById('sync').onclick = async () => { await fetch('/api/sync', { method: 'POST' }); await refresh(); };
    document.getElementById('compile').onclick = async () => { await fetch('/api/compile', { method: 'POST' }); pdf.src = '/api/pdf?' + Date.now(); await refresh(); };
    refresh(); setInterval(refresh, 1500);
  </script>
</body>
</html>`;
}
