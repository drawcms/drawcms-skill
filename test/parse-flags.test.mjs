import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../lib/output.mjs";

test("a boolean flag does not swallow the following positional", () => {
  const { flags, positional } = parseFlags(["--against-cloud", "order-sequence"]);
  assert.equal(flags["against-cloud"], true);
  assert.deepEqual(positional, ["order-sequence"]);
});

test("value flags still consume their value", () => {
  const { flags, positional } = parseFlags(["--project-name", "Shopfront", "extra"]);
  assert.equal(flags["project-name"], "Shopfront");
  assert.deepEqual(positional, ["extra"]);
});

test("--flag=value form is honored", () => {
  const { flags } = parseFlags(["--type=sequence"]);
  assert.equal(flags.type, "sequence");
});

test("--animate is boolean and leaves a trailing positional alone", () => {
  const { flags, positional } = parseFlags(["push", "--animate"]);
  assert.equal(flags.animate, true);
  assert.deepEqual(positional, ["push"]);
});

test("--force and --json are booleans", () => {
  const { flags, positional } = parseFlags(["order-sequence", "--force", "--json"]);
  assert.equal(flags.force, true);
  assert.equal(flags.json, true);
  assert.deepEqual(positional, ["order-sequence"]);
});

test("--no-diagram does not consume a following positional", () => {
  const { flags, positional } = parseFlags(["--no-diagram", "leftover"]);
  assert.equal(flags["no-diagram"], true);
  assert.deepEqual(positional, ["leftover"]);
});
