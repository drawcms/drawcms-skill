// Shared output helpers. Every command supports a --json mode that prints a
// single JSON object to stdout so an agent can parse the receipt; the default
// human mode prints concise lines. Nothing is logged that a non-zero exit would
// contradict — a failed command never prints a success line.

export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  // Flags that never take a value. Listing them here stops the parser from
  // greedily consuming the following positional as their value — e.g.
  // `diff --against-cloud order-sequence` must keep `order-sequence` positional,
  // not read it as the flag's value.
  const BOOLEAN_FLAGS = new Set([
    "json",
    "force",
    "yes",
    "animate",
    "against-cloud",
    "no-diagram",
    "seed",
    "help",
    "begin",
    "finish",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "-h") flags.help = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(arg.slice(2))) {
        flags[arg.slice(2)] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export function emit(result, { json }) {
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  if (typeof result.render === "function") {
    result.render();
    return;
  }
  // Fallback human rendering.
  const { ok } = result;
  process.stdout.write((ok ? "ok" : "error") + "\n");
}

export function fail(json, payload) {
  emit({ ok: false, ...payload }, { json });
  process.exit(1);
}
