// `drawcms login` — device-authorization sign-in (RFC 8628).
//
// Two shapes, because a blocking login is wrong for an agent:
//
//   drawcms login            One shot. Requests a code, opens the browser, and
//                            blocks until you approve. Correct for a human at a
//                            terminal, who sees the URL immediately.
//
//   drawcms login --begin    Requests a code, prints the authorization URL and
//                            user code to STDOUT, and exits straight away.
//   drawcms login --finish   Resumes the pending request and polls until it is
//                            approved.
//
// The split exists because an agent normally surfaces a command's output only
// after that command exits. With the one-shot form the agent would sit on a
// blocked process while the human never sees the URL they are supposed to open —
// a deadlock that ends in a 15-minute timeout. `--begin` hands the URL back
// immediately so the agent can relay it, then `--finish` waits.

import { emit } from "../output.mjs";
import { createApi } from "../api.mjs";
import { openUrl, isSafeBrowserUrl } from "../open-url.mjs";
import {
  CLI_CLIENT_ID,
  readConfig,
  resolveOrigin,
  assertSafeOrigin,
  saveSession,
  writeConfig,
} from "../config.mjs";

const HELP = `drawcms login [--begin | --finish] [--origin <url>] [--json] [--no-browser]

Signs in via the browser using the device-authorization flow and stores a
session token in ~/.drawcms/config.json (owner-only). The CLI never handles a
password.

  (no flag)      One shot: request a code, open the browser, wait for approval.
                 Use this interactively. It blocks until approved.
  --begin        Request a code and print the authorization URL + code, then
                 exit immediately. Use this from an agent or a script.
  --finish       Poll the pending request until it is approved.
  --origin <url> DrawCMS server origin (default: stored or https://drawcms.com).
  --no-browser   Do not try to open a browser; just print the URL.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ flags }) {
  if (flags.help) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }
  if (flags["no-browser"]) process.env.DRAWCMS_NO_BROWSER = "1";

  if (flags.begin && flags.finish) {
    return failLogin(flags.json, "USAGE", "Use --begin or --finish, not both.", null);
  }
  if (flags.finish) return finishLogin(flags);
  if (flags.begin) return beginLogin(flags);
  return oneShotLogin(flags);
}

/** Request a device+user code and persist it so a later --finish can resume. */
async function requestCode(flags) {
  const config = await readConfig();
  const origin = resolveOrigin(flags, config);
  // Refuse to mint/store a token against an insecure origin (http non-loopback)
  // or a malformed one, before any network call.
  const safe = assertSafeOrigin(origin);
  if (!safe.ok) {
    return { ok: false, origin, code: safe.code, message: safe.message };
  }
  const api = createApi({ origin });

  const res = await api.post("/api/auth/device/code", { client_id: CLI_CLIENT_ID }, { auth: false });
  if (!res.ok) {
    return {
      ok: false,
      origin,
      code: "DEVICE_CODE_FAILED",
      // Name the origin: the most common cause of this failing is talking to
      // the wrong server (e.g. the default production origin during a local
      // test, where the device-flow tables may not be deployed). An agent that
      // sees the origin can correct it with --origin / DRAWCMS_ORIGIN.
      message: `Could not start login against ${origin} (${
        res.error?.message ?? "request failed"
      }). If this is not the server you meant, set --origin or DRAWCMS_ORIGIN.`,
    };
  }

  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval,
    expires_in,
  } = res.data;

  const verificationUrl = verification_uri_complete || `${origin}${verification_uri}`;
  // The verification URL comes from the server. Refuse to surface or open a URL
  // with a scheme we would not trust (file:, javascript:, custom handlers) —
  // a hostile/compromised auth server must not be able to make the CLI present
  // an attacker-controlled link as the sign-in URL.
  if (!isSafeBrowserUrl(verificationUrl)) {
    return {
      ok: false,
      origin,
      code: "UNSAFE_VERIFICATION_URL",
      message: `The server returned a sign-in URL with an untrusted scheme (${verificationUrl}). Refusing to proceed.`,
    };
  }
  const expiresAt = Date.now() + Math.max(30, Number(expires_in) || 900) * 1000;
  const pending = {
    origin,
    deviceCode: device_code,
    userCode: user_code,
    verificationUrl,
    interval: Math.max(1, Number(interval) || 5),
    expiresAt,
  };

  const next = await readConfig();
  next.pendingLogin = pending;
  await writeConfig(next);

  return { ok: true, origin, pending };
}

/** Poll until approved. Returns { ok, token } or a structured failure. */
async function pollForToken(origin, pending) {
  const api = createApi({ origin });
  let pollInterval = pending.interval * 1000;

  while (Date.now() < pending.expiresAt) {
    await sleep(pollInterval);
    const res = await api.post(
      "/api/auth/device/token",
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pending.deviceCode,
        client_id: CLI_CLIENT_ID,
      },
      { auth: false },
    );

    if (res.ok && res.data?.access_token) return { ok: true, token: res.data.access_token };

    // RFC 8628 polling errors arrive in the body.
    const code = res.data?.error ?? res.error?.code;
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      pollInterval += 5000;
      continue;
    }
    if (code === "access_denied") {
      return { ok: false, code: "ACCESS_DENIED", message: "The sign-in request was denied." };
    }
    if (code === "expired_token") {
      return { ok: false, code: "EXPIRED", message: "The sign-in request expired before approval." };
    }
    return {
      ok: false,
      code: "TOKEN_ERROR",
      message: res.data?.error_description ?? res.error?.message ?? "Login failed.",
    };
  }
  return { ok: false, code: "TIMEOUT", message: "Timed out waiting for approval." };
}

/** Store the session and drop the pending request. */
async function completeLogin(origin, token) {
  const user = await fetchUser(origin, token);
  await saveSession({ token, origin, user });
  const config = await readConfig();
  delete config.pendingLogin;
  await writeConfig(config);
  return user;
}

async function beginLogin(flags) {
  const started = await requestCode(flags);
  if (!started.ok) return failLogin(flags.json, started.code, started.message, started.origin);

  const { origin, pending } = started;
  const opened = await openUrl(pending.verificationUrl);

  emit(
    {
      ok: true,
      command: "login",
      phase: "begin",
      origin,
      // Everything the caller needs to show a human, on stdout.
      verificationUrl: pending.verificationUrl,
      userCode: pending.userCode,
      expiresInSeconds: Math.round((pending.expiresAt - Date.now()) / 1000),
      browserOpened: opened,
      next: "drawcms login --finish",
      render() {
        process.stdout.write(
          `Open this URL to authorize the CLI:\n  ${pending.verificationUrl}\n` +
            `Verify the code shown there matches: ${pending.userCode}\n` +
            (opened ? "(a browser was opened for you)\n" : "") +
            `Then run: drawcms login --finish\n`,
        );
      },
    },
    { json: flags.json },
  );
  process.exit(0);
}

async function finishLogin(flags) {
  const config = await readConfig();
  const pending = config.pendingLogin;
  if (!pending) {
    return failLogin(
      flags.json,
      "NO_PENDING_LOGIN",
      "No sign-in is in progress. Run `drawcms login --begin` first.",
      null,
    );
  }
  if (Date.now() >= pending.expiresAt) {
    delete config.pendingLogin;
    await writeConfig(config);
    return failLogin(
      flags.json,
      "EXPIRED",
      "That sign-in request expired. Run `drawcms login --begin` again.",
      pending.origin,
    );
  }

  const result = await pollForToken(pending.origin, pending);
  if (!result.ok) return failLogin(flags.json, result.code, result.message, pending.origin);

  const user = await completeLogin(pending.origin, result.token);
  emitSuccess(flags.json, pending.origin, user, "finish");
}

async function oneShotLogin(flags) {
  const started = await requestCode(flags);
  if (!started.ok) return failLogin(flags.json, started.code, started.message, started.origin);

  const { origin, pending } = started;
  const opened = await openUrl(pending.verificationUrl);

  // Interactive form: the human is watching, so the prompt goes to stderr and
  // stdout stays a single clean receipt.
  process.stderr.write(
    [
      opened ? "Opened your browser to approve this sign-in." : "Open this URL to approve this sign-in:",
      `  ${pending.verificationUrl}`,
      `Verify the code shown there matches: ${pending.userCode}`,
      "Waiting for approval…",
    ].join("\n") + "\n",
  );

  const result = await pollForToken(origin, pending);
  if (!result.ok) return failLogin(flags.json, result.code, result.message, origin);

  const user = await completeLogin(origin, result.token);
  emitSuccess(flags.json, origin, user, "oneshot");
}

/** Resolve who we signed in as, so the receipt can name them. Best effort. */
async function fetchUser(origin, token) {
  const api = createApi({ origin, token });
  const res = await api.get("/api/auth/get-session");
  if (res.ok && res.data?.user) {
    return { id: res.data.user.id, email: res.data.user.email, name: res.data.user.name };
  }
  return null;
}

function emitSuccess(json, origin, user, phase) {
  emit(
    {
      ok: true,
      command: "login",
      phase,
      origin,
      user: user ?? null,
      render() {
        process.stdout.write(
          user ? `Logged in as ${user.email} (${origin}).\n` : `Logged in (${origin}).\n`,
        );
      },
    },
    { json },
  );
  process.exit(0);
}

function failLogin(json, code, message, origin) {
  emit(
    {
      ok: false,
      command: "login",
      ...(origin ? { origin } : {}),
      error: { code, message },
      render() {
        process.stderr.write(`login failed (${code}): ${message}\n`);
      },
    },
    { json },
  );
  process.exit(1);
}
