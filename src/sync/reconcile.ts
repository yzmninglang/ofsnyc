import type { ReconcileDecision } from "../types.js";

export interface ReconcileInput {
  localHash?: string;
  remoteHash?: string;
  baselineHash?: string;
  propagateDeletes: boolean;
}

export function reconcileFile(input: ReconcileInput): ReconcileDecision {
  const { baselineHash, localHash, remoteHash, propagateDeletes } = input;

  if (localHash === remoteHash) {
    return { action: "noop", reason: "both sides match" };
  }
  if (baselineHash === undefined) {
    if (localHash === undefined) {
      return { action: "download", reason: "new remote file" };
    }
    if (remoteHash === undefined) {
      return { action: "upload", reason: "new local file" };
    }
    return { action: "conflict", reason: "different file without a baseline" };
  }

  const localChanged = localHash !== baselineHash;
  const remoteChanged = remoteHash !== baselineHash;

  if (!localChanged && !remoteChanged) {
    return { action: "noop", reason: "both sides still match their baseline" };
  }
  if (localChanged && remoteChanged) {
    return { action: "conflict", reason: "changed on both sides since the baseline" };
  }
  if (localChanged) {
    if (localHash === undefined && !propagateDeletes) {
      return { action: "ignore", reason: "local deletion is not configured to propagate" };
    }
    return { action: "upload", reason: "only local changed" };
  }
  if (remoteHash === undefined && !propagateDeletes) {
    return { action: "ignore", reason: "remote deletion is not configured to propagate" };
  }
  return { action: "download", reason: "only remote changed" };
}
