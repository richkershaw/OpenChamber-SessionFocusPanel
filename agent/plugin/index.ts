/**
 * Session Focus — the agent's half.
 *
 * Registers the `focus_*` tools and appends a short block to the system
 * instructions on each model call, so the agent always knows what this session
 * is doing and what was agreed.
 *
 * Install: point `plugins` in `opencode.json(c)` at this folder, e.g.
 *
 *   { "plugins": ["/absolute/path/OpenChamber-SessionFocusPanel/agent/plugin"] }
 *
 * The `../../shared/store.ts` import is deliberate: the plugin and the
 * OpenChamber card bundle the same contract, so the file format cannot drift.
 * Keep the repository together when installing.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { Plugin } from "@opencode/plugin";

import {
  ACTIVITY,
  ACTIVITY_STATES,
  addAction,
  applyMutation,
  beginAction,
  completeAction,
  currentAction,
  displayOrder,
  dropAction,
  formatElapsed,
  linkRef,
  isEmpty,
  parseDoc,
  progress,
  serializeDoc,
  setActivity,
  setFocus,
  storePath,
  type ActivityState,
  type FocusAction,
  type FocusDoc,
  type Lifecycle,
  type Writer,
} from "../../shared/store.ts";

const WRITER: Writer = "agent";

/** Tool input schemas are plain JSON Schema. */
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const text = (description: string) => ({ type: "string", description });

/* ------------------------------------------------------------------- store */

const fileFor = (directory: string, sessionId: string): string =>
  path.join(directory, storePath(sessionId));

const writeAtomic = async (file: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
};

