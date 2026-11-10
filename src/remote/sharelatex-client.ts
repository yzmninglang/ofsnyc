import { randomUUID } from "node:crypto";
import path from "node:path";
import { joinProjectRealtime } from "./realtime-tree.js";
import type { FileKind, ProjectTree, RemoteFile, RemoteFolder } from "../types.js";

export interface ShareLatexCredentials {
  cookie?: string;
  email?: string;
  password?: string;
}

export interface ShareLatexProject {
  id: string;
  name: string;
  archived?: boolean;
  trashed?: boolean;
}

export interface RemoteTreeChange {
  pathname: string;
  newPathname?: string;
  operation?: "edited" | "added" | "removed" | "renamed";
}

export interface RemoteChanges {
  version: number;
  paths: Set<string>;
}

export interface CompileResult {
  pdf?: Uint8Array;
  pdfPath?: string;
  outputFiles: Array<{ type: string; path: string; url: string }>;
  raw: unknown;
}

export class ShareLatexError extends Error {}

function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function extractCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function cookiePairs(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const value of cookieHeader.split(/;\s*/)) {
    const separator = value.indexOf("=");
    if (separator > 0) {
      cookies.set(value.slice(0, separator).trim(), value.slice(separator + 1).trim());
    }
  }
  return cookies;
}

function mergeCookieHeaders(current: string | undefined, setCookies: string[]): string | undefined {
  const cookies = cookiePairs(current ?? "");
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
  return cookies.size ? [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ") : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'");
}

function metaContent(html: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const nameMatch = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i);
    if (nameMatch?.[2] !== name) {
      continue;
    }
    const contentMatch = tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i);
    if (contentMatch) {
      return decodeHtmlAttribute(contentMatch[2]);
    }
  }
  const fallback = new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i").exec(html);
  return fallback?.[1] ? decodeHtmlAttribute(fallback[1]) : undefined;
}

function textFileExtension(filePath: string): boolean {
  return new Set([".tex", ".bib", ".cls", ".sty", ".bst", ".txt", ".md", ".csv", ".xml", ".json", ".yaml", ".yml"]).has(
    path.posix.extname(filePath).toLowerCase(),
  );
}

function normalizedRemotePath(remotePath: string): string {
  const result = remotePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!result || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ShareLatexError(`Unsafe remote path: ${remotePath}`);
  }
  return result;
}

export class ShareLatexClient {
  readonly serverUrl: string;
  private cookie?: string;
  private csrf?: string;

