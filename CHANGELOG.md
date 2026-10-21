# Changelog

## 0.3.0 — 2026-10-21

### Fixed

- **The card now works in a session that has never used it.** The prompt block was skipped whenever
  the card was empty, on the reasoning that it saved tokens. A fresh session therefore received no
  instructions at all: the agent saw only the tool catalogue and the card went unused — the
  sessions that most needed telling were the ones never told.
- `focus_get` answers an empty card with the workflow and the state list, rather than a one-line
  refusal. It is the one `focus_*` tool whose description the catalogue always showed, so its
  answer has to carry the instructions.

### Changed

- An empty card ends the prompt block with an explicit invitation to start one, instead of a bare
  `Focus: (not set)`.
- All eight tools are declared `pinned`, so their descriptions and schemas appear in the tool
  catalogue rather than collapsing into a `focus (8 tools, 1 shown)` summary. The operational detail
  lives in those descriptions; summarising them away is what stopped them being read.
- The namespace description reads as an instruction — *"Maintain this session's focus card: set the
  status at each phase, tick actions off as they land…"* — rather than a label, since it is the only
  sentence always visible.

### Notes

- The block is roughly 450 tokens on every model call, in every session, including ones that never
  touch the card. That is the cost of the fix, and `options.instructions: false` remains the
  explicit opt-out.

## 0.2.0 — 2026-10-20

### Added

- A **status**: what is happening right now, as a state from a fixed vocabulary plus an optional
  detail. Ten states — `planning`, `implementing`, `testing`, `reviewing`, `waiting-decision`,
  `waiting-manual`, `waiting-external`, `blocked`, `idle`, `done` — each with its own glyph, tone
  and motion.
- **Motion says whether work is really happening.** Only the four working states loop, and only
  while the session is genuinely busy: a status claiming to be working while the session is idle
  is drawn static, and its age keeps counting, so a forgotten status looks forgotten. The two
  waiting-on-you states pulse rather than spin — nothing is progressing there. All motion is
  suppressed under `prefers-reduced-motion`, and no state relies on it alone.
- **You can set it too.** Clicking the status row opens the state list and an editable detail, and
  offers a Clear. A status the agent forgot is fixable without prompting it.
- `focus_status` for the agent, and the prompt block's state list is generated from the same table
  the card draws, so the two cannot drift.

### Changed

- The store's task lifecycle is renamed **`lifecycle`**, freeing **`status`** for the activity.
  A v1 document is migrated by shape rather than by version number, so a `done` task does not
  revert to `active`, and the two halves can be at different versions without loss.
- The plugin's prompt block is titled `## Focus` rather than `## Session Focus`, matching the
  section.
- `focus_set`'s `status` parameter is now `lifecycle` — a breaking change to that tool, which is
  why the plugin goes to 0.2.0.

### Packaging

- The OpenCode plugin is now a **standalone publishable package**,
  `@richkershaw/openchamber-session-focus-plugin`, so installing the agent half is one line in
  `plugins` instead of an absolute path into this repository.
- The published bundle carries **its own copy of `shared/store.ts`** rather than importing
  across folder boundaries, so the package works with this repository out of the picture.
  `@opencode/plugin` stays a declared dependency, matching how the other published plugins do it.
- `npm run build` now builds both halves, and `npm run publish:plugin` builds and publishes the
  package. Both built artifacts are committed.
- Verified by packing the package, extracting it with no repository in reach, installing only
  its declared dependency, and driving a real agent turn through it.

### Changed

- The Work Status section is now titled **Focus** rather than **Session Focus**. The extension
  keeps the longer name on the Extensions card.
- The card no longer repeats a **FOCUS** label above the sentence — the section header already
  names it, so the sentence is now the first thing in the card.
- The focus sentence grows to fit its contents instead of scrolling inside a two-line box. Two
  things were wrong: the field was capped at 96px, and it was measured while detached, so
  `scrollHeight` read as 0 on every re-render and the CSS `min-height` took over.

## 0.1.0 — 2026-10-20

First release. A per-session focus card for OpenChamber, and the OpenCode plugin that keeps
it current.

### The card

- A **Session Focus** section in the chat's Work Status panel: one focus line naming the task
  and the approach, the agreed actions, and a `n / m done` count.
- Active actions first in implementation order, then a divider, then the completed ones — kept
  rather than removed, so the session's history stays visible. A newly agreed action lands
  above the completed block.
- A tick cycles an action **outstanding → in flight → done → outstanding**. At most one action
  is in flight at a time; starting a new one returns the previous one to outstanding.
- Attach a ticket, ADR or PR link to any action; the chip opens it in your browser.
- Two header controls: **Copy as prompt** renders the whole card as Markdown onto the
  clipboard, and **Refresh** re-reads the file.
- The frame follows its content between 24 and 320px, and the section hides itself when no
  project is open (the store lives in the project).

### The agent

- An OpenCode v2 plugin registering `focus_get`, `focus_set`, `focus_add`, `focus_begin`,
  `focus_complete`, `focus_link` and `focus_drop`.
- A short block appended to the system instructions on every model call: what the focus is,
  and the seven events at which to keep it current. It is skipped entirely for a session with
  no focus yet, so an untouched session pays nothing. Set `options.instructions: false` to
  turn it off while keeping the tools.
- Every tool returns the rendered card, so a call reads usefully in the transcript.

### The store

- One JSON file per session at `.openchamber/session-focus/<sessionId>.json`, keyed by session
  and stored in the project. Gitignore it.
- `shared/store.ts` is bundled by both halves, so the format cannot drift between the card and
  the plugin.
- Writes carry a lost-update guard: the file is re-read immediately before writing and again
  after, and only contents from that call count as a win — anything else replays the change on
  top of the other writer's copy. See `applyMutation` for what it does and does not cover.
- A missing, malformed or hand-mangled file reads as empty rather than throwing.

### Notes and limits

- **Section-only.** No rail panel and no full-screen page. `contributes.background.entry` is
  the documented route to a `/focus` command and session-menu actions without one.
- Requires **OpenChamber 2.3.0** or newer and **OpenCode 2.x**.
- The host unloads the frame when the section is collapsed, so the card rebuilds from the file
  on each mount. It polls every 2.5s while visible, so an agent update appears within a few
  seconds.
- A session moved to another directory does not take its store with it.
- Nothing prunes finished focus files yet.

### Verified against

`@openchamber/sdk` 2.3.x and OpenCode **2.0.31** (`@opencode/plugin` 2.0.31 — the version
matching the installed server). 33 tests cover the store contract and drive the plugin's real
`setup` against a stand-in host context; the manifest is validated with the SDK's own parser,
so a manifest that would fail to install fails the build. Also exercised end to end in a real
OpenCode server, and installed in a live OpenChamber instance.
