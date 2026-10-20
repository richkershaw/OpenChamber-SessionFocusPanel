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
  addAction,
  applyMutation,
  beginAction,
  completeAction,
  currentAction,
  displayOrder,
  dropAction,
  linkRef,
  isEmpty,
  parseDoc,
  progress,
  serializeDoc,
  setFocus,
  storePath,
  type FocusAction,
  type FocusDoc,
  type FocusStatus,
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

const render = (doc: FocusDoc): string => {
  const { done, total } = progress(doc);
  const doing = currentAction(doc);
  const lines: string[] = [];
  lines.push(`Focus: ${doc.focus || "(not set)"}  [${doc.status}]  ${done}/${total} done`);
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
 * The block appended to the system instructions. The seven bullets are the
 * events at which the agent is expected to keep the card current.
 */
const instructions = (doc: FocusDoc): string => {
  const lines: string[] = [
    "## Session Focus",
    "",
    "This session keeps a focus card in the Work Status panel. Keep it current — it is how a",
    "human sees what this session is doing and what was agreed.",
    "",
    "- Focus: one sentence naming the task and the approach, not the subject area. Replace it when",
    "  the task or the approach changes.",
    "- Actions: the agreed steps, in the order they will be implemented. Add them before starting",
    "  work on them.",
    "- Exactly one action is in flight (`doing`) at a time. Mark it before you start.",
    "- Mark an action done the moment it is verified. Never delete one.",
    "- New work agreed mid-flight: add it above the completed items (`focus_add` default).",
    "- Attach the ticket, ADR or PR link to its action as soon as one exists (`focus_link`).",
    "- When the whole task is finished, set the focus status to `done` and stop updating.",
    "",
    "Tools: focus_get, focus_set, focus_add, focus_begin, focus_complete, focus_link, focus_drop.",
    "",
    render(doc),
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
          + "subject area. Call it when the task or the approach changes. Also sets the focus status.",
        input: schema({
          focus: text("The focus sentence."),
          status: {
            type: "string",
            enum: ["active", "done", "dropped"],
            description: "active while the session is working on it; done when the whole task is finished.",
          },
        }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { focus, status } = input as { focus?: string; status?: FocusStatus };
          const doc = await run(context.sessionID, (current) =>
            setFocus(current, { focus, status }, WRITER));
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
