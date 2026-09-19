// Global CLI config: the device-flow session token and default server origin,
// stored at ~/.drawcms/config.json with owner-only permissions. Kept separate
// from the per-repo .drawcms/ project link (see lib/project.mjs) so signing in
// once serves every repo on the machine.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_ORIGIN = "https://drawcms.com";
export const CLI_CLIENT_ID = "drawcms-cli";

export function configDir() {
  // DRAWCMS_CONFIG_HOME lets tests and CI point the CLI at a scratch dir.
  const base = process.env.DRAWCMS_CONFIG_HOME || join(homedir(), ".drawcms");
  return base;
}

export function configPath() {
  return join(configDir(), "config.json");
}

/** Read the global config, or an empty object when none exists yet. */
export async function readConfig() {
  const path = configPath();
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A hand-edited or truncated file would otherwise surface as a raw
    // "Unexpected token" with no indication of which file to fix.
    const failure = new Error(
      `${path} is not valid JSON. Delete it and run \`drawcms login\` again.`,
    );
    failure.code = "CONFIG_CORRUPT";
    throw failure;
  }
}

/** Write the global config with owner-only (0600) permissions — it holds a
 * session token, so it must never be group/world readable. */
export async function writeConfig(config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // writeFile's mode only applies on create; enforce it explicitly so an
  // existing file with looser perms is tightened.
  await chmod(path, 0o600).catch(() => {});
}

/**
 * The server origin to talk to, in strict precedence order:
 *   --origin flag  >  DRAWCMS_ORIGIN env  >  this repo's bound origin
 *   >  the global login origin  >  DEFAULT_ORIGIN
 *
 * `linkOrigin` (from <repo>/.drawcms/config.json) MUST outrank the global
 * config: a repo is deliberately bound to one server, whereas the global
 * origin merely records where the last `login` happened. Letting the global
 * value win meant a repo bound to a self-hosted or staging instance silently
 * sent its pull/push traffic to production instead. Pass it explicitly rather
 * than merging objects, so precedence cannot be reintroduced as a spread-order
 * bug.
 */
export function resolveOrigin(flags = {}, config = {}, linkOrigin = undefined) {
  const raw =
    flags.origin ||
    process.env.DRAWCMS_ORIGIN ||
    linkOrigin ||
    config.origin ||
    DEFAULT_ORIGIN;
  return String(raw).replace(/\/+$/, "");
}

/** True when a host is a loopback address, for which cleartext http is allowed
 * (local dev via Miniflare/next dev). Everything else must use https so a
 * bearer token is never sent over the wire in the clear. */
export function isLoopbackHost(host) {
  const h = String(host).toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

/**
 * Validate a resolved origin before the CLI attaches a bearer token to it.
 * Returns { ok:true, origin } or { ok:false, code, message }.
 *
 * Rules (Finding 1 hardening):
 *  - must be a well-formed http(s) URL;
 *  - https is required, except for loopback hosts where http is allowed for
 *    local development. This stops a repo link or DRAWCMS_ORIGIN value from
 *    quietly downgrading token-bearing traffic to cleartext http.
 *
 * This does NOT decide *which* host is trusted — see tokenAllowedForOrigin for
 * the cross-origin gate. It only refuses transport that would leak the token.
 */
export function assertSafeOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return { ok: false, code: "BAD_ORIGIN", message: `"${origin}" is not a valid URL.` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "BAD_ORIGIN_SCHEME", message: `Origin must be http(s); got "${url.protocol}".` };
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      code: "INSECURE_ORIGIN",
      message: `Refusing to send a session token to ${origin} over http. Use https (http is only allowed for localhost).`,
    };
  }
  return { ok: true, origin };
}

/** Compare two origins by scheme+host+port only. Used to detect when the origin
 * a command is about to use differs from where the user actually logged in. */
export function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * Resolve the origin for a command that will attach the stored bearer token,
 * and enforce the token-safety rules in one place so every authenticated
 * command behaves identically.
 *
 * Returns:
 *   { ok:false, code, message }                          — refuse (bad/insecure origin)
 *   { ok:true, origin, crossOrigin, loginOrigin }        — proceed
 *
 * `crossOrigin` is true when the resolved origin differs from where the token
 * was minted (config.origin). The token is still attached — a repo may
 * legitimately be bound to a different server than the last global login — but
 * callers should surface `crossOrigin` so the user is aware their production
 * token is being sent somewhere new. Set DRAWCMS_ALLOW_CROSS_ORIGIN=1 or pass
 * the origin explicitly via --origin to acknowledge it silently.
 */
export function resolveAuthenticatedOrigin(flags = {}, config = {}, linkOrigin = undefined) {
  const origin = resolveOrigin(flags, config, linkOrigin);
  const safe = assertSafeOrigin(origin);
  if (!safe.ok) return safe;

  const loginOrigin = config.origin ?? null;
  const crossOrigin = Boolean(loginOrigin) && !sameOrigin(origin, loginOrigin);
  return { ok: true, origin, crossOrigin, loginOrigin };
}

/** Persist the token + origin after a successful login. */
export async function saveSession({ token, origin, user }) {
  const config = await readConfig();
  config.origin = origin;
  config.token = token;
  if (user) config.user = user;
  config.updatedAt = new Date().toISOString();
  await writeConfig(config);
}

/** The stored bearer token, or null when not logged in. */
export async function currentToken() {
  const config = await readConfig();
  return config.token ?? null;
}

/** The editor URL where a diagram opens in the browser, for surfacing to the
 * user after create/push. Mirrors the app's own /editor/<id> route. */
export function diagramUrl(origin, diagramId) {
  return `${String(origin).replace(/\/+$/, "")}/editor/${diagramId}`;
}