  constructor(serverUrl: string, credentials: ShareLatexCredentials = {}) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.cookie = credentials.cookie;
  }

  static fromEnvironment(serverUrl: string, cookieEnv = "OFSYNC_COOKIE"): ShareLatexClient {
    return new ShareLatexClient(serverUrl, { cookie: process.env[cookieEnv] });
  }

  get authenticated(): boolean {
    return this.cookie !== undefined && this.csrf !== undefined;
  }

  async authenticate(credentials: ShareLatexCredentials = {}): Promise<void> {
    if (credentials.cookie) {
      this.cookie = credentials.cookie;
    }
    if (this.cookie) {
      await this.fetchCsrf();
      return;
    }
    if (!credentials.email || !credentials.password) {
      throw new ShareLatexError("Authentication requires a browser cookie or an email/password supplied at runtime.");
    }
    await this.passwordLogin(credentials.email, credentials.password);
  }

  async listProjects(): Promise<ShareLatexProject[]> {
    const dashboard = await this.request("/project");
    this.assertAuthenticatedResponse(dashboard, "project dashboard");
    const html = await dashboard.text();
    const content = metaContent(html, "ol-prefetchedProjectsBlob") ?? metaContent(html, "ol-projects");
    if (content) {
      const projects = this.projectsFromPayload(JSON.parse(content));
      if (projects) {
        return projects;
      }
    }

    const apiProjects = await this.request("/api/project", {
      method: "POST",
      headers: this.csrfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ _csrf: this.requireCsrf() }),
    });
    if (apiProjects.ok) {
      const projects = this.projectsFromPayload(await apiProjects.json());
      if (projects) {
        return projects;
      }
    } else if (this.isAuthenticationFailure(apiProjects)) {
      this.assertAuthenticatedResponse(apiProjects, "project list");
    }

    const legacyProjects = await this.request("/user/projects");
    this.assertAuthenticatedResponse(legacyProjects, "legacy project list");
    const projects = this.projectsFromPayload(await legacyProjects.json());
    if (!projects) {
      throw new ShareLatexError("ShareLaTeX returned a project list with an unsupported format.");
    }
    return projects;
  }

  async findProjectByName(projectName: string): Promise<ShareLatexProject> {
    const matches = (await this.listProjects()).filter((project) => project.name === projectName);
    if (matches.length === 0) {
      throw new ShareLatexError(`No active ShareLaTeX project named ${JSON.stringify(projectName)} was found.`);
    }
    if (matches.length > 1) {
      throw new ShareLatexError(`More than one active ShareLaTeX project is named ${JSON.stringify(projectName)}.`);
    }
    return matches[0];
  }

  async getProjectTree(projectId: string): Promise<ProjectTree> {
    const tree = await joinProjectRealtime(this.serverUrl, projectId, (url, init) => this.requestUrl(url, init));
    if (!tree.id) {
      tree.id = projectId;
    }
    return tree;
  }

  async readFile(projectId: string, remoteFile: RemoteFile): Promise<Uint8Array> {
    const suffix = remoteFile.kind === "doc" ? "/download" : "";
    const response = await this.request(`/project/${encodeURIComponent(projectId)}/${remoteFile.kind}/${encodeURIComponent(remoteFile.id)}${suffix}`);
    if (!response.ok) {
      throw new ShareLatexError(`Could not download ${remoteFile.path}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async createFolder(projectId: string, parentFolderId: string, name: string): Promise<RemoteFolder> {
    const response = await this.request(`/project/${encodeURIComponent(projectId)}/folder`, {
      method: "POST",
      headers: this.csrfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ parent_folder_id: parentFolderId, name, _csrf: this.requireCsrf() }),
    });
    if (!response.ok && response.status !== 400) {
      throw new ShareLatexError(`Could not create remote folder ${name}: HTTP ${response.status}`);
    }
    if (response.status === 400) {
      throw new ShareLatexError(`Remote folder ${name} already exists but was not present in the cached project tree.`);
    }
    const body = (await response.json()) as { _id?: string; id?: string };
    const id = String(body._id ?? body.id ?? "");
    if (!id) {
      throw new ShareLatexError(`Remote folder creation returned no identifier for ${name}.`);
    }
    return { id, path: name, parentFolderId };
  }

  async uploadFile(projectId: string, tree: ProjectTree, remotePath: string, content: Uint8Array): Promise<RemoteFile> {
    const safePath = normalizedRemotePath(remotePath);
    const parentFolderId = await this.ensureParentFolder(projectId, tree, safePath);
    const filename = safePath.split("/").at(-1)!;
    const existing = tree.files.get(safePath);
    const url = new URL(`/project/${encodeURIComponent(projectId)}/upload`, `${this.serverUrl}/`);
    url.searchParams.set("folder_id", parentFolderId);
    url.searchParams.set("_csrf", this.requireCsrf());
    url.searchParams.set("qquuid", randomUUID());
    url.searchParams.set("qqfilename", filename);
    url.searchParams.set("qqtotalfilesize", String(content.byteLength));
    const form = new FormData();
    form.set("targetFolderId", parentFolderId);
    form.set("name", filename);
    form.set("type", textFileExtension(safePath) ? "text/plain" : "application/octet-stream");
    const blobContent = new Uint8Array(content.byteLength);
    blobContent.set(content);
    form.set("qqfile", new Blob([blobContent.buffer]), filename);
    const response = await this.requestUrl(url, { method: "POST", headers: this.csrfHeaders(), body: form });
    if (!response.ok) {
      throw new ShareLatexError(`Could not upload ${safePath}: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { success?: boolean; entity_id?: string; entity_type?: string; error?: string };
    if (!body.success) {
      throw new ShareLatexError(`ShareLaTeX rejected ${safePath}: ${body.error ?? "unknown error"}`);
    }
    const kind: FileKind = body.entity_type === "file" ? "file" : existing?.kind ?? (textFileExtension(safePath) ? "doc" : "file");
    const result: RemoteFile = {
      path: safePath,
      id: body.entity_id ?? existing?.id ?? "",
      kind,
      parentFolderId,
    };
    tree.files.set(safePath, result);
    return result;
  }

  async deleteFile(projectId: string, remoteFile: RemoteFile): Promise<void> {
    const response = await this.request(
      `/project/${encodeURIComponent(projectId)}/${remoteFile.kind}/${encodeURIComponent(remoteFile.id)}`,
      { method: "DELETE", headers: this.csrfHeaders() },
    );
    if (response.status !== 204) {
      throw new ShareLatexError(`Could not delete ${remoteFile.path}: HTTP ${response.status}`);
    }
  }

  async getRemoteChanges(projectId: string, fromVersion: number): Promise<RemoteChanges | undefined> {
    const nextVersion = await this.findCurrentProjectVersion(projectId, fromVersion);
    if (nextVersion === undefined) {
      return undefined;
    }
    if (nextVersion === fromVersion) {
      return { version: fromVersion, paths: new Set() };
    }
    const diff = await this.getFileTreeDiff(projectId, fromVersion, nextVersion);
    if (diff === undefined) {
      return undefined;
    }
    const paths = new Set<string>();
    for (const change of diff) {
      paths.add(change.pathname);
      if (change.newPathname) {
        paths.add(change.newPathname);
      }
    }
    return { version: nextVersion, paths };
  }

  async compile(projectId: string, rootResourcePath: string | null = null): Promise<CompileResult> {
    const response = await this.request(`/project/${encodeURIComponent(projectId)}/compile?auto_compile=true`, {
      method: "POST",
      headers: this.csrfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        _csrf: this.requireCsrf(),
        check: "silent",
        draft: false,
        incrementalCompilesEnabled: true,
        rootResourcePath,
        stopOnFirstError: false,
      }),
    });
    if (!response.ok) {
      throw new ShareLatexError(`Remote compile failed with HTTP ${response.status}`);
    }
    const raw = (await response.json()) as any;
    const outputFiles = Array.isArray(raw.outputFiles) ? raw.outputFiles : [];
    if (raw.status !== "success") {
      return { outputFiles, raw };
    }
    const pdf = outputFiles.find((file: { type?: string }) => file.type === "pdf") as { path: string; url: string } | undefined;
    if (!pdf) {
      return { outputFiles, raw };
    }
    const outputUrl = new URL(pdf.url, `${this.serverUrl}/`);
    if (raw.compileGroup) {
      outputUrl.searchParams.set("compileGroup", String(raw.compileGroup));
    }
    if (raw.clsiServerId) {
      outputUrl.searchParams.set("clsiserverid", String(raw.clsiServerId));
    }
    const download = await this.requestUrl(outputUrl, { headers: this.csrfHeaders() });
    if (!download.ok) {
      throw new ShareLatexError(`Could not download compiled PDF: HTTP ${download.status}`);
    }
    return { pdf: new Uint8Array(await download.arrayBuffer()), pdfPath: pdf.path, outputFiles, raw };
  }

  async syncCode(projectId: string, file: string, line: number, column: number, buildId: string): Promise<unknown> {
    const response = await this.request(
      `/project/${encodeURIComponent(projectId)}/sync/code?file=${encodeURIComponent(file)}&line=${line}&column=${column}&editorId=${randomUUID()}&buildId=${encodeURIComponent(buildId)}`,
    );
    if (!response.ok) {
      throw new ShareLatexError(`SyncTeX code lookup failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  async syncPdf(projectId: string, page: number, h: number, v: number, buildId: string): Promise<unknown> {
    const response = await this.request(
      `/project/${encodeURIComponent(projectId)}/sync/pdf?page=${page}&h=${h}&v=${v}&editorId=${randomUUID()}&buildId=${encodeURIComponent(buildId)}`,
    );
    if (!response.ok) {
      throw new ShareLatexError(`SyncTeX PDF lookup failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  private async fetchCsrf(): Promise<void> {
    const response = await this.request("/project");
    this.assertAuthenticatedResponse(response, "project dashboard");
    const csrf = metaContent(await response.text(), "ol-csrfToken");
    if (!csrf) {
      throw new ShareLatexError("Could not find a CSRF token in the ShareLaTeX project dashboard.");
    }
    this.csrf = csrf;
  }

  private async passwordLogin(email: string, password: string): Promise<void> {
    const loginPage = await this.request("/login");
    if (!loginPage.ok) {
      throw new ShareLatexError(`Could not load the ShareLaTeX login page: HTTP ${loginPage.status}`);
    }
    const html = await loginPage.text();
    const csrfMatch = /<input\b[^>]*\bname=["']_csrf["'][^>]*\bvalue=["']([^"']*)["']/i.exec(html)
      ?? /<input\b[^>]*\bvalue=["']([^"']*)["'][^>]*\bname=["']_csrf["']/i.exec(html);
    const csrf = csrfMatch?.[1];
    if (!csrf) {
      throw new ShareLatexError("Could not find a login CSRF token.");
    }
    const response = await this.request("/login", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "X-Csrf-Token": csrf },
      body: JSON.stringify({ _csrf: csrf, email, password }),
    });
    if (response.status !== 302 && response.status !== 303) {
      throw new ShareLatexError("ShareLaTeX rejected the supplied email or password.");
    }
    await this.fetchCsrf();
  }

  private async findCurrentProjectVersion(projectId: string, knownVersion: number): Promise<number | undefined> {
    const hasVersion = async (version: number): Promise<boolean | undefined> => (await this.getFileTreeDiff(projectId, version, version)) !== undefined;
    const next = await hasVersion(knownVersion + 1);
    if (next === undefined) {
      return undefined;
    }
    if (!next) {
      return knownVersion;
    }
    let lower = knownVersion + 1;
    let upper = Math.max(lower + 1, lower * 2);
    while (await hasVersion(upper)) {
      lower = upper;
      upper *= 2;
    }
    while (lower + 1 < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (await hasVersion(middle)) {
        lower = middle;
      } else {
        upper = middle;
      }
    }
    return lower;
  }

  private async getFileTreeDiff(projectId: string, from: number, to: number): Promise<RemoteTreeChange[] | undefined> {
    const response = await this.request(
      `/project/${encodeURIComponent(projectId)}/filetree/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`,
    );
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { diff?: RemoteTreeChange[] };
    return Array.isArray(body.diff) ? body.diff : [];
  }

  private async ensureParentFolder(projectId: string, tree: ProjectTree, remotePath: string): Promise<string> {
    const root = tree.folders.get("");
    if (!root) {
      throw new ShareLatexError("The ShareLaTeX project tree has no root folder.");
    }
    let parent = root;
    const parts = remotePath.split("/").slice(0, -1);
    let currentPath = "";
    for (const part of parts) {
      currentPath += `${part}/`;
      const existing = tree.folders.get(currentPath);
      if (existing) {
        parent = existing;
        continue;
      }
      const created = await this.createFolder(projectId, parent.id, part);
      const folder: RemoteFolder = { ...created, path: currentPath, parentFolderId: parent.id };
      tree.folders.set(currentPath, folder);
      parent = folder;
    }
    return parent.id;
  }

  private asProject(value: unknown): ShareLatexProject {
    const project = value as { id?: unknown; _id?: unknown; name?: unknown; archived?: unknown; trashed?: unknown };
    const id = String(project.id ?? project._id ?? "");
    const name = String(project.name ?? "");
    if (!id || !name) {
      throw new ShareLatexError("The ShareLaTeX dashboard returned an invalid project entry.");
    }
    return { id, name, archived: Boolean(project.archived), trashed: Boolean(project.trashed) };
  }

  private projectsFromPayload(payload: unknown): ShareLatexProject[] | undefined {
    const projects = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { projects?: unknown } | null)?.projects)
        ? (payload as { projects: unknown[] }).projects
        : undefined;
    return projects?.map((project) => this.asProject(project)).filter((project) => !project.archived && !project.trashed);
  }

  private requireCsrf(): string {
    if (!this.csrf) {
      throw new ShareLatexError("No CSRF token is available. Call authenticate first.");
    }
    return this.csrf;
  }

  private csrfHeaders(extra: HeadersInit = {}): Headers {
    const headers = new Headers(extra);
    headers.set("X-Csrf-Token", this.requireCsrf());
    return headers;
  }

  private async request(route: string, init: RequestInit = {}): Promise<Response> {
    return this.requestUrl(new URL(route.replace(/^\//, ""), `${this.serverUrl}/`), init);
  }

  private async requestUrl(url: URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) {
      headers.set("Cookie", this.cookie);
    }
    headers.set("Connection", "keep-alive");
    const response = await fetch(url, { ...init, headers, redirect: init.redirect ?? "manual" });
    this.cookie = mergeCookieHeaders(this.cookie, extractCookies(response));
    return response;
  }

  private assertAuthenticatedResponse(response: Response, action: string): void {
    if (this.isAuthenticationFailure(response)) {
      throw new ShareLatexError(`ShareLaTeX session is not valid while reading ${action}.`);
    }
    if (!response.ok) {
      throw new ShareLatexError(`Could not read ${action}: HTTP ${response.status}`);
    }
  }

  private isAuthenticationFailure(response: Response): boolean {
    const location = response.headers.get("location") ?? "";
    return response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400 && /\/login/.test(location));
  }
}
