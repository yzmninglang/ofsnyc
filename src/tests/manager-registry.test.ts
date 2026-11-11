import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultRegistryPath, ManagerRegistry, type ProjectMapping } from "../manager/registry.js";

function mapping(overrides: Partial<ProjectMapping> = {}): ProjectMapping {
  return {
    id: "mapping-1",
    serverUrl: "http://sharelatex.test",
    projectId: "project-1",
    projectName: "Test project",
    directory: path.join(os.tmpdir(), "ofsync-project"),
    paused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("returns no mappings when the registry file does not exist", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-registry-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const registry = new ManagerRegistry(path.join(directory, "manager.json"));

  assert.deepEqual(await registry.load(), []);
});

test("persists mappings without credentials", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-registry-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "manager.json");
  const registry = new ManagerRegistry(registryPath);

  await registry.save([mapping(), mapping({ id: "mapping-2", paused: true })]);

  assert.deepEqual(await registry.load(), [mapping(), mapping({ id: "mapping-2", paused: true })]);
  const raw = await fs.readFile(registryPath, "utf8");
  assert.doesNotMatch(raw, /password|cookie|token/i);
});

test("rejects a registry entry with unexpected fields", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-registry-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const registryPath = path.join(directory, "manager.json");
  await fs.writeFile(registryPath, JSON.stringify({ version: 1, mappings: [{ id: "broken" }] }));
  const registry = new ManagerRegistry(registryPath);

  await assert.rejects(() => registry.load(), /unsupported entry/);
});

test("keeps the registry under OFSYNC_HOME when set", () => {
  const previous = process.env.OFSYNC_HOME;
  process.env.OFSYNC_HOME = path.join(os.tmpdir(), "ofsync-home");
  try {
    assert.equal(defaultRegistryPath(), path.join(os.tmpdir(), "ofsync-home", "manager.json"));
  } finally {
    if (previous === undefined) {
      delete process.env.OFSYNC_HOME;
    } else {
      process.env.OFSYNC_HOME = previous;
    }
  }
});
