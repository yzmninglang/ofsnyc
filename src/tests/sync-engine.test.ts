import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ShareLatexRemoteClient } from "../remote/client.js";
import type { CompileResult, RemoteChanges } from "../remote/sharelatex-client.js";
import { StateStore } from "../state-store.js";
import { SyncEngine } from "../sync/sync-engine.js";
import type { ProjectTree, RemoteFile, SyncConfig } from "../types.js";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

class MemoryRemote implements ShareLatexRemoteClient {
  readonly files = new Map<string, Uint8Array>();
  private readonly ids = new Map<string, string>();

  constructor(initial: Record<string, string>) {
    for (const [filePath, content] of Object.entries(initial)) {
      this.files.set(filePath, bytes(content));
      this.ids.set(filePath, randomUUID());
    }
  }

  async getProjectTree(_projectId: string): Promise<ProjectTree> {
    const files = new Map<string, RemoteFile>();
    for (const filePath of this.files.keys()) {
      files.set(filePath, {
        path: filePath,
        id: this.ids.get(filePath)!,
        kind: "doc",
        parentFolderId: "root",
      });
    }
    return { id: "project-1", name: "Test project", files, folders: new Map([["", { id: "root", path: "" }]]) };
  }

  async readFile(_projectId: string, remoteFile: RemoteFile): Promise<Uint8Array> {
    const content = this.files.get(remoteFile.path);
    if (!content) {
      throw new Error(`No remote file ${remoteFile.path}`);
    }
    return new Uint8Array(content);
  }

  async uploadFile(_projectId: string, tree: ProjectTree, remotePath: string, content: Uint8Array): Promise<RemoteFile> {
    const id = this.ids.get(remotePath) ?? randomUUID();
    this.ids.set(remotePath, id);
    this.files.set(remotePath, new Uint8Array(content));
    const file: RemoteFile = { path: remotePath, id, kind: "doc", parentFolderId: "root" };
    tree.files.set(remotePath, file);
    return file;
  }

  async deleteFile(_projectId: string, remoteFile: RemoteFile): Promise<void> {
    this.files.delete(remoteFile.path);
    this.ids.delete(remoteFile.path);
  }

  async getRemoteChanges(_projectId: string, _fromVersion: number): Promise<RemoteChanges | undefined> {
    return undefined;
  }

  async compile(_projectId: string): Promise<CompileResult> {
    return { outputFiles: [], raw: { status: "success" } };
  }

  async syncCode(): Promise<unknown> {
    return {};
  }

  async syncPdf(): Promise<unknown> {
    return {};
  }
}

async function setup(initial: Record<string, string>): Promise<{
  directory: string;
  remote: MemoryRemote;
  store: StateStore;
  engine: SyncEngine;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-test-"));
  const config: SyncConfig = {
    version: 1,
    serverUrl: "http://sharelatex.test",
    projectId: "project-1",
    projectName: "Test project",
    cookieEnv: "OFSYNC_COOKIE",
    remotePollIntervalMs: 1_000,
    localDebounceMs: 50,
    propagateDeletes: false,
  };
  const store = new StateStore(directory);
  await store.initialize(config);
  const remote = new MemoryRemote(initial);
  return { directory, remote, store, engine: new SyncEngine(config, store, remote) };
}

async function cleanup(directory: string): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true });
}

test("first synchronization downloads remote files and writes a baseline", async (context) => {
  const fixture = await setup({ "main.tex": "remote-v1" });
  context.after(() => cleanup(fixture.directory));

  const summary = await fixture.engine.syncAll();

  assert.deepEqual(summary.downloaded, ["main.tex"]);
  assert.equal(await fs.readFile(path.join(fixture.directory, "main.tex"), "utf8"), "remote-v1");
  assert.equal((await fixture.store.loadState()).files["main.tex"].kind, "doc");
});

