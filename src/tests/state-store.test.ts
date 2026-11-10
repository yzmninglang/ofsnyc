import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../state-store.js";
import type { SyncConfig } from "../types.js";

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    version: 1,
    serverUrl: "http://sharelatex.test",
    projectId: "project-1",
    projectName: "Test project",
    cookieEnv: "OFSYNC_COOKIE",
    remotePollIntervalMs: 1_000,
    localDebounceMs: 50,
    propagateDeletes: false,
    ...overrides,
  };
}

test("refuses to silently rebind an initialized local directory", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-state-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.initialize(config());

  await assert.rejects(
    () => store.initialize(config({ projectId: "project-2", projectName: "Other project" })),
    /already initialized/,
  );
  assert.equal((await store.loadConfig()).projectId, "project-1");
});

test("allows an idempotent initialization for the same remote project", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-state-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);

  await store.initialize(config());
  await store.initialize(config());

  assert.equal((await store.loadConfig()).projectName, "Test project");
});
