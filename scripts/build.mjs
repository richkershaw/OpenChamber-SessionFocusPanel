/**
 * Builds the extension's page. OpenChamber does not install npm dependencies or
 * compile anything at install time, so the bundle is committed.
 *
 *   node scripts/build.mjs [--watch]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, context } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, "status/main.ts")],
  outfile: path.join(root, "status/main.js"),
  bundle: true,
  // The page loads in a sandboxed iframe as a classic script, not a module.
  format: "iife",
  platform: "browser",
  target: ["chrome110", "safari16", "firefox110"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: { js: "/* Built from status/main.ts — run `npm run build` after editing. */" },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching status/main.ts");
} else {
  await build(options);
}
