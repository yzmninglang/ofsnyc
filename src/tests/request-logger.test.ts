import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RequestLogger, sanitizeRequestUrl } from "../request-logger.js";

test("keeps request logging opt-in and serializes sanitized entries", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ofsync-request-log-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, ".ofsync", "requests.log");
  const logger = new RequestLogger();

  logger.record({ at: new Date().toISOString(), scope: "remote", method: "GET", url: "http://example.test", durationMs: 1 });
  assert.equal(logger.enabled, false);

  logger.enable(logPath);
  logger.record({
    at: new Date().toISOString(),
    scope: "remote",
    method: "POST",
    url: sanitizeRequestUrl(new URL("http://example.test/api?_csrf=secret&password=secret")),
    status: 500,
    durationMs: 3,
    error: "remote failure",
  });
  await logger.flush();

  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"status":500/);
  assert.match(lines[0], /%5BREDACTED%5D/);
  assert.doesNotMatch(lines[0], /secret/);
});
