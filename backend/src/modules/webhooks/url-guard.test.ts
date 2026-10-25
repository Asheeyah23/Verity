import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, assertPublicHttpUrl, resolvePublicTarget } from "./url-guard.js";
import { HttpError } from "../../http-error.js";

const IP_TEST_CASES: Array<[string, boolean]> = [
  // IPv4 Private
  ["10.0.0.1", true],
  ["127.0.0.1", true],
  ["0.0.0.0", true],
  ["169.254.169.254", true],
  ["192.168.1.1", true],
  // 172.16.0.0/12 boundaries
  ["172.15.255.255", false],
  ["172.16.0.0", true],
  ["172.31.255.255", true],
  ["172.32.0.0", false],
  ["192.167.0.1", false],
  // 100.64.0.0/10 boundaries
  ["100.63.255.255", false],
  ["100.64.0.0", true],
  ["100.127.255.255", true],
  ["100.128.0.0", false],
  // Public IPv4
  ["8.8.8.8", false],
  ["1.1.1.1", false],
  // IPv6 Private / Loopback / Link-local / ULA / IPv4-mapped
  ["::1", true],
  ["::", true],
  ["fc00::1", true],
  ["fd12::1", true],
  ["fe80::1", true],
  ["::ffff:127.0.0.1", true],
  ["::ffff:10.0.0.1", true],
  // Public IPv6
  ["2001:4860:4860::8888", false],
  ["2606:4700::1111", false],
  // Ranges the first version of the guard missed
  ["198.17.255.255", false],
  ["198.18.0.1", true],
  ["198.19.255.255", true],
  ["198.20.0.0", false],
  ["224.0.0.1", true],
  ["239.255.255.250", true],
  ["240.0.0.1", true],
  ["255.255.255.255", true],
  ["192.0.2.1", true],
  ["203.0.113.9", true],
  ["fec0::1", true],
  ["febf::1", true],
  ["ff02::1", true],
  ["2001:db8::1", true],
  ["100::1", true],
  // IPv4 carried inside IPv6: judged by the IPv4 address inside
  ["::ffff:7f00:1", true],
  ["::ffff:a00:1", true],
  ["::ffff:c0a8:101", true],
  ["::ffff:a9fe:a9fe", true],
  ["::ffff:808:808", false],
  ["::ffff:8.8.8.8", false],
  ["0:0:0:0:0:ffff:7f00:1", true],
  ["64:ff9b::7f00:1", true],
  ["64:ff9b::a9fe:a9fe", true],
  ["64:ff9b::808:808", false],
  ["2002:7f00:1::", true],
  ["2002:808:808::", false],
  ["::8.8.8.8", true],
  // Malformed input is never public
  ["not-an-ip", true],
  ["1:2:3:4:5:6:7:8:9", true],
  ["1::2::3", true],
  ["", true],
];

test("isPrivateAddress correctly classifies IP addresses and range boundaries", () => {
  for (const [ip, expected] of IP_TEST_CASES) {
    assert.equal(
      isPrivateAddress(ip),
      expected,
      `Expected isPrivateAddress(${ip}) to be ${expected}`
    );
  }
});

test("assertPublicHttpUrl rejects unparseable URL", async () => {
  await assert.rejects(
    () => assertPublicHttpUrl("not a url"),
    (err: unknown) =>
      err instanceof HttpError &&
      err.statusCode === 400 &&
      err.message === "webhook url is not a valid URL"
  );
});

test("assertPublicHttpUrl rejects unsupported protocols", async () => {
  const unsupported = [
    ["ftp://example.com/x", "unsupported webhook protocol: ftp:"],
    ["file:///etc/passwd", "unsupported webhook protocol: file:"],
    ["javascript:alert(1)", "unsupported webhook protocol: javascript:"],
  ];

  for (const [url, expectedMessage] of unsupported) {
    await assert.rejects(
      () => assertPublicHttpUrl(url),
      (err: unknown) =>
        err instanceof HttpError &&
        err.statusCode === 400 &&
        err.message === expectedMessage
    );
  }
});

test("assertPublicHttpUrl rejects private IP literals", async () => {
  const privateUrls = [
    ["http://127.0.0.1/", "webhook host 127.0.0.1 resolves to a non-public address"],
    ["http://192.168.0.5:8080/a", "webhook host 192.168.0.5 resolves to a non-public address"],
    ["http://[::1]/", "webhook host ::1 resolves to a non-public address"],
  ];

  for (const [url, expectedMessage] of privateUrls) {
    await assert.rejects(
      () => assertPublicHttpUrl(url),
      (err: unknown) =>
        err instanceof HttpError &&
        err.statusCode === 400 &&
        err.message === expectedMessage
    );
  }
});

test("assertPublicHttpUrl accepts public IP literals without DNS lookup", async () => {
  const url = await assertPublicHttpUrl("https://8.8.8.8/hook");
  assert.equal(url.href, "https://8.8.8.8/hook");
});

test("resolvePublicTarget returns the checked address for the request to connect to", async () => {
  const target = await resolvePublicTarget("https://8.8.4.4:8443/hook");
  assert.equal(target.address, "8.8.4.4");
  assert.equal(target.family, 4);
  assert.equal(target.url.href, "https://8.8.4.4:8443/hook");

  const v6 = await resolvePublicTarget("http://[2606:4700::1111]/hook");
  assert.equal(v6.address, "2606:4700::1111");
  assert.equal(v6.family, 6);
});

test("resolvePublicTarget rejects IPv4 hidden in IPv6 literals", async () => {
  for (const url of ["http://[::ffff:7f00:1]/", "http://[::ffff:169.254.169.254]/", "http://[64:ff9b::a9fe:a9fe]/"]) {
    await assert.rejects(
      () => resolvePublicTarget(url),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400 && /non-public/.test(err.message),
      url
    );
  }
});
