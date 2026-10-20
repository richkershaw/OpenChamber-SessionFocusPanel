# OpenChamber Session Focus Panel — build plan

A per-session "focus" card showing what this session is actually doing (the task and
approach, not the subject), the agreed actions in implementation order, kept ticked as
they complete, with links to the tickets/ADRs behind them. The agent keeps it current.

Repo: `richkershaw/OpenChamber-SessionFocusPanel`, from account `richkershaw`.

## Steps

- [x] M0 — Spike the two unknowns: OpenCode v2 plugin tool registration + `event.system` injection; OpenChamber status-section frame + project file access
- [x] M1 — Shared schema and store: read/write `.openchamber/session-focus/<sessionId>.json` with a revision guard, unit tested
- [ ] M2 — Status section renders read-only: focus line, active block, divider, completed block
- [ ] M3 — Status section edits: tick, add action, edit focus, attach a link
- [x] M4 — OpenCode plugin: the six `focus_*` tools and the system-prompt block
- [ ] M5 — Polish: header controls, empty states, no-project state, long-list scroll, `setHeight`
- [x] M6 — README, install steps, tag `v0.1.0`

## Decisions locked

1. **Ordering.** Active items first in implementation order (next at top), then a divider, then completed items. New actions land above the completed block.
2. **Store is project-local.** `.openchamber/session-focus/<sessionId>.json`, gitignored.
3. **Extension + OpenCode plugin.** The extension is the UI; the plugin is the agent-facing half.
4. **Section-only for v1.** A Work Status section, no rail icon, no `page`/`attach`/`actions`/`commands`.

## Why two halves

An OpenChamber extension is a sandboxed page. It can draw UI, read the current
project and session, and write files, but it **cannot register tools for the agent** —
tool calls only come from an OpenCode plugin or MCP server, and the extension can only
style them. So the agent-facing half must be an OpenCode v2 plugin.

The plugin is also the correct home for the "initial system prompt" requirement, and
strictly better than an initial prompt: OpenCode v2 exposes a hook on the assembled
context, so the focus can be present on every model call rather than only the first.

```ts
await ctx.session.hook("context", (event) => {
  event.system.push({ type: "text", text: focusBlock });
});
```

Gate it: inject only when a focus exists for the session. If the per-turn token cost
matters, inject on the first call of a session and whenever the store's `revision`
changed since the last injection.

## Surfaces

- **v1:** `contributes.statusSection` as an object with its own `entry`. No rail icon.
  The card appears in the chat's Work Status panel and in its section chooser, where the
  user can hide or move it.
- **The page is surface-aware from day one.** Branch on `ctx.surface` (`status` vs
  `panel`) at mount, so adding a rail panel later is a manifest change, not a rewrite:
  `statusSection: true` reuses `panel.entry`.
- **Optional add-on, documented not built:** `background.entry` is what unlocks
  `commands` (a `/focus` slash command) and `actions` (session/message menu entries) for
  a package with no `panel.entry`. Ship nothing there in v1.

Consequences of section-only, accepted:

- The frame **runs only while the section is shown and expanded**, so it must rebuild
  everything from the store on mount. No timer state, no cached UI state.
- Height is 24–320px, starting at 220, grown with `host.setHeight()`. Longer lists scroll
  inside the frame.
- `requiresProject: true`, because the store is project-local. With project-local storage
  this is honest: no project, no card, rather than a broken one.
- `contributes.tools` (chat rendering of `focus_*` calls) is not in the excluded list for
  section-only packages; confirm at M0. It is cosmetic either way.

## The store

