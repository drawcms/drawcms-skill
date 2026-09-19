import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeOrigin,
  isLoopbackHost,
  sameOrigin,
  resolveAuthenticatedOrigin,
} from "../lib/config.mjs";

test("isLoopbackHost recognizes loopback names", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["drawcms.com", "example.org", "10.0.0.1"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});

test("assertSafeOrigin accepts https and loopback http", () => {
  assert.equal(assertSafeOrigin("https://drawcms.com").ok, true);
  assert.equal(assertSafeOrigin("http://localhost:3000").ok, true);
  assert.equal(assertSafeOrigin("http://127.0.0.1:8787").ok, true);
});

test("assertSafeOrigin refuses cleartext http to a non-loopback host", () => {
  const r = assertSafeOrigin("http://drawcms.com");
  assert.equal(r.ok, false);
  assert.equal(r.code, "INSECURE_ORIGIN");
});

test("assertSafeOrigin refuses a non-http(s) scheme", () => {
  const r = assertSafeOrigin("file:///etc/passwd");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BAD_ORIGIN_SCHEME");
});

test("assertSafeOrigin refuses a malformed origin", () => {
  const r = assertSafeOrigin("not a url");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BAD_ORIGIN");
});

test("sameOrigin compares scheme+host+port only", () => {
  assert.equal(sameOrigin("https://drawcms.com", "https://drawcms.com/x"), true);
  assert.equal(sameOrigin("https://drawcms.com", "http://drawcms.com"), false);
  assert.equal(sameOrigin("https://drawcms.com", "https://staging.drawcms.com"), false);
  assert.equal(sameOrigin("http://localhost:3000", "http://localhost:4000"), false);
});

test("resolveAuthenticatedOrigin flags cross-origin when link differs from login origin", () => {
  const config = { origin: "https://drawcms.com", token: "t" };
  const r = resolveAuthenticatedOrigin({}, config, "https://staging.drawcms.com");
  assert.equal(r.ok, true);
  assert.equal(r.origin, "https://staging.drawcms.com");
  assert.equal(r.crossOrigin, true);
  assert.equal(r.loginOrigin, "https://drawcms.com");
});

test("resolveAuthenticatedOrigin is not cross-origin when they match", () => {
  const config = { origin: "https://drawcms.com", token: "t" };
  const r = resolveAuthenticatedOrigin({}, config, "https://drawcms.com");
  assert.equal(r.crossOrigin, false);
});

test("resolveAuthenticatedOrigin refuses an insecure resolved origin", () => {
  const config = { origin: "https://drawcms.com", token: "t" };
  const r = resolveAuthenticatedOrigin({}, config, "http://evil.example");
  assert.equal(r.ok, false);
  assert.equal(r.code, "INSECURE_ORIGIN");
});
