import type { FastifyReply } from "fastify";
import { SyncTexNotFoundError } from "../remote/sharelatex-client.js";

/** Maps SyncTeX failures onto the HTTP status codes shared by every API surface. */
export function sendSyncTexError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof SyncTexNotFoundError) {
    return reply.code(422).send({ error: "No SyncTeX mapping found", code: "SYNCTEX_NOT_FOUND" });
  }
  const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 500;
  return reply.code(status).send({ error: error instanceof Error ? error.message : String(error), code: "SYNCTEX_REMOTE_ERROR" });
}
