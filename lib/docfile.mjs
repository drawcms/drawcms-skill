// Helpers for the local document files a repo keeps under .drawcms/. Each
// tracked diagram is mirrored to .drawcms/<logicalName>.json. We record a hash
// of the exact bytes last written by `pull` so `pull` and `push` can tell
// whether the working copy was edited locally since, without a server round
// trip.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_DIR } from "./project.mjs";

export function documentFileName(logicalName) {
  // Keep it filesystem-safe; logical names are simple slugs in practice.
  return `${logicalName.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

export function documentPath(logicalName, cwd = process.cwd()) {
  return join(cwd, PROJECT_DIR, documentFileName(logicalName));
}

/** Canonical JSON bytes for a document, so hashes are stable across reads. */
export function canonicalJson(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function writeDocument(logicalName, document, cwd = process.cwd()) {
  const text = canonicalJson(document);
  await writeFile(documentPath(logicalName, cwd), text);
  return { path: documentPath(logicalName, cwd), hash: hashText(text) };
}

/** Path of the stash file that `push --force` writes the overwritten cloud
 * revision to, so a forced overwrite is recoverable locally (the cloud also
 * keeps server-side revision history, but this hands the user the exact bytes
 * that were clobbered without a round trip). One file per diagram; the latest
 * forced overwrite wins. */
export function stashPath(logicalName, cwd = process.cwd()) {
  return join(cwd, PROJECT_DIR, `${logicalName.replace(/[^a-zA-Z0-9._-]/g, "_")}.stash.json`);
}

/** Write the cloud document being overwritten by `push --force` to a stash
 * file, wrapped with the version and a timestamp so the user can identify and
 * restore it. Returns the path written. */
export async function writeStash(logicalName, { document, version }, cwd = process.cwd()) {
  const path = stashPath(logicalName, cwd);
  const payload = {
    stashedAt: new Date().toISOString(),
    reason: "overwritten by `drawcms push --force`",
    version: version ?? null,
    document,
  };
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

/** Read a local document file, returning { text, hash, document } or null.
 * A file that exists but is not valid JSON returns { text, hash, document:null }
 * so callers can still detect "present and locally modified" without crashing —
 * status/diff must never throw on a half-edited working copy. */
export async function readDocument(logicalName, cwd = process.cwd()) {
  let text;
  try {
    text = await readFile(documentPath(logicalName, cwd), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let document = null;
  try {
    document = JSON.parse(text);
  } catch {
    document = null;
  }
  return { text, hash: hashText(text), document };
}
