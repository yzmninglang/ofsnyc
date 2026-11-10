import assert from "node:assert/strict";
import test from "node:test";
import { joinProjectRealtime } from "../remote/realtime-tree.js";

test("joins a legacy Socket.IO project tree and disconnects cleanly", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  let polls = 0;
  const project = {
    _id: "project-1",
    name: "Example project",
    rootFolder: [{
      _id: "root-folder",
      docs: [{ _id: "doc-1", name: "main.tex" }],
      fileRefs: [{ _id: "file-1", name: "figure.png", _type: "file" }],
      folders: [{
        _id: "chapter-folder",
        name: "chapters",
        docs: [{ _id: "doc-2", name: "intro.tex" }],
        fileRefs: [],
        folders: [],
      }],
    }],
  };

  const tree = await joinProjectRealtime("http://sharelatex.test", "project-1", async (url, init) => {
    calls.push({ url: new URL(url), init });
    if (url.pathname === "/socket.io/1/") {
      return new Response("session-1:60:60:websocket,xhr-polling");
    }
    if (url.searchParams.get("disconnect") === "1") {
      return new Response("");
    }
    if ((init?.method ?? "GET") === "POST") {
      assert.equal(init?.body, "2::");
      return new Response("");
    }
    polls += 1;
    if (polls === 1) {
      return new Response("2::");
    }
    const packet = `5:::${JSON.stringify({ name: "joinProjectResponse", args: [{ project }] })}`;
    return new Response(`\ufffd${packet.length}\ufffd${packet}`);
  });

  assert.equal(calls[0].url.searchParams.get("projectId"), "project-1");
  assert.equal(tree.id, "project-1");
  assert.equal(tree.name, "Example project");
  assert.equal(tree.folders.get("")?.id, "root-folder");
  assert.equal(tree.files.get("main.tex")?.kind, "doc");
  assert.equal(tree.files.get("figure.png")?.kind, "file");
  assert.equal(tree.files.get("chapters/intro.tex")?.id, "doc-2");
  assert.ok(calls.some(({ url }) => url.searchParams.get("disconnect") === "1"));
});

test("reports a closed legacy Socket.IO connection immediately", async () => {
  await assert.rejects(
    () => joinProjectRealtime("http://sharelatex.test", "project-1", async (url) => {
      if (url.pathname === "/socket.io/1/") {
        return new Response("session-1:60:60:xhr-polling");
      }
      return new Response("0::");
    }),
    /closed the connection/,
  );
});
