/**
 * Builds the publishable plugin package.
 *
 * The published artifact has to stand on its own: OpenCode installs the package
 * into its own cache and imports it from there, with no access to this
 * repository. So `shared/store.ts` — the one contract the plugin and the card
 * both implement — is bundled in, rather than imported across folder
 * boundaries as it was when the plugin was only ever loaded from a local path.
 *
 * `@opencode/plugin` is deliberately left external: it is provided by the
 * OpenCode runtime and declared as a dependency of the package, exactly as
 * `opencode-mem` and the other published plugins do it. Inlining it would pin
 * the host's own SDK inside the bundle.
 *
 *   node scripts/build-plugin.mjs [--watch]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, context } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, "agent/plugin/index.ts")],
  outfile: path.join(root, "agent/plugin/dist/index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  external: ["@opencode/plugin"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "/* Built from agent/plugin/index.ts by scripts/build-plugin.mjs — run `npm run build` after editing. */",
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching agent/plugin/index.ts");
} else {
  await build(options);
}
