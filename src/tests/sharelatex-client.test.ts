import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { ShareLatexClient, SyncTexNotFoundError } from "../remote/sharelatex-client.js";
import type { ProjectTree } from "../types.js";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (serverUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function projectDashboard(): string {
  return '<meta name="ol-csrfToken" content="dashboard-token">';
}

test("uses the current project-list API after password login", async () => {
  const requests: Array<{ method?: string; path: string; cookie?: string }> = [];
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie });
    if (request.method === "GET" && url.pathname === "/login") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": ["overleaf.sid=pre-auth; Path=/", "affinity=first; Path=/"],
      });
      response.end('<form><input name="_csrf" value="login-token"></form>');
      return;
    }
    if (request.method === "POST" && url.pathname === "/login") {
      assert.match(request.headers.cookie ?? "", /overleaf\.sid=pre-auth/);
      assert.equal(request.headers["x-csrf-token"], "login-token");
      assert.deepEqual(JSON.parse(await readBody(request)), {
        _csrf: "login-token",
        email: "person@example.test",
        password: "test-password",
      });
      response.writeHead(302, { Location: "/project", "Set-Cookie": "overleaf.sid=authenticated; Path=/" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/project") {
      assert.match(request.headers.cookie ?? "", /overleaf\.sid=authenticated/);
      assert.match(request.headers.cookie ?? "", /affinity=first/);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/project") {
      assert.equal(request.headers["x-csrf-token"], "dashboard-token");
      assert.deepEqual(JSON.parse(await readBody(request)), { _csrf: "dashboard-token" });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        projects: [
          { _id: "active-1", name: "Active" },
          { _id: "archived-1", name: "Archived", archived: true },
        ],
      }));
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl);
    await client.authenticate({ email: "person@example.test", password: "test-password" });

    assert.equal(client.authenticated, true);
    assert.deepEqual(await client.listProjects(), [{ id: "active-1", name: "Active", archived: false, trashed: false }]);
  });

  assert.equal(requests.filter((request) => request.path === "/api/project").length, 1);
  assert.equal(requests.filter((request) => request.path === "/user/projects").length, 0);
});

test("falls back to the legacy project-list API when needed", async () => {
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/project") {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/user/projects") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ projects: [{ _id: "legacy-1", name: "Legacy" }] }));
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    assert.deepEqual(await client.listProjects(), [{ id: "legacy-1", name: "Legacy", archived: false, trashed: false }]);
  });
});

test("keeps Socket.IO affinity cookies while reading a project tree", async () => {
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "GET" && url.pathname === "/socket.io/1/") {
      assert.match(request.headers.cookie ?? "", /overleaf\.sid=browser-session/);
      response.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "affinity=socket-worker; Path=/" });
      response.end("socket-session:60:60:xhr-polling");
      return;
    }
    if (url.pathname === "/socket.io/1/xhr-polling/socket-session" && url.searchParams.get("disconnect") === "1") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/socket.io/1/xhr-polling/socket-session") {
      assert.match(request.headers.cookie ?? "", /overleaf\.sid=browser-session/);
      assert.match(request.headers.cookie ?? "", /affinity=socket-worker/);
      const project = {
        _id: "project-1",
        name: "Socket project",
        rootFolder: [{ _id: "root", docs: [{ _id: "doc-1", name: "main.tex" }], fileRefs: [], folders: [] }],
      };
      const packet = `5:::${JSON.stringify({ name: "joinProjectResponse", args: [{ project }] })}`;
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(packet);
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const tree = await client.getProjectTree("project-1");
    assert.equal(tree.name, "Socket project");
    assert.equal(tree.files.get("main.tex")?.id, "doc-1");
  });
});

test("uploads files using the ShareLaTeX multipart contract", async () => {
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/project/project-1/upload") {
      assert.equal(url.searchParams.get("folder_id"), "root-folder");
      assert.equal(url.searchParams.get("_csrf"), "dashboard-token");
      assert.equal(url.searchParams.get("qqfilename"), "main.tex");
      assert.equal(url.searchParams.get("qqtotalfilesize"), "13");
      assert.equal(request.headers["x-csrf-token"], "dashboard-token");
      const body = await readBody(request);
      assert.match(body, /name="targetFolderId"\r\n\r\nroot-folder/);
      assert.match(body, /name="name"\r\n\r\nmain\.tex/);
      assert.match(body, /name="qqfile"; filename="main\.tex"/);
      assert.match(body, /hello, world!/);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, entity_id: "doc-1", entity_type: "doc" }));
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();
    const tree: ProjectTree = {
      id: "project-1",
      name: "Upload project",
      files: new Map(),
      folders: new Map([["", { id: "root-folder", path: "" }]]),
    };

    const uploaded = await client.uploadFile("project-1", tree, "main.tex", new TextEncoder().encode("hello, world!"));
    assert.deepEqual(uploaded, { path: "main.tex", id: "doc-1", kind: "doc", parentFolderId: "root-folder" });
    assert.equal(tree.files.get("main.tex")?.id, "doc-1");
  });
});

test("extracts the Build ID for a downloaded compiled PDF", async () => {
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/project/project-1/compile") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "success",
        outputFiles: [{ type: "pdf", path: "output.pdf", url: "/project/project-1/build/build-123/output/output.pdf" }],
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/project/project-1/build/build-123/output/output.pdf") {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.end("%PDF-1.4\ncompiled-pdf");
      return;
    }
    assert.fail("Unexpected request");
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const result = await client.compile("project-1");

    assert.equal(result.buildId, "build-123");
    assert.equal(new TextDecoder().decode(result.pdf), "%PDF-1.4\ncompiled-pdf");
  });
});

