import assert from "node:assert/strict";
import test from "node:test";
import {
  credentialEnvCandidates,
  credentialsFromEnvironmentForServer,
  serverEnvironmentPrefix,
} from "../manager/environment-credentials.js";

test("builds a server-specific prefix from host and port", () => {
  assert.equal(serverEnvironmentPrefix("http://192.168.1.16:8189"), "OFSYNC_192_168_1_16_8189");
  assert.equal(serverEnvironmentPrefix("https://www.overleaf.com"), "OFSYNC_WWW_OVERLEAF_COM");
  assert.equal(serverEnvironmentPrefix("http://sharelatex.test:8189/"), "OFSYNC_SHARELATEX_TEST_8189");
});

test("lists server-specific names before config names and shared defaults", () => {
  const names = credentialEnvCandidates("http://192.168.1.16:8189", {
    cookieEnv: "MY_COOKIE",
    emailEnv: "MY_EMAIL",
    passwordEnv: "MY_PASSWORD",
  });

  assert.deepEqual(names.cookie, ["OFSYNC_192_168_1_16_8189_COOKIE", "MY_COOKIE", "OFSYNC_COOKIE"]);
  assert.deepEqual(names.email, ["OFSYNC_192_168_1_16_8189_EMAIL", "MY_EMAIL", "OFSYNC_EMAIL"]);
  assert.deepEqual(names.password, ["OFSYNC_192_168_1_16_8189_PASSWORD", "MY_PASSWORD", "OFSYNC_PASSWORD"]);
});

test("prefers server-specific variables over shared defaults", () => {
  const credentials = credentialsFromEnvironmentForServer("http://192.168.1.16:8189", undefined, {
    OFSYNC_EMAIL: "shared@example.com",
    OFSYNC_PASSWORD: "shared-secret",
    OFSYNC_192_168_1_16_8189_EMAIL: "server@example.com",
    OFSYNC_192_168_1_16_8189_PASSWORD: "server-secret",
  });

  assert.deepEqual(credentials, { email: "server@example.com", password: "server-secret" });
});

test("falls back to the shared variables", () => {
  const credentials = credentialsFromEnvironmentForServer("http://sharelatex.test:8189", undefined, {
    OFSYNC_EMAIL: "shared@example.com",
    OFSYNC_PASSWORD: "shared-secret",
  });

  assert.deepEqual(credentials, { email: "shared@example.com", password: "shared-secret" });
});

test("uses the variable names recorded in the project config", () => {
  const credentials = credentialsFromEnvironmentForServer(
    "http://sharelatex.test",
    { cookieEnv: "MY_COOKIE", emailEnv: "MY_EMAIL", passwordEnv: "MY_PASSWORD" },
    { MY_EMAIL: "config@example.com", MY_PASSWORD: "config-secret" },
  );

  assert.deepEqual(credentials, { email: "config@example.com", password: "config-secret" });
});

test("prefers a cookie over email and password", () => {
  const credentials = credentialsFromEnvironmentForServer("https://www.overleaf.com", undefined, {
    OFSYNC_COOKIE: "overleaf_session2=abc",
    OFSYNC_EMAIL: "user@example.com",
    OFSYNC_PASSWORD: "secret",
  });

  assert.deepEqual(credentials, { cookie: "overleaf_session2=abc" });
});

test("requires both email and password and ignores blank values", () => {
  assert.equal(
    credentialsFromEnvironmentForServer("http://sharelatex.test", undefined, {
      OFSYNC_EMAIL: "user@example.com",
    }),
    undefined,
  );
  assert.equal(
    credentialsFromEnvironmentForServer("http://sharelatex.test", undefined, {
      OFSYNC_EMAIL: "   ",
      OFSYNC_PASSWORD: "secret",
    }),
    undefined,
  );
  assert.equal(credentialsFromEnvironmentForServer("http://sharelatex.test", undefined, {}), undefined);
});