const makeStore = (directory: string, sessionId: string) => {
  const file = fileFor(directory, sessionId);
  const read = async (): Promise<string | undefined> => {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const write = (content: string) => writeAtomic(file, content);
  const load = async (): Promise<FocusDoc> => parseDoc(await read(), sessionId);
  return { read, write, load };
};

/* -------------------------------------------------------------- formatting */

const render = (doc: FocusDoc, now: number = Date.now()): string => {
  const { done, total } = progress(doc);
  const doing = currentAction(doc);
  const lines: string[] = [];
  lines.push(`Focus: ${doc.focus || "(not set)"}  [${doc.lifecycle}]  ${done}/${total} done`);
  if (doc.status) {
    const detail = doc.status.detail ? `: ${doc.status.detail}` : "";
    lines.push(`Status: ${ACTIVITY[doc.status.state].label}${detail} (${formatElapsed(now - doc.status.since)})`);
  } else {
    lines.push("Status: (not set)");
  }
  const { active, completed } = displayOrder(doc);
  if (active.length) {
    lines.push("", "Active:");
    for (const action of active) {
      const mark = action.state === "doing" ? ">" : " ";
      const refs = action.refs.length ? `  (${action.refs.map((r) => `${r.label} ${r.url}`).join(", ")})` : "";
      lines.push(`  [${mark}] ${action.id}  ${action.text}${refs}`);
    }
  }
  if (completed.length) {
    lines.push("", "Done:");
    for (const action of completed) {
      const mark = action.state === "dropped" ? "-" : "x";
      const refs = action.refs.length ? `  (${action.refs.map((r) => `${r.label} ${r.url}`).join(", ")})` : "";
      lines.push(`  [${mark}] ${action.id}  ${action.text}${refs}`);
    }
  }
  if (doing) lines.push("", `In flight: ${doing.id} — ${doing.text}`);
  return lines.join("\n");
};

/**
 * The block appended to the system instructions. The bullets are the events at
 * which the agent is expected to keep the card current. The state list is
 * generated from the vocabulary, so what the agent is offered and what the card
 * draws cannot drift apart.
 */
const instructions = (doc: FocusDoc, now: number = Date.now()): string => {
  const lines: string[] = [
    "## Focus",
    "",
    "This session keeps a focus card in the Work Status panel. Keep it current — it is how a",
    "human sees what this session is doing and what was agreed.",
    "",
    "- Focus: one sentence naming the task and the approach, not the subject area. Replace it when",
    "  the task or the approach changes.",
    "- Status: what is happening right now, from the states below. Set it at the start of a phase,",
    "  move it as you move between phases, and set `waiting-decision` **before** you ask the",
    "  question, so it is already showing when they read it.",
    "- Actions: the agreed steps, in the order they will be implemented. Add them before starting",
    "  work on them.",
    "- Exactly one action is in flight (`doing`) at a time. Mark it before you start.",
    "- Mark an action done the moment it is verified. Never delete one.",
    "- New work agreed mid-flight: add it above the completed items (`focus_add` default).",
    "- Attach the ticket, ADR or PR link to its action as soon as one exists (`focus_link`).",
    "- When the whole task is finished, set `focus_status` to `done` and stop updating. (`focus_set`",
    "  also takes a `lifecycle` for the task itself: active, done or dropped.)",
    "",
    "Status states (`focus_status`):",
    ...ACTIVITY_STATES.map((state) => `  ${state} — ${ACTIVITY[state].hint}`),
    "",
    "Tools: focus_get, focus_set, focus_status, focus_add, focus_begin, focus_complete, focus_link, focus_drop.",
    "",
    render(doc, now),
  ];
  return lines.join("\n");
};

/* ---------------------------------------------------------------- the plugin */

export default Plugin.define({
  id: "session-focus",

  async setup(ctx) {
    const directory = ctx.location?.directory;
    if (!directory) return;

    const storeFor = (sessionId: string) => makeStore(directory, sessionId);

    const run = async (
      sessionId: string,
      apply: (doc: FocusDoc) => FocusDoc,
    ): Promise<FocusDoc> => {
      const store = storeFor(sessionId);
      return applyMutation(sessionId, store.read, store.write, apply);
    };

    /**
     * `applyMutation` may replay its mutator, so the affected action is captured
     * inside it — the last run wins — rather than returned alongside the doc.
     */
    const runCapturing = async <A>(
      sessionId: string,
      apply: (doc: FocusDoc) => { doc: FocusDoc; action?: A },
    ): Promise<{ doc: FocusDoc; action: A | undefined }> => {
      // `applyMutation` always runs the mutator at least once.
      let captured!: { doc: FocusDoc; action?: A };
      const doc = await run(sessionId, (current) => {
        captured = apply(current);
        return captured.doc;
      });
      return { doc, action: captured.action };
    };

    /* tools */

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "focus",
        description: "Read and maintain this session's focus card",
      });

      editor.add({
        name: "get",
        description:
          "Read the session focus: the task sentence, the agreed actions in implementation order, "
          + "and which one is in flight. Check it before assuming what the session is working on.",
        input: schema({}),
        options: { namespace: "focus" },
        execute: async (_input, context) => {
          const doc = await storeFor(context.sessionID).load();
          if (isEmpty(doc)) return { content: "No focus set for this session yet. Use focus_set to start it." };
          return { content: render(doc) };
        },
      });

      editor.add({
        name: "set",
        description:
          "Set or replace the session focus: one sentence naming the task and the approach, not the "
          + "subject area. Call it when the task or the approach changes. Also sets the task's own "
          + "lifecycle (active, done, dropped) — for what is happening right now, use `focus_status`.",
        input: schema({
          focus: text("The focus sentence."),
          lifecycle: {
            type: "string",
            enum: ["active", "done", "dropped"],
            description: "active while the session is working on it; done when the whole task is finished.",
          },
        }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { focus, lifecycle } = input as { focus?: string; lifecycle?: Lifecycle };
          const doc = await run(context.sessionID, (current) =>
            setFocus(current, { focus, lifecycle }, WRITER));
          return { content: render(doc) };
        },
      });

      editor.add({
        name: "status",
        description:
          "Say what is happening right now so the human can see it at a glance: which phase you are "
          + "in and what you are doing in it. Call it at the start of a phase, when you move between "
          + "phases, before you ask a question, and when you stop to wait for anyone.",
        input: schema(
          {
            state: {
              type: "string",
              enum: ACTIVITY_STATES,
              description: ACTIVITY_STATES.map((state) => `${state}: ${ACTIVITY[state].hint}`).join(" "),
            },
            detail: text(
              "Optional specifics — 'the Status field and its icons'. Omit it to keep the current detail.",
            ),
          },
          ["state"],
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { state, detail } = input as { state: ActivityState; detail?: string };
          const doc = await run(context.sessionID, (current) =>
            setActivity(current, { state, detail }, WRITER));
          return { content: render(doc) };
        },
      });

      editor.add({
        name: "add",
        description:
          "Add an agreed action to the focus card, before work on it starts. Stored in implementation "
          + "order; by default it lands above the completed items.",
        input: schema(
          {
            text: text("The action, phrased as a step that can be verified."),
            position: {
              type: "string",
              enum: ["next", "last"],
              description: "`next` puts it at the top of the outstanding work; `last` (default) appends it.",
            },
            label: text("Optional: the ticket, ADR or PR this action belongs to, e.g. '#42'."),
            url: text("Optional: the URL for that reference."),
          },
          ["text"],
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { text: body, position, label, url } = input as {
            text: string;
            position?: "next" | "last";
            label?: string;
            url?: string;
          };
          const refs = label && url ? [{ label, url }] : undefined;
          const { doc, action } = await runCapturing(context.sessionID, (current) =>
            addAction(current, { text: body, position, refs }, WRITER));
          if (!action) return { content: render(doc) };
          return { content: `Added ${action.id} — ${action.text}.\n\n${render(doc)}` };
        },
      });

      editor.add({
        name: "begin",
        description:
          "Mark one action as in flight. Only one is ever in flight: starting a new one returns the "
          + "previous one to outstanding. Omit the id to take the current one, else the first outstanding.",
        input: schema({ id: text("Action id, as shown on the card (e.g. 'a2').") }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input as { id?: string };
          const { doc, action } = await runCapturing(context.sessionID, (current) =>
            beginAction(current, id, WRITER));
          if (!action) return { content: "No action to start. Add one with focus_add." };
          return { content: `In flight: ${action.id} — ${action.text}\n\n${render(doc)}` };
        },
      });

      editor.add({
        name: "complete",
        description:
          "Mark an action done. Call it as soon as the action is verified, not at the end of the "
          + "session. Completed actions stay on the card. Omit the id to take the one in flight, else "
          + "the first outstanding.",
        input: schema({ id: text("Action id. Omit to complete the action in flight.") }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input as { id?: string };
          const { doc, action } = await runCapturing(context.sessionID, (current) =>
            completeAction(current, id, WRITER));
          if (!action) return { content: "No action to complete." };
          const { done, total } = progress(doc);
          return { content: `Done: ${action.id} — ${action.text} (${done}/${total})\n\n${render(doc)}` };
        },
      });

      editor.add({
        name: "link",
        description:
          "Attach a ticket, ADR, PR or escalation link to an action, as soon as the reference exists.",
        input: schema(
          {
            id: text("Action id."),
            label: text("Short label, e.g. '#42' or 'ADR-0007'."),
            url: text("Where it lives."),
          },
          ["id", "label", "url"],
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id, label, url } = input as { id: string; label: string; url: string };
          const { doc, action } = await runCapturing(context.sessionID, (current) =>
            linkRef(current, id, { label, url }, WRITER));
          if (!action) return { content: `No action with id ${id}.` };
          return { content: `Linked ${label} to ${action.id}.\n\n${render(doc)}` };
        },
      });

      editor.add({
        name: "drop",
        description:
          "Mark an action as no longer wanted. It stays on the card, struck through, so the decision "
          + "is visible. Use it instead of deleting work that was agreed and then abandoned.",
        input: schema({ id: text("Action id.") }, ["id"]),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input as { id: string };
          const { doc, action } = await runCapturing(context.sessionID, (current) =>
            dropAction(current, id, WRITER));
          if (!action) return { content: `No action with id ${id}.` };
          return { content: `Dropped ${action.id}.\n\n${render(doc)}` };
        },
      });
    });

    /* system instructions */

    if (ctx.options?.instructions === false) return;

    await ctx.session.hook("context", async (event) => {
      const doc = await storeFor(event.sessionID).load();
      if (isEmpty(doc)) return;
      event.system.push({ type: "text", text: instructions(doc) });
    });
  },
});
