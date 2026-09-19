import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isSafeBrowserUrl } from "../lib/open-url.mjs";
import { createApi, MAX_RESPONSE_BYTES } from "../lib/api.mjs";

test("isSafeBrowserUrl allows https and loopback http, rejects everything else", () => {
  assert.equal(isSafeBrowserUrl("https://drawcms.com/device?code=1"), true);
  assert.equal(isSafeBrowserUrl("http://localhost:3000/device"), true);
  assert.equal(isSafeBrowserUrl("http://drawcms.com/device"), false); // cleartext non-loopback
  assert.equal(isSafeBrowserUrl("file:///etc/passwd"), false);
  assert.equal(isSafeBrowserUrl("javascript:alert(1)"), false);
  assert.equal(isSafeBrowserUrl("not a url"), false);
});

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("api refuses a response whose Content-Length exceeds the cap", async () => {
  await withServer(
    (req, res) => {
      // Declare an oversized body without actually sending it.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_RESPONSE_BYTES + 1),
      });
      res.end("{}");
    },
    async (origin) => {
      const api = createApi({ origin });
      const r = await api.get("/big");
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "RESPONSE_TOO_LARGE");
    },
  );
});

test("api refuses a streamed body that grows past the cap", async () => {
  // Use a tiny effective cap by pointing at a server that streams more than the
  // real cap would allow is impractical; instead assert the streaming path by
  // sending a body larger than the cap without a Content-Length header.
  const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1 MiB of 'A'
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" }); // no content-length
      // Write just over the cap.
      const times = Math.ceil(MAX_RESPONSE_BYTES / chunk.length) + 1;
      let i = 0;
      const writeNext = () => {
        if (i++ >= times) return res.end();
        if (res.write(chunk)) writeNext();
        else res.once("drain", writeNext);
      };
      writeNext();
    },
    async (origin) => {
      const api = createApi({ origin });
      const r = await api.get("/stream");
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "RESPONSE_TOO_LARGE");
    },
  );
});

test("api accepts a normal small JSON body", async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hello: "world" }));
    },
    async (origin) => {
      const api = createApi({ origin });
      const r = await api.get("/small");
      assert.equal(r.ok, true);
      assert.equal(r.data.hello, "world");
    },
  );
});
