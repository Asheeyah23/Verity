import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { postPinned } from "./post-pinned.js";

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
}

test("connects to the pinned address even though the URL names another host", async () => {
  let seenHost: string | undefined;
  let seenBody = "";
  const { server, port } = await listen((req, res) => {
    seenHost = req.headers.host;
    req.on("data", (c) => (seenBody += c));
    req.on("end", () => res.writeHead(204).end());
  });
  try {
    // example.invalid never resolves; only the pinned address can answer.
    const url = new URL(`http://example.invalid:${port}/hook`);
    const res = await postPinned(
      { url, address: "127.0.0.1", family: 4 },
      { headers: { "content-type": "application/json" }, body: '{"a":1}', timeoutMs: 3000 }
    );
    assert.equal(res.status, 204);
    assert.equal(seenBody, '{"a":1}');
    assert.equal(seenHost, `example.invalid:${port}`);
  } finally {
    server.close();
  }
});

test("a redirect is reported as its status and never followed", async () => {
  let otherHit = false;
  const other = await listen((_req, res) => {
    otherHit = true;
    res.writeHead(200).end();
  });
  const { server, port } = await listen((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${other.port}/` }).end();
  });
  try {
    const res = await postPinned(
      { url: new URL(`http://127.0.0.1:${port}/`), address: "127.0.0.1", family: 4 },
      { headers: {}, body: "{}", timeoutMs: 3000 }
    );
    assert.equal(res.status, 302);
    assert.equal(otherHit, false);
  } finally {
    server.close();
    other.server.close();
  }
});

test("a server that never answers is cut off at the overall timeout", async () => {
  const { server, port } = await listen(() => {
    // Accept the request and say nothing.
  });
  try {
    const started = Date.now();
    await assert.rejects(
      postPinned(
        { url: new URL(`http://127.0.0.1:${port}/`), address: "127.0.0.1", family: 4 },
        { headers: {}, body: "{}", timeoutMs: 300 }
      ),
      /not finished within/
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a refused connection rejects", async () => {
  const { server, port } = await listen((_req, res) => res.end());
  server.close();
  await once(server, "close");
  await assert.rejects(
    postPinned(
      { url: new URL(`http://127.0.0.1:${port}/`), address: "127.0.0.1", family: 4 },
      { headers: {}, body: "{}", timeoutMs: 3000 }
    ),
    { code: "ECONNREFUSED" }
  );
});
