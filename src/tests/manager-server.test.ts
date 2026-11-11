import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startManagerServer } from "../api/manager-server.js";
import { CredentialStore } from "../manager/credentials.js";
import { ProjectManager } from "../manager/project-manager.js";
import { ManagerRegistry, type ProjectMapping } from "../manager/registry.js";
import { RequestLogger } from "../request-logger.js";

interface Setup {
  baseUrl: string;
  directory: string;
}

async function setup(context: TestContext): Promise<Setup> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-manager-api-"));
  const directory = path.join(root, "project");
  await fs.mkdir(directory, { recursive: true });
  const registry = new ManagerRegistry(path.join(root, "manager.json"));
  const mapping: ProjectMapping = {
    id: "mapping-1",
    serverUrl: "http://sharelatex.test",
    projectId: "project-1",
    projectName: "Paused project",
    directory,
    paused: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await registry.save([mapping]);
  const manager = new ProjectManager(registry, new CredentialStore(), new RequestLogger());
  await manager.initialize();
  const server = await startManagerServer({ manager, port: 0 });
  const address = server.server.address() as AddressInfo;
  context.after(async () => {
    await server.close();
    await manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, directory };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("serves per-project status and conflicts, and 404s unknown mappings", async (context) => {
  const { baseUrl } = await setup(context);

  const statusResponse = await fetch(`${baseUrl}/api/projects/mapping-1/status`);
  assert.equal(statusResponse.status, 200);
  const status = await json<{
    mapping: { id: string; paused: boolean; running: boolean; phase: string };
    engine?: unknown;
  }>(statusResponse);
  assert.equal(status.mapping.id, "mapping-1");
  assert.equal(status.mapping.paused, true);
  assert.equal(status.mapping.running, false);
  assert.equal(status.mapping.phase, "paused");
  assert.equal(status.engine, undefined);

  const conflictsResponse = await fetch(`${baseUrl}/api/projects/mapping-1/conflicts`);
  assert.equal(conflictsResponse.status, 200);
  assert.deepEqual(await json<unknown[]>(conflictsResponse), []);

  const missingResponse = await fetch(`${baseUrl}/api/projects/unknown/status`);
  assert.equal(missingResponse.status, 404);
  assert.match((await json<{ error: string }>(missingResponse)).error, /Unknown project mapping/);
});

test("reads and writes project files inside the project directory", async (context) => {
  const { baseUrl } = await setup(context);

  const content = "\\section{Intro}\n";
  const writeResponse = await fetch(`${baseUrl}/api/projects/mapping-1/file?path=sections/intro.tex`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: content,
  });
  assert.equal(writeResponse.status, 200);
  assert.deepEqual(await json<unknown>(writeResponse), {
    ok: true,
    path: "sections/intro.tex",
    bytes: Buffer.byteLength(content),
  });

  const readResponse = await fetch(`${baseUrl}/api/projects/mapping-1/file?path=sections/intro.tex`);
  assert.equal(readResponse.status, 200);
  assert.match(readResponse.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await readResponse.text(), content);

  const missingResponse = await fetch(`${baseUrl}/api/projects/mapping-1/file?path=sections/missing.tex`);
  assert.equal(missingResponse.status, 404);
});

test("rejects paths that escape the project or touch its control directory", async (context) => {
  const { baseUrl } = await setup(context);

  for (const unsafe of ["../secret.tex", "..\\..\\secret.tex", ".ofsync/config.json", "C:/Windows/win.ini"]) {
    const response = await fetch(
      `${baseUrl}/api/projects/mapping-1/file?path=${encodeURIComponent(unsafe)}`,
      { method: "PUT", headers: { "content-type": "text/plain" }, body: "not allowed" },
    );
    assert.equal(response.status, 400, `expected 400 for ${unsafe}`);
  }
});

test("rejects remote operations for paused mappings with 409", async (context) => {
  const { baseUrl } = await setup(context);

  for (const route of ["sync", "compile"]) {
    const response = await fetch(`${baseUrl}/api/projects/mapping-1/${route}`, { method: "POST" });
    assert.equal(response.status, 409, `expected 409 for ${route}`);
  }

  const resolveResponse = await fetch(`${baseUrl}/api/projects/mapping-1/conflicts/conflict-1/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice: "local" }),
  });
  assert.equal(resolveResponse.status, 409);

  const invalidPathsResponse = await fetch(`${baseUrl}/api/projects/mapping-1/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: "main.tex" }),
  });
  assert.equal(invalidPathsResponse.status, 400);
});

test("serves the cached PDF only when one exists", async (context) => {
  const { baseUrl, directory } = await setup(context);

  assert.equal((await fetch(`${baseUrl}/api/projects/mapping-1/pdf`)).status, 404);

  const outputDirectory = path.join(directory, ".ofsync", "output");
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, "output.pdf"), Buffer.from("%PDF-1.7\n"));

  const response = await fetch(`${baseUrl}/api/projects/mapping-1/pdf`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "%PDF-1.7\n");
});
