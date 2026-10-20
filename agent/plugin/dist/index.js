/* Built from agent/plugin/index.ts by scripts/build-plugin.mjs — run `npm run build` after editing. */

// agent/plugin/index.ts
import fs from "node:fs/promises";
import path from "node:path";
import { Plugin } from "@opencode/plugin";

// shared/store.ts
var STORE_DIR = ".openchamber/session-focus";
var SCHEMA_VERSION = 2;
var ACTIVITY = {
  planning: {
    label: "Planning",
    motion: "loop",
    tone: "neutral",
    hint: "Working out the approach. Nothing is written yet."
  },
  implementing: {
    label: "Implementing",
    motion: "loop",
    tone: "primary",
    hint: "Writing code."
  },
  testing: {
    label: "Testing",
    motion: "loop",
    tone: "info",
    hint: "Running tests, checks or a build."
  },
  reviewing: {
    label: "Reviewing",
    motion: "loop",
    tone: "neutral",
    hint: "Reading a diff, a report, or existing code."
  },
  "waiting-decision": {
    label: "Waiting for a decision",
    motion: "attention",
    tone: "warning",
    hint: "Blocked on a choice only the human can make. Set this before you ask the question, so it is already showing when they read it."
  },
  "waiting-manual": {
    label: "Waiting for a manual step",
    motion: "attention",
    tone: "warning",
    hint: "Blocked on an action only a human can take: a click, an install, an approval."
  },
  "waiting-external": {
    label: "Waiting on an external job",
    motion: "static",
    tone: "neutral",
    hint: "Waiting on CI, a deploy, or another long-running job you did not start."
  },
  blocked: {
    label: "Blocked",
    motion: "static",
    tone: "error",
    hint: "Stuck on a failure or a missing dependency."
  },
  idle: {
    label: "Idle",
    motion: "static",
    tone: "muted",
    hint: "Between turns; nothing in flight."
  },
  done: {
    label: "Done",
    motion: "static",
    tone: "success",
    hint: "The task is finished."
  }
};
var ACTIVITY_STATES = Object.keys(ACTIVITY);
var ACTION_STATES = ["todo", "doing", "done", "dropped"];
var LIFECYCLES = ["active", "done", "dropped"];
var storePath = (sessionId) => `${STORE_DIR}/${sessionId}.json`;
var emptyDoc = (sessionId, now = Date.now()) => ({
  version: SCHEMA_VERSION,
  sessionId,
  revision: 0,
  focus: "",
  lifecycle: "active",
  actions: [],
  updatedAt: now,
  updatedBy: "user"
});
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var asText = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
var asTime = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
var parseRefs = (value) => {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = asText(entry.label, 120);
    const url = asText(entry.url, 2e3);
    if (label && url) refs.push({ label, url });
  }
  return refs;
};
var parseActions = (value) => {
  if (!Array.isArray(value)) return [];
  const actions = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asText(entry.id, 64);
    const text2 = asText(entry.text, 500);
    if (!id || !text2 || seen.has(id)) continue;
    seen.add(id);
    const state = ACTION_STATES.includes(entry.state) ? entry.state : "todo";
    actions.push({
      id,
      text: text2,
      state,
      refs: parseRefs(entry.refs),
      createdAt: asTime(entry.createdAt) ?? 0,
      ...asTime(entry.startedAt) !== void 0 ? { startedAt: asTime(entry.startedAt) } : {},
      ...asTime(entry.completedAt) !== void 0 ? { completedAt: asTime(entry.completedAt) } : {}
    });
  }
  return actions;
};
var parseActivity = (value) => {
  if (!isRecord(value)) return void 0;
  const state = value.state;
  if (!ACTIVITY_STATES.includes(state)) return void 0;
  return {
    state,
    detail: asText(value.detail, 200),
    since: asTime(value.since) ?? 0
  };
};
var parseDoc = (raw, sessionId, now = Date.now()) => {
  if (typeof raw !== "string" || !raw.trim()) return emptyDoc(sessionId, now);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyDoc(sessionId, now);
  }
  if (!isRecord(value)) return emptyDoc(sessionId, now);
  const actions = parseActions(value.actions);
  let seenDoing = false;
  for (const action of actions) {
    if (action.state !== "doing") continue;
    if (seenDoing) action.state = "todo";
    seenDoing = true;
  }
  const legacyLifecycle = typeof value.status === "string" && LIFECYCLES.includes(value.status) ? value.status : void 0;
  const lifecycle = LIFECYCLES.includes(value.lifecycle) ? value.lifecycle : legacyLifecycle ?? "active";
  const status = parseActivity(value.status);
  return {
    version: SCHEMA_VERSION,
    sessionId,
    revision: typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0,
    focus: asText(value.focus, 500),
    lifecycle,
    ...status ? { status } : {},
    actions,
    updatedAt: asTime(value.updatedAt) ?? now,
    updatedBy: value.updatedBy === "agent" ? "agent" : "user"
  };
};
var serializeDoc = (doc) => {
  const payload = {
    version: SCHEMA_VERSION,
    sessionId: doc.sessionId,
    revision: doc.revision,
    focus: doc.focus,
    lifecycle: doc.lifecycle,
    ...doc.status ? { status: { state: doc.status.state, detail: doc.status.detail, since: doc.status.since } } : {},
    actions: doc.actions.map((action) => ({
      id: action.id,
      text: action.text,
      state: action.state,
      refs: action.refs,
      createdAt: action.createdAt,
      ...action.startedAt !== void 0 ? { startedAt: action.startedAt } : {},
      ...action.completedAt !== void 0 ? { completedAt: action.completedAt } : {}
    })),
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy
  };
  return `${JSON.stringify(payload, null, 2)}
`;
};
var isEmpty = (doc) => !doc.focus && doc.actions.length === 0;
var displayOrder = (doc) => ({
  active: doc.actions.filter((action) => action.state === "todo" || action.state === "doing"),
  completed: doc.actions.filter((action) => action.state === "done" || action.state === "dropped")
});
var progress = (doc) => ({
  done: doc.actions.filter((action) => action.state === "done").length,
  total: doc.actions.filter((action) => action.state !== "dropped").length
});
var currentAction = (doc) => doc.actions.find((action) => action.state === "doing");
var formatElapsed = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1e3));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};
var touch = (doc, by, now) => ({
  ...doc,
  revision: doc.revision + 1,
  updatedAt: now,
  updatedBy: by
});
var nextId = (doc) => {
  let highest = 0;
  for (const action of doc.actions) {
    const match = /^a(\d+)$/.exec(action.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `a${highest + 1}`;
};
var resolveTarget = (doc, id) => {
  if (id) return doc.actions.find((action) => action.id === id);
  return doc.actions.find((action) => action.state === "doing") ?? doc.actions.find((action) => action.state === "todo");
};
var setFocus = (doc, input, by, now = Date.now()) => {
  const next = { ...doc };
  if (input.focus !== void 0) next.focus = asText(input.focus, 500);
  if (input.lifecycle !== void 0) next.lifecycle = input.lifecycle;
  return touch(next, by, now);
};
var setActivity = (doc, input, by, now = Date.now()) => {
  if (!ACTIVITY_STATES.includes(input.state)) return doc;
  const detail = input.detail === void 0 ? doc.status?.detail ?? "" : asText(input.detail, 200);
  const since = doc.status?.state === input.state ? doc.status.since : now;
  return touch({ ...doc, status: { state: input.state, detail, since } }, by, now);
};
var addAction = (doc, input, by, now = Date.now()) => {
  const action = {
    id: nextId(doc),
    text: asText(input.text, 500),
    state: "todo",
    refs: parseRefs(input.refs),
    createdAt: now
  };
  const actions = input.position === "next" ? [action, ...doc.actions] : [...doc.actions, action];
  return { doc: touch({ ...doc, actions }, by, now), action };
};
var beginAction = (doc, id, by, now = Date.now()) => {
  const target = resolveTarget(doc, id);
  if (!target) return { doc };
  const actions = doc.actions.map((action) => {
    if (action.id === target.id) return { ...action, state: "doing", startedAt: action.startedAt ?? now };
    return action.state === "doing" ? { ...action, state: "todo" } : action;
  });
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === target.id)
  };
};
var completeAction = (doc, id, by, now = Date.now()) => {
  const target = resolveTarget(doc, id);
  if (!target) return { doc };
  const actions = doc.actions.map(
    (action) => action.id === target.id ? { ...action, state: "done", startedAt: action.startedAt ?? now, completedAt: now } : action
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === target.id)
  };
};
var dropAction = (doc, id, by, now = Date.now()) => {
  const target = doc.actions.find((action) => action.id === id);
  if (!target) return { doc };
  const actions = doc.actions.map(
    (action) => action.id === id ? { ...action, state: "dropped", completedAt: now } : action
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === id)
  };
};
var linkRef = (doc, id, ref, by, now = Date.now()) => {
  const target = doc.actions.find((action) => action.id === id);
  if (!target) return { doc };
  const parsed = parseRefs([ref]);
  if (!parsed.length) return { doc };
  const actions = doc.actions.map(
    (action) => action.id === id ? { ...action, refs: [...action.refs, ...parsed] } : action
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === id)
  };
};
var applyMutation = async (sessionId, read, write, mutate, options = {}) => {
  const retries = options.retries ?? 3;
  const now = options.now ?? Date.now();
  let last = parseDoc(await read(), sessionId, now);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const before = last;
    const next = mutate(before);
    const payload = serializeDoc(next);
    const settled = parseDoc(await read(), sessionId, now);
    if (settled.revision !== before.revision) {
      last = settled;
      continue;
    }
    await write(payload);
    const after = await read();
    if (after === payload) return next;
    last = parseDoc(after, sessionId, now);
  }
  return last;
};

