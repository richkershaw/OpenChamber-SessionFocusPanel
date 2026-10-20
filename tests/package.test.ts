/**
 * The install gate: OpenChamber parses this manifest before it will load the
 * extension, so a manifest that stops parsing is a release blocker. These run
 * against the real `@openchamber/sdk` parser rather than a hand-rolled check.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseManifestJson } from "@openchamber/sdk/schemas";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;

const parsed = parseManifestJson(JSON.stringify(pkg));

test("the manifest parses as an OpenChamber extension", () => {
  assert.equal(parsed.ok, true, parsed.ok ? "" : `${parsed.code}: ${parsed.message}`);
});

test("declares the section surface, and nothing we did not design", () => {
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const contributes = parsed.manifest.contributes;

  assert.equal(contributes.panel.id, "session-focus");
  assert.equal(contributes.panel.entry, undefined, "section-only: no rail page");

  assert.deepEqual(contributes.statusSection, {
    entry: "status/index.html",
    title: "Focus",
    height: 220,
    defaultExpanded: true,
    requiresProject: true,
  });

  // The card only ever reads and writes inside the project.
  assert.deepEqual(contributes.capabilities, ["files"]);

  // Kept deliberately out of v1.
  assert.equal(contributes.page, undefined);
  assert.equal(contributes.attach, undefined);
  assert.equal(contributes.commands, undefined);
  assert.equal(contributes.actions, undefined);
  assert.equal(contributes.service, undefined);
});

test("the required version engine is set", () => {
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.engines?.openchamber, ">=2.3.0");
});

test("everything the manifest points at is committed", () => {
  assert.ok(fs.existsSync(path.join(root, "icon.svg")), "icon.svg");
  assert.ok(fs.existsSync(path.join(root, "status/index.html")), "status/index.html");

  const bundle = path.join(root, "status/main.js");
  assert.ok(fs.existsSync(bundle), "status/main.js — run `npm run build`");
  const js = fs.readFileSync(bundle, "utf8");
  assert.ok(js.length > 5_000, "the bundle looks unbuilt");
  assert.ok(js.includes(".openchamber/session-focus"), "the bundle carries the store path");
  assert.ok(!js.includes("</script>"), "a classic script must not contain a closing script tag");
});

test("the plugin entry point is committed", () => {
  assert.ok(fs.existsSync(path.join(root, "agent/plugin/index.ts")), "agent/plugin/index.ts");
});

test("the store directory is not committed into this repository", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    gitignore.includes(".openchamber/session-focus"),
    true,
    "the README tells users to ignore the store; this repo should too",
  );
});
