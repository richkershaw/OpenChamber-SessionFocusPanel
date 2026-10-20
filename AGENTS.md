# AGENTS.md — OpenChamber Session Focus Panel

A per-session focus card for OpenChamber, plus the OpenCode plugin that keeps it current: what the
session is doing, the agreed actions in implementation order, ticked off as they complete, with
links to the tickets and ADRs behind them.

## General guidance

* Try and be concise without losing detail - terse communication is fine, provided you do not remove crucial information.
* If you find yourself trying to guess any of my intentions that are unclear, always ask early unless there is an easily discernible single conclusion.
* Favour presenting me with viable options as you currently do, unless the investigation will be lengthy and complex. In that case, ask me for approval to explore options first.

## Package manager

**`npm`, with Node 24** — no bun (the OpenChamber SDK docs suggest it; it is not installed here),
no yarn, no pnpm. `npm test` runs `.ts` files directly and relies on Node's unflagged type
stripping, so 23.6 is the real floor regardless of what `engines` claims.

## Commands

```bash
npm install
npm run check             # typecheck → build both halves → tests. The gate before every commit.
npm run build             # both built artifacts (both are committed — see invariants)
npm run build:extension   # status/main.js only
npm run build:plugin      # agent/plugin/dist/index.js only
npm test                  # node --test tests/*.test.ts
npm run publish:plugin    # builds the plugin, then publishes it to npm
```

## Architecture

Two halves over one file. An OpenChamber extension is a sandboxed page: it can draw UI and read and
write files, but it **cannot register tools for the agent** — only an OpenCode plugin or MCP server
can, and the extension can merely style the calls they produce. So the agent-facing half has to be
a plugin, and the extension is the UI.

| | |
|---|---|
| `status/` | the OpenChamber extension — the card in the chat's Work Status panel. `main.ts` → `main.js` (IIFE, committed). |
| `agent/plugin/` | the OpenCode v2 plugin — the `focus_*` tools and the system-prompt block. `index.ts` → `dist/index.js` (ESM, committed), published as `@richkershaw/openchamber-session-focus-plugin`. |
| `shared/store.ts` | the one contract both bundle, so the file format cannot drift between the two writers. |

**The store.** One JSON file per session, inside the project:
`.openchamber/session-focus/<sessionId>.json` (gitignored). `revision` counts writes.
`applyMutation` re-reads immediately before writing, verifies after, and replays the change on top
of a competing writer's copy. It is deliberately *not* compare-and-swap — read that comment before
changing it, and keep the mutation functions pure since they can run more than once.

**Display rule.** `actions[]` is held in implementation order. The card partitions it for display
into active first (next at the top), then a divider, then completed items — so an appended action
lands at the bottom of the active block, above the completed ones. `position: "next"` puts it at
the top of the active block instead.

**The agent contract.** `Plugin.define({ id, setup })` from `@opencode/plugin`;
`ctx.tool.transform((editor) => editor.add(...))` registers tools; `ctx.session.hook("context", …)`
appends to `event.system`, which is how the agent is told the focus and when to update it. The
plugin is pinned to the OpenCode version it was verified against — check `@opencode/plugin` in
`agent/plugin/package.json` before changing the API surface.

## Invariants

- **`shared/store.ts` stays dependency-free.** It is bundled into a browser IIFE *and* a Node ESM
  bundle, and run directly by the test suite.
- **The plugin bundle must not reach outside its own package.** `@opencode/plugin` stays external
  (the host provides it) and is declared as a dependency. `tests/plugin-package.test.ts` enforces
  both, so a regression fails the build rather than the install.
- **Both built artifacts are committed.** Neither host builds at install time: OpenChamber installs
  no npm dependencies for extensions, and OpenCode imports the package from its own cache with no
  access to this repository.
- **Exactly one action is `doing`** at a time, enforced in the store. Actions are never deleted,
  only dropped, so the decision stays visible.
- **TypeScript has to run under `node --test`.** No enums or namespaces; relative imports need an
  explicit `.ts` extension; type-only imports need `import type`.
- The section header reads `statusSection.title` in the root `package.json` — not the page's
  `<title>`, which nothing displays. Renaming the header is a manifest change, and needs a
  reinstall of the extension before it shows.

## Post-coding workflow

Every change, without exception:

1. **Gate.** `npm run check` must be green — typecheck, both builds, all tests.
2. **Rebuild whatever you touched.** `status/main.ts` or `shared/store.ts` → `npm run build:extension`.
   `agent/plugin/index.ts` or `shared/store.ts` → `npm run build:plugin`. (`status/index.html` is
   served as-is and needs no build.) Commit the rebuilt artifact **in the same commit** as the
   source, never separately. To check whether a bundle is stale, rebuild and look at `git status`:
   unchanged means it was in sync.
3. **Version only what changed.** The two halves version independently — the extension in the root
   `package.json`, the plugin in `agent/plugin/package.json`. Bump with
   `npm version <v> --no-git-tag-version` (and `npm --prefix agent/plugin version …` for the
   plugin), and note the change under `## Unreleased` in `CHANGELOG.md`.
4. **Commit** with a message that says *why*. The diff already says what.
5. **Push to `main`.** There is no PR flow in this repository — commit and push directly.
6. **Tag** (`v<x.y.z>`) only when asked or when cutting a release. Tags are annotated and pushed
   with `--follow-tags`.
7. **Publish the plugin only when the plugin changed**, and only when asked. Extension changes need
   no publish — it is installed from the folder, so a rebuild plus a section reload is enough.
   `npm run publish:plugin` builds first, then publishes `--access public` (required for a scoped
   package to be publicly visible). Publishing needs `npm login` and access to the `@richkershaw`
   scope.
8. **Never commit** `.openchamber/session-focus/`, `.opencode/index/` or `node_modules/`. All three
   are gitignored deliberately: the first is per-session state, the second is OpenCode's runtime
   index, the third is dependencies.

## Trying it locally

- **Extension.** OpenChamber → **Settings → Extensions** → add this folder (or its git URL) →
  approve **files**. A folder install runs from the working copy, so a rebuild is picked up on
  reload; collapse and reopen the **Focus** section, or reload the tab. It only appears in sessions
  with a project open, because the store lives in the project.
- **Plugin.** Point `plugins` in `opencode.json(c)` at `agent/plugin`, or at the published package
  name. Restart OpenCode if the tool list does not refresh.
- **Card without a UI.** The store is plain JSON, so you can write one by hand and read it back:
  `shared/store.ts` is the contract, and `npm test` exercises it directly.

## Detailed guides

| Topic | File |
|---|---|
| What it is, install, the store format, known limits | `README.md` |
| Release notes per version | `CHANGELOG.md` |
| The build plan and the decisions behind the design | `docs/session-focus-panel-plan.md` |
| The store contract — read this before changing the format | `shared/store.ts` |
| The agent-facing surface — tool descriptions and the prompt block | `agent/plugin/index.ts` |

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `richkershaw/OpenChamber-SessionFocusPanel`. There are no
triage labels or domain docs in this repository, and no ADR directory — the decision record is
`docs/session-focus-panel-plan.md` plus the commit history.
