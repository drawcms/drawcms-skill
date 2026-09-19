// Best-effort cross-platform "open this URL in the browser". Never throws: in a
// headless or CI environment (or when DRAWCMS_NO_BROWSER is set) it resolves
// false so the caller falls back to printing the URL for the user to open
// manually. This matters for terminal agents that run without a display.

import { spawn } from "node:child_process";
import { isLoopbackHost } from "./config.mjs";

/** Only hand safe URLs to the OS handler. The verification URL comes from the
 * server's device-code response, so a hostile or compromised auth server could
 * return a scheme the OS would act on (file:, javascript:, custom protocol
 * handlers). Restrict to https, or http on loopback for local development. The
 * caller always prints the URL regardless, so a rejected URL is not lost — it
 * simply is not auto-launched. */
export function isSafeBrowserUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return true;
  return false;
}

export async function openUrl(url) {
  if (process.env.DRAWCMS_NO_BROWSER) return false;
  if (!isSafeBrowserUrl(url)) return false;

  const platform = process.platform;
  let command;
  let args;
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    // Linux / other: xdg-open is the de facto standard.
    command = "xdg-open";
    args = [url];
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.unref();
      // We cannot truly know the browser opened; assume success if spawn did
      // not immediately error. The caller always prints the URL anyway.
      setTimeout(() => resolve(true), 150);
    } catch {
      resolve(false);
    }
  });
}
