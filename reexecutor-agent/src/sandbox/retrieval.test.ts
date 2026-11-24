import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, test } from "node:test";
import { RetrievalTransientError, getPinned, hasConnectivity, isInconclusiveStatus, isPrivateAddress, resolvePointer, resolvePublicTarget, runRetrieval } from "./retrieval.js";

describe("isInconclusiveStatus", () => {
  const testCases: Array<{ status: number; expected: boolean }> = [
    // Inconclusive statuses specified by the issue
    { status: 401, expected: true },
    { status: 403, expected: true },
    { status: 408, expected: true },
    { status: 429, expected: true },
    { status: 451, expected: true },
    { status: 500, expected: true },
    { status: 502, expected: true },
    { status: 503, expected: true },
    { status: 599, expected: true },

    // Definitive non-inconclusive statuses
    { status: 200, expected: false },
    { status: 204, expected: false },
    { status: 301, expected: false },
    { status: 400, expected: false },
    { status: 404, expected: false },
    { status: 410, expected: false },
    { status: 418, expected: false },
  ];

  for (const { status, expected } of testCases) {
    it(`returns ${expected} for HTTP ${status}`, () => {
      assert.equal(isInconclusiveStatus(status), expected);
    });
  }
});

describe("runRetrieval DNS resolution", () => {
  it("rejects with RetrievalTransientError when host does not exist (.invalid TLD)", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://does-not-exist.invalid/" });
      },
      (err: unknown) => {
        assert(err instanceof RetrievalTransientError, `expected RetrievalTransientError, got ${String(err)}`);
        assert(/could not resolve does-not-exist\.invalid/i.test((err as Error).message));
        return true;
      }
    );
  });

  it("still throws a plain Error for private addresses and invalid protocols", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "ftp://example.com/file" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/unsupported retrieval protocol/i.test(err.message));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://127.0.0.1:8080/data" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/non-public address/i.test(err.message));
        return true;
      }
    );
  });
});

describe("resolvePointer", () => {
  it("returns whole document when pointer is empty", () => {
    const doc = { a: 1, b: [2, 3] };
    assert.deepEqual(resolvePointer(doc, ""), doc);
  });

  it("throws error for pointer without a leading slash", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "a"),
      /invalid JSON pointer/
    );
  });

  it("throws error when descending into a primitive", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "/a/b"),
      /JSON pointer \/a\/b does not resolve in the response/
    );
  });

  it("resolves unescaped ~0 and ~1 tokens in the correct RFC 6901 order", () => {
    assert.equal(resolvePointer({ "a/b": 1 }, "/a~1b"), 1);
    assert.equal(resolvePointer({ "m~n": 2 }, "/m~0n"), 2);
    assert.equal(resolvePointer({ "x~/y": 3 }, "/x~0~1y"), 3);
  });

  it("does not resolve prototype properties on plain objects", () => {
    const doc = { a: 1 };
    for (const pointer of ["/constructor", "/__proto__", "/toString", "/valueOf"]) {
      assert.throws(
        () => resolvePointer(doc, pointer),
        /does not resolve in the response/,
        `expected ${pointer} to not resolve on plain object`
      );
    }
  });

  it("resolves own __proto__ property parsed with JSON.parse", () => {
    const doc = JSON.parse('{"__proto__": 5}');
    assert.equal(resolvePointer(doc, "/__proto__"), 5);
  });

  it("resolves valid canonical indices on arrays", () => {
    const arr = [10, 20, 30];
    assert.equal(resolvePointer(arr, "/0"), 10);
    assert.equal(resolvePointer(arr, "/1"), 20);
    assert.equal(resolvePointer(arr, "/2"), 30);
  });

  it("does not resolve length, non-canonical numbers, or out-of-range indices on arrays", () => {
    const arr = [1, 2];
    const invalidArrayPointers = ["/length", "/01", "/-", "/+1", "/1.0", "/2", "/99"];
    for (const pointer of invalidArrayPointers) {
      assert.throws(
        () => resolvePointer(arr, pointer),
        /does not resolve in the response/,
        `expected ${pointer} to not resolve on array`
      );
    }
  });
});

describe("isInconclusiveStatus", () => {
  const testCases: Array<{ status: number; expected: boolean }> = [
    // Inconclusive statuses specified by the issue
    { status: 401, expected: true },
    { status: 403, expected: true },
    { status: 408, expected: true },
    { status: 429, expected: true },
    { status: 451, expected: true },
    { status: 500, expected: true },
    { status: 502, expected: true },
    { status: 503, expected: true },
    { status: 599, expected: true },

    // Definitive non-inconclusive statuses
    { status: 200, expected: false },
    { status: 204, expected: false },
    { status: 301, expected: false },
    { status: 400, expected: false },
    { status: 404, expected: false },
    { status: 410, expected: false },
    { status: 418, expected: false },
  ];

  for (const { status, expected } of testCases) {
    it(`returns ${expected} for HTTP ${status}`, () => {
      assert.equal(isInconclusiveStatus(status), expected);
    });
  }
});

