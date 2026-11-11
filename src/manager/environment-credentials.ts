import type { ShareLatexCredentials } from "../remote/sharelatex-client.js";
import type { SyncConfig } from "../types.js";

export const DEFAULT_CREDENTIAL_ENV = {
  cookie: "OFSYNC_COOKIE",
  email: "OFSYNC_EMAIL",
  password: "OFSYNC_PASSWORD",
} as const;

/**
 * Turns a server URL into an environment-variable prefix so several servers
 * can keep separate credentials: http://192.168.1.16:8189 becomes
 * OFSYNC_192_168_1_16_8189.
 */
export function serverEnvironmentPrefix(serverUrl: string): string {
  let host = serverUrl;
  try {
    const url = new URL(serverUrl);
    host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    // Fall back to sanitizing the raw value; callers normally pass a
    // normalized URL, so this only guards against malformed registry entries.
  }
  const key = host.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `OFSYNC_${key}`;
}

export interface CredentialEnvCandidates {
  cookie: string[];
  email: string[];
  password: string[];
}

function unique(names: Array<string | undefined>): string[] {
  return [...new Set(names.filter((name): name is string => typeof name === "string" && name.length > 0))];
}

/**
 * Candidate variable names in precedence order: a server-specific name, then
 * the names recorded in the project config, then the shared defaults.
 */
export function credentialEnvCandidates(
  serverUrl: string,
  config?: Pick<SyncConfig, "cookieEnv" | "emailEnv" | "passwordEnv">,
): CredentialEnvCandidates {
  const prefix = serverEnvironmentPrefix(serverUrl);
  return {
    cookie: unique([`${prefix}_COOKIE`, config?.cookieEnv, DEFAULT_CREDENTIAL_ENV.cookie]),
    email: unique([`${prefix}_EMAIL`, config?.emailEnv, DEFAULT_CREDENTIAL_ENV.email]),
    password: unique([`${prefix}_PASSWORD`, config?.passwordEnv, DEFAULT_CREDENTIAL_ENV.password]),
  };
}

function firstValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Reads credentials for one server. Cookie auth wins because hosted Overleaf
 * blocks password logins behind reCAPTCHA; email and password are used
 * together only when both are present.
 */
export function credentialsFromEnvironmentForServer(
  serverUrl: string,
  config?: Pick<SyncConfig, "cookieEnv" | "emailEnv" | "passwordEnv">,
  env: NodeJS.ProcessEnv = process.env,
): ShareLatexCredentials | undefined {
  const names = credentialEnvCandidates(serverUrl, config);
  const cookie = firstValue(env, names.cookie);
  if (cookie) {
    return { cookie };
  }
  const email = firstValue(env, names.email);
  const password = firstValue(env, names.password);
  return email && password ? { email, password } : undefined;
}
