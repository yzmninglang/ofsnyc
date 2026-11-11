import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { ShareLatexClient } from "../remote/sharelatex-client.js";
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
      response.end("compiled-pdf");
      return;
    }
    assert.fail("Unexpected request");
  }, async (serverUrl) => {
    const client = new ShareLatexClient(serverUrl, { cookie: "overleaf.sid=browser-session" });
    await client.authenticate();

    const result = await client.compile("project-1");

    assert.equal(result.buildId, "build-123");
    assert.equal(new TextDecoder().decode(result.pdf), "compiled-pdf");
  });
});