// agent/plugin/index.ts
var WRITER = "agent";
var schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var text = (description) => ({ type: "string", description });
var fileFor = (directory, sessionId) => path.join(directory, storePath(sessionId));
var writeAtomic = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
};
var makeStore = (directory, sessionId) => {
  const file = fileFor(directory, sessionId);
  const read = async () => {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      return void 0;
    }
  };
  const write = (content) => writeAtomic(file, content);
  const load = async () => parseDoc(await read(), sessionId);
  return { read, write, load };
};
var render = (doc, now = Date.now()) => {
  const { done, total } = progress(doc);
  const doing = currentAction(doc);
  const lines = [];
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
  if (doing) lines.push("", `In flight: ${doing.id} \u2014 ${doing.text}`);
  return lines.join("\n");
};
var instructions = (doc, now = Date.now()) => {
  const lines = [
    "## Focus",
    "",
    "This session keeps a focus card in the Work Status panel. Keep it current \u2014 it is how a",
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
    ...ACTIVITY_STATES.map((state) => `  ${state} \u2014 ${ACTIVITY[state].hint}`),
    "",
    "Tools: focus_get, focus_set, focus_status, focus_add, focus_begin, focus_complete, focus_link, focus_drop.",
    "",
    render(doc, now)
  ];
  return lines.join("\n");
};
var index_default = Plugin.define({
  id: "session-focus",
  async setup(ctx) {
    const directory = ctx.location?.directory;
    if (!directory) return;
    const storeFor = (sessionId) => makeStore(directory, sessionId);
    const run = async (sessionId, apply) => {
      const store = storeFor(sessionId);
      return applyMutation(sessionId, store.read, store.write, apply);
    };
    const runCapturing = async (sessionId, apply) => {
      let captured;
      const doc = await run(sessionId, (current) => {
        captured = apply(current);
        return captured.doc;
      });
      return { doc, action: captured.action };
    };
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "focus",
        description: "Read and maintain this session's focus card"
      });
      editor.add({
        name: "get",
        description: "Read the session focus: the task sentence, the agreed actions in implementation order, and which one is in flight. Check it before assuming what the session is working on.",
        input: schema({}),
        options: { namespace: "focus" },
        execute: async (_input, context) => {
          const doc = await storeFor(context.sessionID).load();
          if (isEmpty(doc)) return { content: "No focus set for this session yet. Use focus_set to start it." };
          return { content: render(doc) };
        }
      });
      editor.add({
        name: "set",
        description: "Set or replace the session focus: one sentence naming the task and the approach, not the subject area. Call it when the task or the approach changes. Also sets the task's own lifecycle (active, done, dropped) \u2014 for what is happening right now, use `focus_status`.",
        input: schema({
          focus: text("The focus sentence."),
          lifecycle: {
            type: "string",
            enum: ["active", "done", "dropped"],
            description: "active while the session is working on it; done when the whole task is finished."
          }
        }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { focus, lifecycle } = input;
          const doc = await run(context.sessionID, (current) => setFocus(current, { focus, lifecycle }, WRITER));
          return { content: render(doc) };
        }
      });
      editor.add({
        name: "status",
        description: "Say what is happening right now so the human can see it at a glance: which phase you are in and what you are doing in it. Call it at the start of a phase, when you move between phases, before you ask a question, and when you stop to wait for anyone.",
        input: schema(
          {
            state: {
              type: "string",
              enum: ACTIVITY_STATES,
              description: ACTIVITY_STATES.map((state) => `${state}: ${ACTIVITY[state].hint}`).join(" ")
            },
            detail: text(
              "Optional specifics \u2014 'the Status field and its icons'. Omit it to keep the current detail."
            )
          },
          ["state"]
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { state, detail } = input;
          const doc = await run(context.sessionID, (current) => setActivity(current, { state, detail }, WRITER));
          return { content: render(doc) };
        }
      });
      editor.add({
        name: "add",
        description: "Add an agreed action to the focus card, before work on it starts. Stored in implementation order; by default it lands above the completed items.",
        input: schema(
          {
            text: text("The action, phrased as a step that can be verified."),
            position: {
              type: "string",
              enum: ["next", "last"],
              description: "`next` puts it at the top of the outstanding work; `last` (default) appends it."
            },
            label: text("Optional: the ticket, ADR or PR this action belongs to, e.g. '#42'."),
            url: text("Optional: the URL for that reference.")
          },
          ["text"]
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { text: body, position, label, url } = input;
          const refs = label && url ? [{ label, url }] : void 0;
          const { doc, action } = await runCapturing(context.sessionID, (current) => addAction(current, { text: body, position, refs }, WRITER));
          if (!action) return { content: render(doc) };
          return { content: `Added ${action.id} \u2014 ${action.text}.

${render(doc)}` };
        }
      });
      editor.add({
        name: "begin",
        description: "Mark one action as in flight. Only one is ever in flight: starting a new one returns the previous one to outstanding. Omit the id to take the current one, else the first outstanding.",
        input: schema({ id: text("Action id, as shown on the card (e.g. 'a2').") }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input;
          const { doc, action } = await runCapturing(context.sessionID, (current) => beginAction(current, id, WRITER));
          if (!action) return { content: "No action to start. Add one with focus_add." };
          return { content: `In flight: ${action.id} \u2014 ${action.text}

${render(doc)}` };
        }
      });
      editor.add({
        name: "complete",
        description: "Mark an action done. Call it as soon as the action is verified, not at the end of the session. Completed actions stay on the card. Omit the id to take the one in flight, else the first outstanding.",
        input: schema({ id: text("Action id. Omit to complete the action in flight.") }),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input;
          const { doc, action } = await runCapturing(context.sessionID, (current) => completeAction(current, id, WRITER));
          if (!action) return { content: "No action to complete." };
          const { done, total } = progress(doc);
          return { content: `Done: ${action.id} \u2014 ${action.text} (${done}/${total})

${render(doc)}` };
        }
      });
      editor.add({
        name: "link",
        description: "Attach a ticket, ADR, PR or escalation link to an action, as soon as the reference exists.",
        input: schema(
          {
            id: text("Action id."),
            label: text("Short label, e.g. '#42' or 'ADR-0007'."),
            url: text("Where it lives.")
          },
          ["id", "label", "url"]
        ),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id, label, url } = input;
          const { doc, action } = await runCapturing(context.sessionID, (current) => linkRef(current, id, { label, url }, WRITER));
          if (!action) return { content: `No action with id ${id}.` };
          return { content: `Linked ${label} to ${action.id}.

${render(doc)}` };
        }
      });
      editor.add({
        name: "drop",
        description: "Mark an action as no longer wanted. It stays on the card, struck through, so the decision is visible. Use it instead of deleting work that was agreed and then abandoned.",
        input: schema({ id: text("Action id.") }, ["id"]),
        options: { namespace: "focus" },
        execute: async (input, context) => {
          const { id } = input;
          const { doc, action } = await runCapturing(context.sessionID, (current) => dropAction(current, id, WRITER));
          if (!action) return { content: `No action with id ${id}.` };
          return { content: `Dropped ${action.id}.

${render(doc)}` };
        }
      });
    });
    if (ctx.options?.instructions === false) return;
    await ctx.session.hook("context", async (event) => {
      const doc = await storeFor(event.sessionID).load();
      if (isEmpty(doc)) return;
      event.system.push({ type: "text", text: instructions(doc) });
    });
  }
});
export {
  index_default as default
};
