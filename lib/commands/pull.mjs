// `drawcms pull` — fetch the current server document for each tracked diagram
// into .drawcms/<name>.json and record its server version as baseVersion. Git's
// pull mental model: it refreshes the local working copy from the cloud. It
// refuses to clobber a locally edited working copy unless --force, so an
// in-progress edit is never silently lost.

import { emit } from "../output.mjs";
import { createApi } from "../api.mjs";
import { readConfig, resolveAuthenticatedOrigin } from "../config.mjs";
import { readProjectConfig, writeProjectConfig } from "../project.mjs";
import { readDocument, writeDocument } from "../docfile.mjs";

const HELP = `drawcms pull [name] [--force] [--json]

Fetches the current diagram document(s) from DrawCMS into .drawcms/ and records
each server version. With no name, pulls every tracked diagram.

  [name]     Pull only this logical diagram (default: all tracked).
  --force    Overwrite a locally edited working copy.`;

export async function run({ flags, positional }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const link = await readProjectConfig();
  if (!link) return fail(flags.json, "NOT_INITIALIZED", "Run `drawcms init` in this repo first.");

  const config = await readConfig();
  if (!config.token) return fail(flags.json, "NOT_LOGGED_IN", "Run `drawcms login` first.");
  const resolved = resolveAuthenticatedOrigin(flags, config, link.origin);
  if (!resolved.ok) return fail(flags.json, resolved.code, resolved.message);
  const { origin, crossOrigin, loginOrigin } = resolved;
  if (crossOrigin && !flags.origin && !process.env.DRAWCMS_ALLOW_CROSS_ORIGIN) {
    return fail(
      flags.json,
      "CROSS_ORIGIN_TOKEN",
      `This repo is bound to ${origin}, but you logged in at ${loginOrigin}. ` +
        `Pulling would send that session token to a different server. If that is intended, ` +
        `re-run with --origin ${origin} or set DRAWCMS_ALLOW_CROSS_ORIGIN=1.`,
    );
  }
  const api = createApi({ origin, token: config.token });

  const names = positional.length
    ? positional
    : Object.keys(link.diagrams ?? {});
  if (names.length === 0) {
    return fail(flags.json, "NO_DIAGRAMS", "No diagrams are tracked. Create one with `drawcms init` or push.");
  }

  const results = [];
  let changed = false;
  for (const name of names) {
    const entry = link.diagrams?.[name];
    if (!entry) {
      results.push({ name, status: "unknown", message: "not tracked in .drawcms/config.json" });
      continue;
    }

    // Guard local edits: if the working copy diverges from what we last pulled,
    // pulling would discard the local change.
    const local = await readDocument(name);
    const locallyEdited = local && entry.pulledHash && local.hash !== entry.pulledHash;
    if (locallyEdited && !flags.force) {
      results.push({
        name,
        status: "skipped",
        message: "locally edited since last pull; re-run with --force to overwrite",
      });
      continue;
    }

    const res = await api.get(`/api/diagrams/${encodeURIComponent(entry.id)}/document`);
    if (!res.ok) {
      if (res.status === 401) return fail(flags.json, "AUTH_EXPIRED", "Login expired. Run `drawcms login` again.");
      results.push({
        name,
        status: "error",
        message: res.error?.message ?? `fetch failed (${res.status})`,
      });
      continue;
    }

    const { document, version } = res.data;
    const { hash } = await writeDocument(name, document);
    entry.baseVersion = version ?? null;
    entry.pulledHash = hash;
    changed = true;
    results.push({ name, status: "pulled", version: version ?? null });
  }

  if (changed) await writeProjectConfig(link);

  const anyError = results.some((r) => r.status === "error" || r.status === "unknown");
  emit(
    {
      ok: !anyError,
      command: "pull",
      origin,
      results,
      render() {
        for (const r of results) {
          const detail =
            r.status === "pulled" ? `v${r.version}` : r.message ? `— ${r.message}` : "";
          process.stdout.write(`${symbol(r.status)} ${r.name} ${detail}\n`);
        }
      },
    },
    { json: flags.json },
  );
  process.exit(anyError ? 1 : 0);
}

function symbol(status) {
  if (status === "pulled") return "↓";
  if (status === "skipped") return "•";
  return "✗";
}

function fail(json, code, message) {
  emit(
    {
      ok: false,
      command: "pull",
      error: { code, message },
      render() {
        process.stderr.write(`pull failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
