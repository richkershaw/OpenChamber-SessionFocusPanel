/**
 * Guards the publishable plugin package.
 *
 * The published artifact is what people install, and it has to stand on its own:
 * OpenCode copies the package into its own cache and imports it from there, with
 * no access to this repository. So the built bundle — not the source next to it —
 * is what these tests load and drive.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageDir = path.join(root, "agent/plugin");
const bundlePath = path.join(packageDir, "dist/index.js");

const manifest = JSON.parse(
  fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
) as Record<string, any>;

test("the plugin package is publishable", () => {
  assert.equal(manifest.name, "@richkershaw/openchamber-session-focus-plugin");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.equal(manifest.private, undefined, "a private package cannot be published");
  assert.deepEqual(manifest.files, ["dist", "README.md"]);
  assert.equal(manifest.license, "MIT");
});

test("the SDK is a dependency, not something we ship", () => {
  // OpenCode provides @opencode/plugin at runtime; the package declares it so
  // it resolves, exactly as the other published plugins do.
  assert.ok(manifest.dependencies["@opencode/plugin"], "declared as a dependency");
});

test("the built bundle exists and is committed", () => {
  assert.ok(fs.existsSync(bundlePath), "agent/plugin/dist/index.js — run `npm run build`");
  assert.ok(fs.statSync(bundlePath).size > 5_000, "the bundle looks unbuilt");
});

test("the bundle stands alone", () => {
  const js = fs.readFileSync(bundlePath, "utf8");
  assert.equal(js.includes("../../shared"), false, "no import may reach out of the package");
  assert.ok(js.includes("applyMutation"), "the store contract is bundled in");
  assert.ok(js.includes("focus_get") || js.includes('name: "get"'), "the tools are bundled in");
  // The host's own SDK must stay external, or the bundle would pin it.
  assert.ok(
    /from\s*"@opencode\/plugin"/.test(js),
    "@opencode/plugin is left as an external import",
  );
});

test("the bundle loads and exports a working plugin", async () => {
  const loaded = (await import(bundlePath)) as { default?: { id?: string; setup?: unknown } };
  assert.ok(loaded.default, "default export");
  assert.equal(loaded.default.id, "session-focus");
  assert.equal(typeof loaded.default.setup, "function");
});