describe("runRetrieval DNS resolution", () => {
  it("rejects with RetrievalTransientError when host does not exist (.invalid TLD)", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://does-not-exist.invalid/" });
      },
      (err: unknown) => {
        assert(err instanceof RetrievalTransientError, `expected RetrievalTransientError, got ${String(err)}`);
        assert(/could not resolve does-not-exist\.invalid/i.test((err as Error).message));
        return true;
      }
    );
  });

  it("still throws a plain Error for private addresses and invalid protocols", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "ftp://example.com/file" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/unsupported retrieval protocol/i.test(err.message));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://127.0.0.1:8080/data" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/non-public address/i.test(err.message));
        return true;
      }
    );
  });
});

describe("isPrivateAddress", () => {
  const privateIps = [
    "10.0.0.1",
    "127.0.0.1",
    "0.0.0.0",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "FD00::1",
    "::FFFF:10.0.0.1",
    // Ranges the first version of the check missed
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "fec0::1",
    "ff02::1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    // Non-global IANA IPv6 special-purpose blocks
    "64:ff9b:1::a9fe:a9fe",
    "64:ff9b:1::808:808",
    "::ffff:0:7f00:1",
    "::ffff:0:127.0.0.1",
    "::ffff:0:808:808",
    "2001:0:4136:e378::1",
    "2001:2::1",
    "2001:10::1",
    "3fff::1",
    "5f00::1",
    "not-an-ip",
  ];

  for (const ip of privateIps) {
    it(`returns true for private IP ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), true);
    });
  }

  const publicIps = [
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.1.1",
    "169.253.1.1",
    "2001:4860:4860::8888",
    "2606:4700::1111",
    "2606:4700:4700::1111",
    "2001:2:1::1",
    "2001:20::1",
    "3fff:1000::1",
    "5f01::1",
    "198.20.0.0",
    "::ffff:808:808",
    "64:ff9b::808:808",
  ];

  for (const ip of publicIps) {
    it(`returns false for public IP ${ip}`, () => {
      assert.equal(isPrivateAddress(ip), false);
    });
  }
});

describe("resolvePublicTarget", () => {
  it("rejects invalid URL with exact error message", async () => {
    await assert.rejects(
      () => resolvePublicTarget("not a url"),
      (err: Error) => err.message === "retrieval url is not a valid URL: not a url",
    );
  });

  it("rejects unsupported protocols with exact error message", async () => {
    await assert.rejects(
      () => resolvePublicTarget("ftp://8.8.8.8/x"),
      (err: Error) => err.message === "unsupported retrieval protocol: ftp:",
    );
    await assert.rejects(
      () => resolvePublicTarget("file:///etc/hosts"),
      (err: Error) => err.message === "unsupported retrieval protocol: file:",
    );
  });

  it("rejects loopback and private addresses including normalised spellings", async () => {
    const blocked = [
      { raw: "http://127.0.0.1/", host: "127.0.0.1" },
      { raw: "http://[::1]/", host: "::1" },
      { raw: "http://0x7f.0.0.1/", host: "127.0.0.1" },
      { raw: "http://2130706433/", host: "127.0.0.1" },
      { raw: "http://10.1.2.3/", host: "10.1.2.3" },
      { raw: "http://[64:ff9b:1::a9fe:a9fe]/", host: "64:ff9b:1::a9fe:a9fe" },
      { raw: "http://[::ffff:0:7f00:1]/", host: "::ffff:0:7f00:1" },
    ];

    for (const { raw, host } of blocked) {
      await assert.rejects(
        () => resolvePublicTarget(raw),
        (err: Error) =>
          err.message === `retrieval target ${host} resolves to a non-public address`,
      );
    }
  });

  it("resolves public IPv4 literal target", async () => {
    const raw = "https://8.8.8.8/path?x=1";
    const res = await resolvePublicTarget(raw);
    assert.equal(res.url.href, raw);
    assert.equal(res.address, "8.8.8.8");
    assert.equal(res.family, 4);
  });

  it("resolves public IPv6 literal target", async () => {
    const raw = "http://[2001:4860:4860::8888]/";
    const res = await resolvePublicTarget(raw);
    assert.equal(res.url.href, raw);
    assert.equal(res.address, "2001:4860:4860::8888");
    assert.equal(res.family, 6);
  });
});

describe("resolvePointer", () => {
  it("returns the document itself for an empty pointer (same reference)", () => {
    const doc = { a: 1, b: [2, 3] };
    assert.equal(resolvePointer(doc, ""), doc);
  });

  it("throws for a pointer without a leading slash", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "a/b"),
      (err: Error) => err.message === "invalid JSON pointer: a/b",
    );
  });

  it("resolves nested paths and array indices", () => {
    const doc = { a: { b: [10, 20] } };
    assert.equal(resolvePointer(doc, "/a/b/1"), 20);
  });

  it("resolves escaped ~1 to /", () => {
    const doc = { "a/b": 1 };
    assert.equal(resolvePointer(doc, "/a~1b"), 1);
  });

  it("resolves escaped ~0 to ~", () => {
    const doc = { "m~n": 2 };
    assert.equal(resolvePointer(doc, "/m~0n"), 2);
  });

  it("resolves /~01 to ~1", () => {
    const doc = { "~1": 3 };
    assert.equal(resolvePointer(doc, "/~01"), 3);
  });

  it("resolves / with an empty key", () => {
    const doc = { "": 4 };
    assert.equal(resolvePointer(doc, "/"), 4);
  });

  it("throws when a key is missing", () => {
    assert.throws(
      () => resolvePointer({ a: 1 }, "/missing"),
      (err: Error) =>
        err.message === "JSON pointer /missing does not resolve in the response",
    );
  });

  it("throws when indexing past the end of an array", () => {
    assert.throws(
      () => resolvePointer([1, 2], "/5"),
      (err: Error) =>
        err.message === "JSON pointer /5 does not resolve in the response",
    );
  });

  it("throws when stepping into null or a non-object", () => {
    assert.throws(
      () => resolvePointer({ a: null }, "/a/b"),
      (err: Error) =>
        err.message === "JSON pointer /a/b does not resolve in the response",
    );
    assert.throws(
      () => resolvePointer({ a: "str" }, "/a/b"),
      (err: Error) =>
        err.message === "JSON pointer /a/b does not resolve in the response",
    );
  });
});

describe("runRetrieval argument shape rejections", () => {
  it("rejects undefined or missing spec before network access", async () => {
    await assert.rejects(
      () => (runRetrieval as any)(undefined),
      (err: Error) =>
        err.message ===
        'retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}',
    );
  });

  it("rejects non-string url before network access", async () => {
    await assert.rejects(
      () => (runRetrieval as any)({ url: 5 }),
      (err: Error) =>
        err.message ===
        'retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}',
    );
  });
});

describe("isInconclusiveStatus", () => {
  const testCases: Array<{ status: number; expected: boolean }> = [
    // Inconclusive statuses specified by the issue
    { status: 401, expected: true },
    { status: 403, expected: true },
    { status: 408, expected: true },
    { status: 429, expected: true },
    { status: 451, expected: true },
    { status: 500, expected: true },
    { status: 502, expected: true },
    { status: 503, expected: true },
    { status: 599, expected: true },

    // Definitive non-inconclusive statuses
    { status: 200, expected: false },
    { status: 204, expected: false },
    { status: 301, expected: false },
    { status: 400, expected: false },
    { status: 404, expected: false },
    { status: 410, expected: false },
    { status: 418, expected: false },
  ];

  for (const { status, expected } of testCases) {
    it(`returns ${expected} for HTTP ${status}`, () => {
      assert.equal(isInconclusiveStatus(status), expected);
    });
  }
});

describe("runRetrieval DNS resolution", () => {
  it("rejects with RetrievalTransientError when host does not exist (.invalid TLD)", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://does-not-exist.invalid/" });
      },
      (err: unknown) => {
        assert(err instanceof RetrievalTransientError, `expected RetrievalTransientError, got ${String(err)}`);
        assert(/could not resolve does-not-exist\.invalid/i.test((err as Error).message));
        return true;
      }
    );
  });

  it("still throws a plain Error for private addresses and invalid protocols", async () => {
    await assert.rejects(
      async () => {
        await runRetrieval({ url: "ftp://example.com/file" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/unsupported retrieval protocol/i.test(err.message));
        return true;
      }
    );

    await assert.rejects(
      async () => {
        await runRetrieval({ url: "http://127.0.0.1:8080/data" });
      },
      (err: unknown) => {
        assert(!(err instanceof RetrievalTransientError), "should be a plain Error");
        assert(err instanceof Error);
        assert(/non-public address/i.test(err.message));
        return true;
      }
    );
  });
});

async function listen(): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/` };
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

test("hasConnectivity reaches an operator-configured loopback URL", async () => {
  const { server, url } = await listen();
  try {
    assert.equal(await hasConnectivity(url), true);
  } finally {
    await close(server);
  }
});

test("hasConnectivity is false when nothing answers", async () => {
  const { server, url } = await listen();
  await close(server);
  assert.equal(await hasConnectivity(url), false);
});

test("runRetrieval still refuses a loopback target", async () => {
  const { server, url } = await listen();
  try {
    await assert.rejects(runRetrieval({ url }), /non-public address/);
  } finally {
    await close(server);
  }
});

test("getPinned gives up on a server that keeps dripping bytes past the overall deadline", async () => {
  // Each chunk arrives well inside the 10 s idle timeout, so only the overall
  // deadline can end this request.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("x"), 50);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const target = await resolvePublicTarget(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    const started = Date.now();
    await assert.rejects(getPinned(target, 300), (err: Error) => {
      assert.ok(err instanceof RetrievalTransientError);
      assert.match(err.message, /not finished within/);
      return true;
    });
    assert.ok(Date.now() - started < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
