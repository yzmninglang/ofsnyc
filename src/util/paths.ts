import path from "node:path";

export const CONTROL_DIRECTORY = ".ofsync";

export function toRemotePath(localPath: string): string {
  return localPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function toLocalPath(projectPath: string, remotePath: string): string {
  const normalized = toRemotePath(remotePath);
  if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe remote path: ${remotePath}`);
  }
  const candidate = path.resolve(projectPath, ...normalized.split("/"));
  const root = path.resolve(projectPath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Remote path escaped project directory: ${remotePath}`);
  }
  return candidate;
}

export function isControlPath(relativePath: string): boolean {
  const normalized = toRemotePath(relativePath);
  return normalized === CONTROL_DIRECTORY || normalized.startsWith(`${CONTROL_DIRECTORY}/`);
}
