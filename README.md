# OpenChamber Session Focus Panel

**Important:** This extension needs its companion plugin (see `Install` below).

A per-session focus card for [OpenChamber](https://openchamber.dev). It sits in the chat's
Work Status panel and answers one question at a glance: **what is this session doing, and
what did we agree to do about it?**

- A **focus** line — the task and the approach, not the subject area.
- A **status**: what is happening right now, with a glyph that moves only while it really is.
- The **agreed actions**, in the order they will be implemented.
- **Ticked off as they complete** and kept, so the session's history stays visible.
- **Links** to the ticket, ADR or PR behind an action, where one exists.
- Kept current **by the agent**, through tools it is told to use at named points in the work.

```
  Wire the focus panel to the plugin tools and prove a round-trip.

  ◐ Implementing: the Status field and its icons · 4m

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

The card appears in the chat's **Work Status** panel, as a section titled **Focus**. If you do
not see it, open that panel's section chooser and enable it. It hides itself when no project is
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
  "version": 2,
  "sessionId": "ses_...",
  "revision": 7,
  "focus": "Wire the focus panel to the plugin tools and prove a round-trip.",
  "lifecycle": "active",
  "status": {
    "state": "implementing",
    "detail": "the Status field and its icons",
    "since": 1792400100000
  },
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

Three fields, and the naming is deliberate:

- `focus` — the high-level aim: what this session is for.
- `status` — what is happening right now: `state` from the ten below, an optional `detail`, and
  `since`, when that state began. Absent until someone sets one. `since` only moves when the
  state changes, so a stuck status is visible as an age.
- `lifecycle` — `active`, `done` or `dropped`: the state of the task itself, set by `focus_set`.

Also `state` on each action is `todo`, `doing`, `done` or `dropped`, with **at most one action
`doing`**; `actions` is held in implementation order, and the card partitions it for display —
active items first, then a divider, then completed items, so an action added now appears **above**
the completed ones. `updatedBy` says whether the last write came from `agent` or `user`.

A half-written or hand-mangled file is never fatal: an unreadable document reads as empty
rather than throwing.

> **Upgrading from 0.1.0.** Version 1 wrote the task lifecycle into `status` as a string.
> `parseDoc` migrates that by *shape* rather than by version number — a leftover
> `"status": "active"` is read as the lifecycle and the activity is left unset — so the two
> halves can be at different versions without a `done` task reverting to `active`.

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

The plugin appends this to the system instructions on **every model call, including when the card
is empty**, with the live state below it:

- **Focus**: one sentence naming the task and the approach. Replace it when either changes.
- **Status**: what is happening right now, from the ten below. Set it at the start of a phase, move
  it as you move between phases, and set `waiting-decision` **before** you ask the question.
- **Actions**: the agreed steps, in implementation order. Add them before starting work.
- **Exactly one action in flight** at a time. Mark it before starting.
- Mark an action **done the moment it is verified**. Never delete one.
- **New work agreed mid-flight**: add it above the completed items.
- **Attach the ticket, ADR or PR link** as soon as one exists.
- When the whole task is finished, set the status to `done` and stop updating.

An empty card ends with an explicit invitation to start one, and `focus_get` answers with the
workflow rather than a one-line refusal — that tool is the entry point for an agent that has only
seen the tool catalogue.

> **Why it is never gated.** An earlier version skipped the block when the card was empty, on the
> reasoning that it saved tokens. That was a cold-start hole: a fresh session received no
> instructions at all, so the agent saw only the catalogue and the card went unused — the sessions
> that most needed telling were the ones never told. `options.instructions: false` is the explicit
> way out if you do not want the cost.

All eight tools are also declared `pinned`, so their descriptions and schemas appear in the tool
catalogue instead of collapsing into a `focus (8 tools, 1 shown)` summary — the detail lives in
those descriptions, and summarising them away is what stopped it being read.

The status states it is offered, generated from the same table the card draws, so the two cannot
drift:

| State | Means | Motion |
| --- | --- | --- |
| `planning` | working out the approach; nothing written yet | loop |
| `implementing` | writing code | loop |
| `testing` | running tests, checks or a build | loop |
| `reviewing` | reading a diff, a report, or existing code | loop |
| `waiting-decision` | blocked on a choice only you can make | attention |
| `waiting-manual` | blocked on a click, an install or an approval | attention |
| `waiting-external` | waiting on CI, a deploy or a long job | static |
| `blocked` | stuck on a failure or a missing dependency | static |
| `idle` | between turns; nothing in flight | static |
| `done` | the task is finished | static |

### Tools

| Tool | Purpose |
| --- | --- |
| `focus_get` | read the focus, status and actions |
| `focus_set` | set or replace the focus sentence; set the task lifecycle |
| `focus_status` | say what is happening right now (`state`, optional `detail`) |
| `focus_add` | add an action (`position: "next" \| "last"`) |
| `focus_begin` | mark an action in flight |
| `focus_complete` | mark an action done |
| `focus_link` | attach a ticket, ADR or PR link to an action |
| `focus_drop` | mark an action no longer wanted, keeping it visible |

Ids can be omitted on `focus_begin` and `focus_complete`: they take the action in flight,
or else the first outstanding one. Every tool returns the rendered card, so the call reads
usefully in the transcript.

## Using the card

The **status** line is the agent's to keep honest, but yours to correct: click it to open the
state list and add or change the detail, or to clear it. A state that claims work is progressing
only animates while the session is genuinely busy — a forgotten status stops moving and its age
keeps counting, so a stale one looks stale.

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
`@openchamber/sdk` parser (`tests/package.test.ts`), check that the built plugin package is
self-contained and loadable (`tests/plugin-package.test.ts`), and drive the card's rendering
against a fixture document in **happy-dom** (`tests/card.test.ts`).

That last one is the point of `status/card.ts`: the card is split into rendering (which knows
nothing about the host and is testable) and `status/main.ts` (the wiring). Two bugs in the card
were found by eye before it existed, and both would have been caught here.

The build plan and the decisions behind the design are in
[`docs/session-focus-panel-plan.md`](./docs/session-focus-panel-plan.md).

Two things run in CI: **`check.yml`** on every push to `main` — the same gate, publishing nothing —
and **`release.yml`** on a `v*` tag, which re-runs it and then publishes the plugin. See below.

### Releasing

The extension and the plugin ship separately out of this one repository. **The plugin is published
from GitHub Actions using npm's Trusted Publishing** — there is no npm token anywhere, on this
machine or in the repo.

```bash
# Bump whichever halves changed, and note it under ## Unreleased in CHANGELOG.md.
npm version minor --no-git-tag-version
npm --prefix agent/plugin version minor --no-git-tag-version

npm run check                        # green before you tag
git commit -am "Release x.y.z"
git tag vX.Y.Z && git push --follow-tags   # the tag is what publishes
```

Pushing the tag runs `.github/workflows/release.yml`, which re-runs the full gate, proves the
committed bundles match their sources, checks the tag against the version being published, and
then publishes `agent/plugin`. The extension needs nothing beyond that — it is installed from this
repository or its git URL.

**One-time setup on npm**, without which the workflow cannot authenticate. Register the workflow as
the package's trusted publisher — the CLI is the reliable way, since it cannot mis-type the
filename that has to match:

```bash
npm trust github @richkershaw/openchamber-session-focus-plugin \
  --file release.yml \
  --repo richkershaw/OpenChamber-SessionFocusPanel \
  --allow-publish
```

It asks for a one-time password. Then confirm, and keep the id it prints — that is what
`npm trust revoke` takes:

```bash
npm trust list @richkershaw/openchamber-session-focus-plugin
```

The same thing exists as a form on the package's settings page at
`npmjs.com/package/@richkershaw/openchamber-session-focus-plugin/access`, but every field has to
match the workflow exactly, and a mismatch comes back from the registry as a **404** rather than an
auth error — worth knowing before you go looking in the wrong place.

`npm pack ./agent/plugin` still shows exactly what would ship — `package.json`, `README.md` and
`dist/index.js`, with `@opencode/plugin` declared as a dependency rather than bundled in.

### Publishing by hand

Now a fallback rather than the normal path, and it needs a token that npm will keep asking for a
one-time password, because `npm publish` from a machine has no OIDC identity to present:

```bash
npm run publish:plugin
```

## Known limits

- **Section-only.** There is no rail panel and no full-screen page; the card lives in the
  Work Status panel and scrolls inside it past 320px.
- The host unloads the frame when the section is collapsed, so the card rebuilds from the
  file on every mount. It polls every 2.5s while visible, so an agent update appears within
  a few seconds.
- Motion is the only cue that something is moving, and it is deliberately suppressed under
  `prefers-reduced-motion: reduce`. Every state still carries its glyph, its word and its tone,
  so nothing is conveyed by animation alone.
- A session that moves to another directory does not take its store with it — the file is
  keyed by session but stored in the project.
- Nothing prunes finished focus files yet.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Licence

MIT.
