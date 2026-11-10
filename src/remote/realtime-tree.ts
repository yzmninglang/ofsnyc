import type { RemoteFile, RemoteFolder, ProjectTree, FileKind } from "../types.js";

const JOIN_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 3_000;

export type RealtimeRequester = (url: URL, init?: RequestInit) => Promise<Response>;

function framedPackets(body: string): string[] {
  if (!body) {
    return [];
  }
  if (body.startsWith("\ufffd")) {
    const packets: string[] = [];
    const parts = body.split("\ufffd");
    for (let index = 1; index + 1 < parts.length; index += 2) {
      packets.push(parts[index + 1]);
    }
    return packets;
  }
  return [body];
}

function packetTypeAndData(packet: string): { kind: string; data: string } {
  const firstSeparator = packet.indexOf(":");
  if (firstSeparator === -1) {
    return { kind: packet, data: "" };
  }
  let dataStart = firstSeparator + 1;
  for (let separator = 0; separator < 2; separator += 1) {
    const nextSeparator = packet.indexOf(":", dataStart);
    if (nextSeparator === -1) {
      return { kind: packet.slice(0, firstSeparator), data: "" };
    }
    dataStart = nextSeparator + 1;
  }
  return { kind: packet.slice(0, firstSeparator), data: packet.slice(dataStart) };
}

function asFileKind(value: unknown): FileKind {
  return value === "file" || value === "fileRef" ? "file" : "doc";
}

function flattenFolder(
  folder: any,
  prefix: string,
  parentFolderId: string | undefined,
  files: Map<string, RemoteFile>,
  folders: Map<string, RemoteFolder>,
): void {
  const folderId = String(folder?._id ?? folder?.id ?? "");
  const folderName = typeof folder?.name === "string" ? folder.name : "";
  const folderPath = folderName ? `${prefix}${folderName}/` : prefix;
  if (folderId) {
    folders.set(folderPath, { id: folderId, path: folderPath, parentFolderId });
  }
  for (const document of Array.isArray(folder?.docs) ? folder.docs : []) {
    if (document?._id && typeof document.name === "string") {
      files.set(`${folderPath}${document.name}`, {
        path: `${folderPath}${document.name}`,
        id: String(document._id),
        kind: "doc",
        parentFolderId: folderId,
      });
    }
  }
  for (const file of Array.isArray(folder?.fileRefs) ? folder.fileRefs : []) {
    if (file?._id && typeof file.name === "string") {
      files.set(`${folderPath}${file.name}`, {
        path: `${folderPath}${file.name}`,
        id: String(file._id),
        kind: asFileKind(file._type ?? "file"),
        parentFolderId: folderId,
      });
    }
  }
  for (const child of Array.isArray(folder?.folders) ? folder.folders : []) {
    flattenFolder(child, folderPath, folderId || parentFolderId, files, folders);
  }
}

function flattenRootFolder(
  root: any,
  files: Map<string, RemoteFile>,
  folders: Map<string, RemoteFolder>,
): void {
  const rootId = String(root?._id ?? root?.id ?? "");
  if (!rootId) {
    throw new Error("ShareLaTeX project tree did not contain a root folder identifier.");
  }
  folders.set("", { id: rootId, path: "" });
  for (const document of Array.isArray(root?.docs) ? root.docs : []) {
    if (document?._id && typeof document.name === "string") {
      files.set(document.name, { path: document.name, id: String(document._id), kind: "doc", parentFolderId: rootId });
    }
  }
  for (const file of Array.isArray(root?.fileRefs) ? root.fileRefs : []) {
    if (file?._id && typeof file.name === "string") {
      files.set(file.name, {
        path: file.name,
        id: String(file._id),
        kind: asFileKind(file._type ?? "file"),
        parentFolderId: rootId,
      });
    }
  }
  for (const child of Array.isArray(root?.folders) ? root.folders : []) {
    flattenFolder(child, "", rootId, files, folders);
  }
}

export function projectFromRealtimeResponse(project: any): ProjectTree {
  const files = new Map<string, RemoteFile>();
  const folders = new Map<string, RemoteFolder>();
  const root = Array.isArray(project?.rootFolder) ? project.rootFolder[0] : project?.rootFolder;
  if (root) {
    flattenRootFolder(root, files, folders);
  }
  return {
    id: String(project?._id ?? project?.id ?? ""),
    name: String(project?.name ?? ""),
    files,
    folders,
  };
}

export async function joinProjectRealtime(
  baseUrl: string,
  projectId: string,
  request: RealtimeRequester,
): Promise<ProjectTree> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOIN_TIMEOUT_MS);
  let pollUrl: URL | undefined;
  try {
    const handshakeUrl = new URL("/socket.io/1/", `${baseUrl}/`);
    handshakeUrl.searchParams.set("t", String(Date.now()));
    handshakeUrl.searchParams.set("projectId", projectId);
    const handshake = await request(handshakeUrl, { signal: controller.signal });
    if (!handshake.ok) {
      throw new Error(`Socket.IO handshake failed with HTTP ${handshake.status}`);
    }
    const [sid, , , transports] = (await handshake.text()).split(":", 4);
    if (!sid || !transports?.split(",").includes("xhr-polling")) {
      throw new Error(`ShareLaTeX did not offer xhr-polling (${transports ?? "unknown"})`);
    }
    pollUrl = new URL(`/socket.io/1/xhr-polling/${sid}`, `${baseUrl}/`);
    const deadline = Date.now() + JOIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      pollUrl.searchParams.set("t", String(Date.now()));
      const response = await request(pollUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Socket.IO poll failed with HTTP ${response.status}`);
      }
      for (const packet of framedPackets(await response.text())) {
        const { kind, data } = packetTypeAndData(packet);
        if (kind === "2") {
          await request(pollUrl, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "2::", signal: controller.signal });
        } else if (kind === "5") {
          const event = JSON.parse(data) as { name?: string; args?: any[] };
          if (event.name === "joinProjectResponse" && event.args?.[0]?.project) {
            return projectFromRealtimeResponse(event.args[0].project);
          }
          if (event.name === "connectionRejected") {
            throw new Error(`ShareLaTeX rejected the project connection: ${JSON.stringify(event.args?.[0] ?? {})}`);
          }
        } else if (kind === "7") {
          throw new Error(`ShareLaTeX realtime error: ${data || packet}`);
        } else if (kind === "0") {
          throw new Error("ShareLaTeX realtime service closed the connection.");
        }
      }
    }
    throw new Error("Timed out waiting for ShareLaTeX project details");
  } finally {
    clearTimeout(timeout);
    if (pollUrl) {
      const disconnectUrl = new URL(pollUrl);
      disconnectUrl.searchParams.set("t", String(Date.now()));
      disconnectUrl.searchParams.set("disconnect", "1");
      const disconnectController = new AbortController();
      const disconnectTimeout = setTimeout(() => disconnectController.abort(), DISCONNECT_TIMEOUT_MS);
      try {
        await request(disconnectUrl, { signal: disconnectController.signal });
      } catch {
        // Disconnect is best effort and must not hide the original join error.
      } finally {
        clearTimeout(disconnectTimeout);
      }
    }
  }
}
