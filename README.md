# OpenChamber Session Focus Panel

A per-session focus card for [OpenChamber](https://openchamber.dev). It sits in the chat's
Work Status panel and answers one question at a glance: **what is this session doing, and
what did we agree to do about it?**

- A **focus** line — the task and the approach, not the subject area.
- The **agreed actions**, in the order they will be implemented.
- **Ticked off as they complete** and kept, so the session's history stays visible.
- **Links** to the ticket, ADR or PR behind an action, where one exists.
- Kept current **by the agent**, through tools it is told to use at named points in the work.

```
FOCUS
  Wire the focus panel to the plugin tools and prove a round-trip.

  3 / 5 done
  ████████████░░░░░░░░

  ▸ first action          ← next to implement, top of the list
  ▸ second action
  ▸ third action   (#42) (ADR-0007)
  ────────────── done ──────────────
  ✓ define the per-session store format   (ADR-0006)
  ✓ panel shell reads the store
  ✓ revision-guarded writes from the panel
```

## Why two halves

An OpenChamber extension is a sandboxed page. It can draw UI and read and write files, but
it cannot register tools for the agent. So this repository is two cooperating pieces over
one file:

| | |
|---|---|
| **`status/`** | the OpenChamber extension — the card in the Work Status panel |
| **`agent/plugin/`** | an OpenCode v2 plugin — the `focus_*` tools, and the system-prompt block |
| **`shared/store.ts`** | the file format both bundle, so the two writers cannot drift |

The plugin is also what makes the agent reliably keep it current: it appends a short block
to the system instructions on every model call, so the agent always knows the focus and
when to update it. (Set `options.instructions: false` to turn that off — see
[Configuration](#configuration).)

## Install

Two steps. The extension is the card; the plugin is what the agent talks to.

### 1. The extension

In OpenChamber: **Settings → Extensions**, then paste the path to this folder (or a git URL
for it) and choose **Add**. Approve the **files** permission — the card reads and writes the
focus file inside your project.

The card appears in the chat's **Work Status** panel. If you do not see it, open that
panel's section chooser and enable **Session Focus**. It hides itself when no project is
open, because the store lives in the project.

### 2. The plugin

Add it to `plugins` in your OpenCode configuration — the project's `opencode.json(c)`, or the
global one under `~/.config/opencode`:

```jsonc
{
  "plugins": ["@richkershaw/openchamber-session-focus-plugin"]
}
```

Or let OpenCode install it for you:

```sh
opencode plugin add @richkershaw/openchamber-session-focus-plugin
```

OpenChamber's **Settings → OpenCode → Plugins** manages both scopes if you would rather do it
there. Point it at the project or the global config depending on whether you want the focus
card in one repository or everywhere.

<details>
<summary>Installing from this repository instead (developing it)</summary>

Point `plugins` at the built package in this folder, or at the local path if you prefer to run
from source:

```jsonc
{ "plugins": ["/absolute/path/to/OpenChamber-SessionFocusPanel/agent/plugin"] }
```

That path works either way: `agent/plugin/package.json` resolves to `dist/index.js`, which is
built and committed, and the bundle carries its own copy of the store contract. Run
`npm run build:plugin` after editing `agent/plugin/index.ts` or `shared/store.ts`.

</details>

### Tell your projects not to commit the store

```gitignore
.openchamber/session-focus/
```

## The store

One JSON file per session, inside the project:

```
.openchamber/session-focus/<sessionId>.json
```

```json
{
  "version": 1,
  "sessionId": "ses_...",
  "revision": 7,
  "focus": "Wire the focus panel to the plugin tools and prove a round-trip.",
  "status": "active",
  "actions": [
    {
      "id": "a1",
      "text": "Define the per-session store format",
      "state": "done",
      "refs": [{ "label": "ADR-0006", "url": "https://example.com/adr/6" }],
      "createdAt": 1792400000000,
      "startedAt": 1792400100000,
      "completedAt": 1792400600000
    }
  ],
  "updatedAt": 1792400600000,
  "updatedBy": "agent"
}
```

- `status` is `active`, `done` or `dropped` — the state of the session's task.
- `state` is `todo`, `doing`, `done` or `dropped`. **At most one action is `doing`.**
- `actions` is held in implementation order. The card partitions it for display: active
  items first, then a divider, then completed items — so an action added now appears **above**
  the completed ones.
- `updatedBy` says whether the last write came from `agent` or `user`.

A half-written or hand-mangled file is never fatal: an unreadable document reads as empty
rather than throwing.

### Concurrency

The card and the plugin both write, so `shared/store.ts` re-reads immediately before
writing, and re-reads immediately after — only contents that came from that call count as
a win, and anything else replays the change on top of the other writer's copy. See
`applyMutation`.

It is not a compare-and-swap: a write landing in the gap between the pre-write read and the
write itself is invisible, and the later of the two wins. That window is sub-millisecond
and the card only writes when a human ticks something, so it is left to the file system
rather than a lock.

## What the agent is told

The plugin appends this to the system instructions on each model call, with the live state
below it:

- **Focus**: one sentence naming the task and the approach. Replace it when either changes.
- **Actions**: the agreed steps, in implementation order. Add them before starting work.
- **Exactly one action in flight** at a time. Mark it before starting.
- Mark an action **done the moment it is verified**. Never delete one.
- **New work agreed mid-flight**: add it above the completed items.
- **Attach the ticket, ADR or PR link** as soon as one exists.
- When the whole task is finished, set the status to `done` and stop updating.

### Tools

| Tool | Purpose |
| --- | --- |
| `focus_get` | read the focus, status and actions |
| `focus_set` | set or replace the focus sentence; set the status |
| `focus_add` | add an action (`position: "next" \| "last"`) |
| `focus_begin` | mark an action in flight |
| `focus_complete` | mark an action done |
| `focus_link` | attach a ticket, ADR or PR link to an action |
| `focus_drop` | mark an action no longer wanted, keeping it visible |

Ids can be omitted on `focus_begin` and `focus_complete`: they take the action in flight,
or else the first outstanding one. Every tool returns the rendered card, so the call reads
usefully in the transcript.

## Using the card

Click an action's tick to move it **outstanding → in flight → done → outstanding**. A new
action goes in the field at the bottom and lands above the completed block. The link button
on a row attaches a reference. Two buttons sit in the section header: **Copy as prompt**
puts the whole card on the clipboard as Markdown, and **Refresh** re-reads the file.

The store is plain JSON, so you can edit it by hand, keep it open in an editor, or read it
from a script. Nothing depends on OpenChamber being the only writer.

## Configuration

```jsonc
{
  "plugins": [
    {
      "package": "@richkershaw/openchamber-session-focus-plugin",
      "options": { "instructions": false }
    }
  ]
}
```

`instructions: false` stops the plugin adding the block to the system prompt. The tools
still work; the agent just is not reminded to use them each turn.

## Development

```bash
npm install
npm run check     # typecheck, build both halves, run the tests
npm run build     # rebuild status/main.js and agent/plugin/dist/index.js
```

Two built artifacts are committed, because neither host builds at install time: the card's
`status/main.js` (OpenChamber installs no npm dependencies for extensions) and the plugin's
`agent/plugin/dist/index.js` (OpenCode imports the package from its own cache, with no access
to this repository).

The tests cover the store contract (`tests/store.test.ts`), drive the plugin's real `setup`
against a stand-in host context (`tests/plugin.test.ts`), validate the manifest with the real
`@openchamber/sdk` parser (`tests/package.test.ts`), and check that the built plugin package is
self-contained and loadable (`tests/plugin-package.test.ts`).

The build plan and the decisions behind the design are in
[`docs/session-focus-panel-plan.md`](./docs/session-focus-panel-plan.md).

### Releasing

The two halves publish separately out of this one repository.

```bash
# The extension: bump the root version, rebuild, tag.
npm version minor --no-git-tag-version
npm run build
git commit -am "Release x.y.z"
git tag vX.Y.Z && git push --follow-tags

# The plugin package.
cd agent/plugin && npm version minor --no-git-tag-version && cd -
npm run publish:plugin      # builds, then npm publish ./agent/plugin --access public
```

`npm publish` needs `npm login` and access to the `@richkershaw` scope. `npm pack ./agent/plugin`
shows exactly what would ship — `package.json`, `README.md` and `dist/index.js`, with
`@opencode/plugin` declared as a dependency rather than bundled in.

## Known limits

- **Section-only.** There is no rail panel and no full-screen page; the card lives in the
  Work Status panel and scrolls inside it past 320px.
- The host unloads the frame when the section is collapsed, so the card rebuilds from the
  file on every mount. It polls every 2.5s while visible, so an agent update appears within
  a few seconds.
- A session that moves to another directory does not take its store with it — the file is
  keyed by session but stored in the project.
- Nothing prunes finished focus files yet.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Licence

MIT.