test("skips Git data, ignored paths, and LaTeX build products", async (context) => {
  const fixture = await setup({
    "main.tex": "remote-main",
    ".git/config": "remote-git-data",
    "ai-output/remote.md": "remote-ai-output",
    "private-notes/remote.md": "remote-private-note",
    "remote-build.aux": "remote-build-output",
  });
  context.after(() => cleanup(fixture.directory));
  await fs.writeFile(path.join(fixture.directory, ".gitignore"), "ai-output/\n");
  await fs.writeFile(path.join(fixture.directory, ".ofsyncignore"), "private-notes/\n");
  await fs.mkdir(path.join(fixture.directory, ".git"), { recursive: true });
  await fs.mkdir(path.join(fixture.directory, "ai-output"), { recursive: true });
  await fs.mkdir(path.join(fixture.directory, "private-notes"), { recursive: true });
  await fs.writeFile(path.join(fixture.directory, ".git", "config"), "local-git-data");
  await fs.writeFile(path.join(fixture.directory, "ai-output", "local.md"), "local-ai-output");
  await fs.writeFile(path.join(fixture.directory, "private-notes", "local.md"), "local-private-note");
  await fs.writeFile(path.join(fixture.directory, "local-build.aux"), "local-build-output");

  const summary = await fixture.engine.syncAll();
  const state = await fixture.store.loadState();

  assert.deepEqual(summary.downloaded, ["main.tex"]);
  assert.equal(await fs.readFile(path.join(fixture.directory, "main.tex"), "utf8"), "remote-main");
  assert.equal(fixture.remote.files.has("local-build.aux"), false);
  assert.equal(fixture.remote.files.has("ai-output/local.md"), false);
  assert.equal(fixture.remote.files.has("private-notes/local.md"), false);
  assert.equal(state.files[".git/config"], undefined);
  assert.equal(state.files["remote-build.aux"], undefined);
  assert.equal(state.files["ai-output/remote.md"], undefined);
  assert.equal(state.files["private-notes/remote.md"], undefined);
});

test("a local-only edit uploads without downloading the remote file", async (context) => {
  const fixture = await setup({ "main.tex": "base" });
  context.after(() => cleanup(fixture.directory));
  await fixture.engine.syncAll();
  await fs.writeFile(path.join(fixture.directory, "main.tex"), "local-change");

  const summary = await fixture.engine.syncPaths(["main.tex"]);

  assert.deepEqual(summary.uploaded, ["main.tex"]);
  assert.equal(text(fixture.remote.files.get("main.tex")!), "local-change");
});

test("a remote-only edit downloads without overwriting a local baseline", async (context) => {
  const fixture = await setup({ "main.tex": "base" });
  context.after(() => cleanup(fixture.directory));
  await fixture.engine.syncAll();
  fixture.remote.files.set("main.tex", bytes("remote-change"));

  const summary = await fixture.engine.syncAll();

  assert.deepEqual(summary.downloaded, ["main.tex"]);
  assert.equal(await fs.readFile(path.join(fixture.directory, "main.tex"), "utf8"), "remote-change");
});

test("a double edit creates snapshots instead of overwriting either side", async (context) => {
  const fixture = await setup({ "main.tex": "base" });
  context.after(() => cleanup(fixture.directory));
  await fixture.engine.syncAll();
  await fs.writeFile(path.join(fixture.directory, "main.tex"), "local-change");
  fixture.remote.files.set("main.tex", bytes("remote-change"));

  const summary = await fixture.engine.syncAll();
  const [conflict] = await fixture.store.listConflicts();

  assert.deepEqual(summary.conflicted, ["main.tex"]);
  assert.equal(await fs.readFile(path.join(fixture.directory, "main.tex"), "utf8"), "local-change");
  assert.equal(text(fixture.remote.files.get("main.tex")!), "remote-change");
  assert.equal(text((await fixture.store.readConflictSnapshot(conflict.id, "baseline"))!), "base");
  assert.equal(text((await fixture.store.readConflictSnapshot(conflict.id, "local"))!), "local-change");
  assert.equal(text((await fixture.store.readConflictSnapshot(conflict.id, "remote"))!), "remote-change");
});

test("a repeated conflict refreshes the remote snapshot for safe later resolution", async (context) => {
  const fixture = await setup({ "main.tex": "base" });
  context.after(() => cleanup(fixture.directory));
  await fixture.engine.syncAll();
  await fs.writeFile(path.join(fixture.directory, "main.tex"), "local-change");
  fixture.remote.files.set("main.tex", bytes("remote-change-1"));
  await fixture.engine.syncAll();
  fixture.remote.files.set("main.tex", bytes("remote-change-2"));

  await fixture.engine.syncAll();
  const [conflict] = await fixture.store.listConflicts();

  assert.equal(text((await fixture.store.readConflictSnapshot(conflict.id, "remote"))!), "remote-change-2");
});

test("conflict resolution refuses to overwrite a newer local edit", async (context) => {
  const fixture = await setup({ "main.tex": "base" });
  context.after(() => cleanup(fixture.directory));
  await fixture.engine.syncAll();
  await fs.writeFile(path.join(fixture.directory, "main.tex"), "local-change-1");
  fixture.remote.files.set("main.tex", bytes("remote-change"));
  await fixture.engine.syncAll();
  const [conflict] = await fixture.store.listConflicts();
  await fs.writeFile(path.join(fixture.directory, "main.tex"), "local-change-2");

  await assert.rejects(() => fixture.engine.resolveConflict(conflict.id, "remote"), /changed again after this conflict/);
  assert.equal(await fs.readFile(path.join(fixture.directory, "main.tex"), "utf8"), "local-change-2");
});