`.openchamber/session-focus/<sessionId>.json`, relative to the open project, so it needs
only the `files` capability — no `filesystem` patterns, no `OPENCHAMBER_DATA_DIR`
coupling.

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
      "refs": [{ "label": "ADR-0006", "url": "https://..." }],
      "createdAt": 1792400000000,
      "startedAt": 1792400100000,
      "completedAt": 1792400600000
    }
  ],
  "updatedAt": 1792400600000,
  "updatedBy": "agent"
}
```

- `status`: `active` | `done` | `dropped`
- `state`: `todo` | `doing` | `done` (plus `dropped` for a cancelled action)
- `updatedBy`: `agent` | `user`
- Exactly one action may be `doing` at a time; the writer enforces it.

**Ordering.** `actions[]` is stored in implementation order. The UI partitions it for
display — active (`todo`/`doing`) in array order, divider, completed in array order — so
appending a new action puts it just above the divider, and re-prioritising one means
inserting at the front of the active block.

**Concurrency.** Both the panel and the plugin write. Read-modify-write guarded by
`revision`: re-read, compare, apply, write, and retry once on mismatch. Writes are atomic
(`writeFile` writes a temp file and renames).

**Housekeeping.** README documents adding `.openchamber/session-focus/` to `.gitignore`;
offer a button that appends it. Decide later whether finished focus files are pruned.

## The extension

`package.json` manifest (shape, not final):

```json
{
  "name": "openchamber-session-focus-panel",
  "version": "0.1.0",
  "type": "module",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=2.3.0" },
    "contributes": {
      "panel": { "id": "session-focus", "name": "Session Focus", "icon": "icon.svg" },
      "statusSection": {
        "entry": "status/index.html",
        "title": "Session Focus",
        "height": 220,
        "defaultExpanded": true,
        "requiresProject": true
      },
      "capabilities": ["files"]
    }
  }
}
```

`panel` is required as the package identity even with no `entry`; `statusSection` supplies
the visible surface. Capabilities: `files` only — the session id comes from `ctx.session`
and needs no permission. Add `sessions` only if a later feature needs to list sessions.

Behaviour:

- On mount, read the store for `ctx.session.id`; render focus line, progress (`n/m`),
  active block, divider, completed block.
- Tick a box → revision-guarded write, optimistic paint, reconcile on the response.
- Add an action → appended to the active block; inline link field for a ref.
- Edit the focus line in place.
- Empty state: one input that creates the first focus for the session.
- No-project state: nothing (the section hides itself).
- Header controls via `setStatusControls` (up to four): `Copy as prompt`, `Refresh`,
  and later an open-only filter.

## The plugin

`.opencode/plugins/session-focus/index.ts`, `Plugin.define({ id, setup })` from
`@opencode/plugin`. Loaded automatically from `.opencode/plugins/`, or added to `plugins`
in `opencode.json`.

Tools (six):

| Tool | Purpose |
| --- | --- |
| `focus_get` | read focus, status and actions |
| `focus_set` | set or replace the focus sentence; set `status` |
| `focus_add` | add an action; `position: "next" \| "last"` (default `last`) |
| `focus_begin` | mark an action `doing` (by id, or the first `todo`) |
| `focus_complete` | mark an action `done`, with an optional note |
| `focus_link` | attach a `{ label, url }` ref to an action |

`focus_drop` is a likely seventh; leave it until something needs it.

The plugin owns the same JSON file as the panel and writes it directly from the server
process. Tool results return the updated focus so the call renders usefully in chat.

### The injected block

Appended to `event.system` by the `context` hook. This is the "whatever's required in the
initial system prompt" half:

```
## Session Focus panel

This session keeps a focus card in the Work Status panel. Keep it current — it is how a
human sees what this session is doing and what was agreed.

- Focus: one sentence naming the task and the approach, not the subject area. Replace it
  when the task or the approach changes.
- Actions: the agreed steps, in the order they will be implemented. Add them before
  starting work on them.
- Exactly one action is `doing` at a time. Mark it before you start.
- Mark an action `done` the moment it is verified. Never delete one.
- New work agreed mid-flight: add it above the completed items (`focus_add` default).
- Attach the ticket, ADR or PR link to its action as soon as one exists (`focus_link`).
- When the whole task is finished, set the focus status to `done` and stop updating.

Tools: focus_get, focus_set, focus_add, focus_begin, focus_complete, focus_link.

Current focus: "<focus>"
Doing: <action or none>   Open: <n>   Done: <m>
```

The seven bullets are the key events, in the same order as the panel's own legend.

## Repo layout

```
OpenChamber-SessionFocusPanel/
├── package.json           # openchamber manifest
├── icon.svg
├── status/
│   ├── index.html
│   └── main.ts -> main.js # built IIFE; committed for git installs
├── agent/plugin/
│   └── index.ts           # @opencode/plugin
├── shared/
│   └── store.ts           # schema, ordering, revision guard — bundled into both sides
├── scripts/build.mjs
├── tests/
├── docs/                  # screenshots, install notes
└── README.md
```

`shared/store.ts` is the one piece both halves bundle, so the file format cannot drift.
Commit the built `status/main.js`: OpenChamber does not build TypeScript at install time.

## Install (two steps)

1. **Extension** — Settings → Extensions → paste the folder path, zip or git URL; approve
   the `files` capability.
2. **Plugin** — add the folder to `opencode.json` `plugins`, or drop
   `agent/plugin/index.ts` into the project's `.opencode/plugins/`. OpenChamber's
   Settings → OpenCode → Plugins manages both scopes.

Document both in the README; script the dev loop in `scripts/`.

## Spikes and risks (M0)

1. **Exact plugin API.** The v2 docs show `ctx.tool.transform(editor => editor.add(...))`,
   while `Plugin.define` + `Tool.Info` types also suggest a definition form. Pin down the
   real surface against the installed OpenCode **2.0.31**, and the correct package name
   (`@opencode/plugin`).
2. **`event.system` shape** on 2.0.31 — the docs may be ahead of the pinned version.
3. **Tool name as OpenChamber sees it** after namespacing (dots become underscores) and
   whether `contributes.tools` is permitted for a section-only package.
4. **Write races** between panel and plugin — test concurrent writers against the revision
   guard.
5. **Frame reload on collapse/expand** — confirm no flicker and that the mount-time read is
   fast enough.
6. **`requiresProject`** — confirm the section hides cleanly with no project open.

## Out of scope for v1

- Rail panel and full-screen page.
- `background.entry`: `/focus` slash command and session/message actions such as
  "set focus from this message".
- A companion skill for discoverability.
- Auto-resolving refs against GitHub/Linear via OpenChamber integrations.
- Rail badge with the open count; multi-session roll-up.

## Open questions

- Retention: when is a finished focus file pruned, and by what?
- Should `focus_set` overwrite a non-empty focus without confirmation, or require the
  agent to state what it is replacing?
- One file per session, or per session *per project*? Per session id is simplest; a session
  resumed in a different directory will not find its store.
