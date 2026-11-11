import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RemoteChanges } from "../remote/sharelatex-client.js";
import { StateStore } from "../state-store.js";
import type { SyncConfig } from "../types.js";
import { RemoteMonitor } from "../watcher/remote-monitor.js";

class UnsupportedHistoryClient {
  calls = 0;

  async getRemoteChanges(_projectId: string, _fromVersion: number): Promise<RemoteChanges | undefined> {
    this.calls += 1;
    return undefined;
  }
}

class RecordingEngine {
  fullSyncs = 0;

  async syncAll(): Promise<void> {
    this.fullSyncs += 1;
  }

  async syncPaths(): Promise<void> {}
}

function config(): SyncConfig {
  return {
    version: 1,
    serverUrl: "http://sharelatex.test",
    projectId: "project-1",
    projectName: "Test project",
    cookieEnv: "OFSYNC_COOKIE",
    remotePollIntervalMs: 1_000,
    localDebounceMs: 50,
    propagateDeletes: false,
  };
}

test("falls back to full scans without repeatedly probing an unsupported history API", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-remote-monitor-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory);
  await store.initialize(config());
  const client = new UnsupportedHistoryClient();
  const engine = new RecordingEngine();
  const monitor = new RemoteMonitor(client as never, store, engine as never, {
    intervalMs: 60_000,
    fullScanIntervalMs: 60_000,
  });
  const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();

  await monitor.start();
  monitor.stop();
  // The probe after the first full scan fails again, but the backoff window
  // must suppress the next full scan instead of downloading every remote file.
  await tick();
  assert.equal(client.calls, 2);
  assert.equal(engine.fullSyncs, 1);

  // Once the history API is known to be unavailable, ticks inside the backoff
  // window do not even probe it.
  await tick();
  assert.equal(client.calls, 2);
  assert.equal(engine.fullSyncs, 1);
});

