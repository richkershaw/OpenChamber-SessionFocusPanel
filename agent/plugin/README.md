# @richkershaw/openchamber-session-focus-plugin

The agent half of the [OpenChamber Session Focus panel](https://github.com/richkershaw/OpenChamber-SessionFocusPanel):
seven `focus_*` tools and a short block appended to the system instructions, so an agent keeps
the session's focus card current.

Use this alongside the OpenChamber extension of the same name — the extension is the card, this
is what the agent talks to. Both read and write the same file, so they cannot drift apart.

## Install

Add it to `plugins` in your `opencode.json(c)`, global or per project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@richkershaw/openchamber-session-focus-plugin"]
}
```

Or let OpenCode do it:

```sh
opencode plugin add @richkershaw/openchamber-session-focus-plugin
```

Requires OpenCode 2.x.

## Tools

| Tool | Purpose |
| --- | --- |
| `focus_get` | read the focus, status and actions |
| `focus_set` | set or replace the focus sentence; set the status |
| `focus_add` | add an agreed action, in implementation order |
| `focus_begin` | mark one action in flight |
| `focus_complete` | mark an action done |
| `focus_link` | attach a ticket, ADR or PR link to an action |
| `focus_drop` | mark an action no longer wanted, keeping it visible |

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

`instructions: false` stops the plugin adding its block to the system prompt on each model call.
The tools still work; the agent is simply not reminded to use them every turn. The block is
skipped for a session with no focus yet, so an untouched session costs nothing either way.

## Where the card lives

Per session, inside the project:

```
.openchamber/session-focus/<sessionId>.json
```

Gitignore it. The format is plain JSON and is documented in the
[main README](https://github.com/richkershaw/OpenChamber-SessionFocusPanel#the-store).

## Licence

MIT.