test("downloads output.pdf instead of another pdf listed in the build output", async () => {
  const downloads: string[] = [];
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/project/project-1/compile") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "success",
        outputFiles: [
          { type: "pdf", path: "leftover.pdf", url: "/project/project-1/build/build-123/output/leftover.pdf" },
          { type: "pdf", path: "output.pdf", url: "/project/project-1/build/build-123/output/output.pdf" },
        ],
      }));
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/project/project-1/build/build-123/output/")) {
      downloads.push(url.pathname);
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.end(url.pathname.endsWith("/output.pdf") ? "%PDF-1.4\nreal-pdf" : "%PDF-1.4\nempty");
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const result = await client.compile("project-1");

    assert.equal(result.pdfPath, "output.pdf");
    assert.equal(new TextDecoder().decode(result.pdf), "%PDF-1.4\nreal-pdf");
    assert.deepEqual(downloads, ["/project/project-1/build/build-123/output/output.pdf"]);
  });
});

test("rejects a compiled PDF download that is not a PDF", async () => {
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (request.method === "POST" && url.pathname === "/project/project-1/compile") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "success",
        outputFiles: [
          { type: "pdf", path: "output.pdf", url: "/project/project-1/build/build-123/output/output.pdf" },
        ],
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/project/project-1/build/build-123/output/output.pdf") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<html>error page</html>");
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    await assert.rejects(() => client.compile("project-1"), /did not return a PDF file/);
  });
});

function diffHandler(
  versions: (from: string | null, to: string | null) => { status: number; body?: unknown },
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (url.pathname === "/project/project-1/filetree/diff") {
      const result = versions(url.searchParams.get("from"), url.searchParams.get("to"));
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(result.body === undefined ? "" : JSON.stringify(result.body));
      return;
    }
    assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
  };
}

test("treats a missing newer version as unchanged when the current version still exists", async () => {
  const probes: string[] = [];
  const handler = diffHandler((from, to) => {
    probes.push(`${from}->${to}`);
    return from === to && from === "7" ? { status: 200, body: { diff: [] } } : { status: 500 };
  });
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const changes = await client.getRemoteChanges("project-1", 7);

    assert.deepEqual(changes, { version: 7, paths: new Set() });
    assert.deepEqual(probes, ["8->8", "7->7"]);
  });
});

test("reports unavailable history when neither the next nor the known version exists", async () => {
  const handler = diffHandler(() => ({ status: 500 }));
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    assert.equal(await client.getRemoteChanges("project-1", 7), undefined);
  });
});

test("reports unavailable history when the endpoint rejects authentication", async () => {
  const handler = diffHandler(() => ({ status: 401 }));
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    assert.equal(await client.getRemoteChanges("project-1", 7), undefined);
  });
});

test("returns the paths changed between the known and current versions", async () => {
  const handler = diffHandler((from, to) => {
    if (from === to && from === "8") {
      return { status: 200, body: { diff: [] } };
    }
    if (from === "7" && to === "8") {
      return {
        status: 200,
        body: {
          diff: [
            { pathname: "main.tex", operation: "edited" },
            { pathname: "old.tex", newPathname: "new.tex", operation: "renamed" },
            { pathname: "gone.tex", operation: "removed" },
          ],
        },
      };
    }
    return { status: 500 };
  });
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const changes = await client.getRemoteChanges("project-1", 7);

    assert.equal(changes?.version, 8);
    assert.deepEqual([...(changes?.paths ?? [])].sort(), ["gone.tex", "main.tex", "new.tex", "old.tex"]);
  });
});

test("only treats operation-annotated entries as changed paths", async () => {
  const handler = diffHandler((from, to) => {
    if (from === to && from === "8") {
      return { status: 200, body: { diff: [] } };
    }
    if (from === "7" && to === "8") {
      return {
        status: 200,
        body: {
          diff: [
            { pathname: "IEEEtran.cls", editable: true },
            { pathname: "fig1.png", editable: false },
            { pathname: "sections/01-introduction.tex", operation: "edited", editable: true },
            { pathname: "new.pdf", operation: "added", editable: false },
            { pathname: "old.tex", newPathname: "renamed.tex", operation: "renamed", editable: true },
          ],
        },
      };
    }
    return { status: 500 };
  });
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const changes = await client.getRemoteChanges("project-1", 7);

    assert.equal(changes?.version, 8);
    assert.deepEqual(
      [...(changes?.paths ?? [])].sort(),
      ["new.pdf", "old.tex", "renamed.tex", "sections/01-introduction.tex"],
    );
  });
});

test("reports unavailable history when a non-empty diff has no operation metadata", async () => {
  const handler = diffHandler((from, to) => {
    if (from === to && from === "8") {
      return { status: 200, body: { diff: [] } };
    }
    if (from === "7" && to === "8") {
      return { status: 200, body: { diff: [{ pathname: "IEEEtran.cls", editable: true }] } };
    }
    return { status: 500 };
  });
  await withServer(handler, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    assert.equal(await client.getRemoteChanges("project-1", 7), undefined);
  });
});

test("normalizes remote SyncTeX misses from HTTP 500 and 422", async () => {
  await withServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://mock.test");
    if (request.method === "GET" && url.pathname === "/project") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(projectDashboard());
      return;
    }
    if (url.pathname === "/project/project-1/sync/code") {
      response.writeHead(500);
      response.end("no mapping");
      return;
    }
    assert.fail("Unexpected request");
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();
    await assert.rejects(
      () => client.syncCode("project-1", "main.tex", 1, 1, "build-123"),
      (error: unknown) => error instanceof SyncTexNotFoundError && error.status === 500,
    );
  });
});
