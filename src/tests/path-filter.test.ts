import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectPathFilter } from "../sync/path-filter.js";
import type { SyncConfig } from "../types.js";

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

test("honors project ignore files and hard safety exclusions", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-filter-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, ".gitignore"), "ai-output/\n");
  await fs.writeFile(path.join(directory, ".ofsyncignore"), "private-notes/\n");

  const filter = await ProjectPathFilter.load(directory, config);

  assert.equal(filter.ignores(".git/config"), true);
  assert.equal(filter.ignores(".ofsync/state.json"), true);
  assert.equal(filter.ignores("draft.aux"), true);
  assert.equal(filter.ignores("draft.synctex.gz"), true);
  assert.equal(filter.ignores("ai-output/article.md"), true);
  assert.equal(filter.ignores("private-notes/ideas.md"), true);
  assert.equal(filter.ignores(".gitignore"), false);
  assert.equal(filter.ignores(".ofsyncignore"), false);
  assert.equal(filter.ignores("main.tex"), false);
});

test("can disable only .gitignore while retaining safety and .ofsyncignore", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-filter-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, ".gitignore"), "ai-output/\n");
  await fs.writeFile(path.join(directory, ".ofsyncignore"), "private-notes/\n");

  const filter = await ProjectPathFilter.load(directory, { ...config, respectGitignore: false });

  assert.equal(filter.ignores("ai-output/article.md"), false);
  assert.equal(filter.ignores("private-notes/ideas.md"), true);
  assert.equal(filter.ignores(".git/config"), true);
  assert.equal(filter.ignores("draft.log"), true);
});
