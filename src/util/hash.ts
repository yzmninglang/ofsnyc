import { createHash } from "node:crypto";

export function hashContent(content: Uint8Array | undefined): string | undefined {
  if (content === undefined) {
    return undefined;
  }
  return createHash("sha256").update(content).digest("hex");
}
