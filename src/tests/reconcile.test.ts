import assert from "node:assert/strict";
import test from "node:test";
import { reconcileFile } from "../sync/reconcile.js";

test("uploads a local-only change", () => {
  assert.equal(
    reconcileFile({ baselineHash: "a", localHash: "b", remoteHash: "a", propagateDeletes: false }).action,
    "upload",
  );
});

test("downloads a remote-only change", () => {
  assert.equal(
    reconcileFile({ baselineHash: "a", localHash: "a", remoteHash: "b", propagateDeletes: false }).action,
    "download",
  );
});

test("never overwrites a file changed on both sides", () => {
  assert.equal(
    reconcileFile({ baselineHash: "a", localHash: "b", remoteHash: "c", propagateDeletes: false }).action,
    "conflict",
  );
});

test("treats a first-sync mismatch as a conflict", () => {
  assert.equal(
    reconcileFile({ localHash: "a", remoteHash: "b", propagateDeletes: false }).action,
    "conflict",
  );
});

test("does not propagate deletions by default", () => {
  assert.equal(
    reconcileFile({ baselineHash: "a", remoteHash: "a", propagateDeletes: false }).action,
    "ignore",
  );
});
