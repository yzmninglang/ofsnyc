import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProjectMapping {
  id: string;
  serverUrl: string;
  projectId: string;
  projectName: string;
  directory: string;
  paused: boolean;
  createdAt: string;
}

interface RegistryFile {
  version: 1;
  mappings: ProjectMapping[];
}

export function defaultRegistryPath(): string {
  const base = process.env.OFSYNC_HOME ?? path.join(os.homedir(), ".ofsync");
  return path.join(base, "manager.json");
}

export function newMappingId(): string {
  return randomUUID();
}

function isProjectMapping(value: unknown): value is ProjectMapping {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const mapping = value as Record<string, unknown>;
  return (
    typeof mapping.id === "string"
    && typeof mapping.serverUrl === "string"
    && typeof mapping.projectId === "string"
    && typeof mapping.projectName === "string"
    && typeof mapping.directory === "string"
    && typeof mapping.paused === "boolean"
    && typeof mapping.createdAt === "string"
  );
}

/**
 * Persistent list of project-directory bindings managed by `ofsync ui`.
 * Credentials are deliberately never stored here.
 */
export class ManagerRegistry {
  constructor(readonly filePath: string = defaultRegistryPath()) {}

  async load(): Promise<ProjectMapping[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : [];
      if (!mappings.every(isProjectMapping)) {
        throw new Error(`The manager registry at ${this.filePath} contains an unsupported entry.`);
      }
      return mappings.map((mapping) => ({ ...mapping, paused: mapping.paused === true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async save(mappings: ProjectMapping[]): Promise<void> {
    const payload: RegistryFile = { version: 1, mappings };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
