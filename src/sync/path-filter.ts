import { promises as fs } from "node:fs";
import ignore, { type Ignore } from "ignore";
import type { SyncConfig } from "../types.js";
import { isControlPath, toRemotePath } from "../util/paths.js";

const BUILT_IN_PATTERNS = [
  ".git/",
  ".DS_Store",
  "Thumbs.db",
  "*.aux",
  "*.bcf",
  "*.blg",
  "*.fdb_latexmk",
  "*.fls",
  "*.idx",
  "*.ilg",
  "*.ind",
  "*.lof",
  "*.log",
  "*.lot",
  "*.nav",
  "*.out",
  "*.run.xml",
  "*.snm",
  "*.synctex",
  "*.synctex.gz",
  "*.toc",
  "*.vrb",
  "*.xdv",
];

async function readPatterns(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export interface SyncPathFilter {
  ignores(relativePath: string): boolean;
}

export function isAlwaysIgnoredPath(relativePath: string): boolean {
  const normalized = toRemotePath(relativePath).replace(/^\/+/, "");
  return !normalized || isControlPath(normalized) || normalized === ".git" || normalized.startsWith(".git/");
}

export class ProjectPathFilter implements SyncPathFilter {
  private constructor(private readonly rules: Ignore) {}

  static async load(projectDirectory: string, config: SyncConfig): Promise<ProjectPathFilter> {
    const rules = ignore();
    rules.add(BUILT_IN_PATTERNS);
    if (config.respectGitignore !== false) {
      rules.add(await readPatterns(`${projectDirectory}/.gitignore`));
    }
    rules.add(await readPatterns(`${projectDirectory}/.ofsyncignore`));
    rules.add(config.ignorePatterns ?? []);
    return new ProjectPathFilter(rules);
  }

  ignores(relativePath: string): boolean {
    const normalized = toRemotePath(relativePath).replace(/^\/+/, "");
    if (isAlwaysIgnoredPath(normalized)) {
      return true;
    }
    if (normalized === ".gitignore" || normalized === ".ofsyncignore") {
      return false;
    }
    return this.rules.ignores(normalized);
  }
}
