/**
 * The Session Focus store.
 *
 * This is the one contract both writers bundle — the OpenChamber extension (the
 * card in the Work Status panel) and the OpenCode plugin (the `focus_*` tools the
 * agent calls) — so the file format cannot drift between them.
 *
 * One file per session, inside the project:
 *
 *   .openchamber/session-focus/<sessionId>.json
 *
 * The document is plain JSON carrying a `revision` counter. Every writer
 * re-reads, applies its mutation and writes back, retrying once when another
 * writer got there first (see `applyMutation`).
 *
 * The document holds two different things, and the naming is deliberate:
 *
 *   `focus`      — the high-level aim: what this session is for.
 *   `status`     — what is happening right now: the activity, and its detail.
 *   `lifecycle`  — whether the task is active, done or dropped.
 *
 * Kept dependency-free on purpose: it is bundled into a browser IIFE for the
 * extension, imported by a Node module for the plugin, and run directly by the
 * test suite.
 */

export const STORE_DIR = ".openchamber/session-focus";

/**
 * 2 renamed the task lifecycle from `status` to `lifecycle`, freeing `status` for
 * the activity. `parseDoc` migrates a v1 document by shape rather than by this
 * number, so the two halves can be at different versions without loss.
 */
export const SCHEMA_VERSION = 2;

export type ActionState = "todo" | "doing" | "done" | "dropped";
export type Lifecycle = "active" | "done" | "dropped";
export type Writer = "agent" | "user";

/** How a state is animated. Three classes, not ten bespoke animations. */
export type MotionClass = "loop" | "attention" | "static";
export type ActivityTone = "neutral" | "primary" | "info" | "warning" | "error" | "muted" | "success";

export type ActivityState =
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "waiting-decision"
  | "waiting-manual"
  | "waiting-external"
  | "blocked"
  | "idle"
  | "done";

export interface ActivityDescriptor {
  /** Shown in the card and rendered as the state's name. */
  label: string;
  motion: MotionClass;
  tone: ActivityTone;
  /**
   * Plain-language guidance for the agent's system prompt, generated from here so
   * the vocabulary the agent is given cannot drift from the one the card draws.
   */
  hint: string;
}

/**
 * The vocabulary, in the order the card's picker offers it: the shape of a piece
 * of work, top to bottom.
 *
 * `motion` is a claim about whether anything is actually progressing. The two
 * wait states deliberately do not loop — nothing is moving, and a spinner there
 * would be a lie — while `blocked` is static for the same reason.
 */
export const ACTIVITY: Record<ActivityState, ActivityDescriptor> = {
  planning: {
    label: "Planning",
    motion: "loop",
    tone: "neutral",
    hint: "Working out the approach. Nothing is written yet.",
  },
  implementing: {
    label: "Implementing",
    motion: "loop",
    tone: "primary",
    hint: "Writing code.",
  },
  testing: {
    label: "Testing",
    motion: "loop",
    tone: "info",
    hint: "Running tests, checks or a build.",
  },
  reviewing: {
    label: "Reviewing",
    motion: "loop",
    tone: "neutral",
    hint: "Reading a diff, a report, or existing code.",
  },
  "waiting-decision": {
    label: "Waiting for a decision",
    motion: "attention",
    tone: "warning",
    hint: "Blocked on a choice only the human can make. Set this before you ask the question, so it is already showing when they read it.",
  },
  "waiting-manual": {
    label: "Waiting for a manual step",
    motion: "attention",
    tone: "warning",
    hint: "Blocked on an action only a human can take: a click, an install, an approval.",
  },
  "waiting-external": {
    label: "Waiting on an external job",
    motion: "static",
    tone: "neutral",
    hint: "Waiting on CI, a deploy, or another long-running job you did not start.",
  },
  blocked: {
    label: "Blocked",
    motion: "static",
    tone: "error",
    hint: "Stuck on a failure or a missing dependency.",
  },
  idle: {
    label: "Idle",
    motion: "static",
    tone: "muted",
    hint: "Between turns; nothing in flight.",
  },
  done: {
    label: "Done",
    motion: "static",
    tone: "success",
    hint: "The task is finished.",
  },
};

export const ACTIVITY_STATES = Object.keys(ACTIVITY) as ActivityState[];

export interface Activity {
  state: ActivityState;
  /** The specifics: "the Status field and its icons". */
  detail: string;
  /** When this state began. Only moves when the state changes. */
  since: number;
}

export interface FocusRef {
  label: string;
  url: string;
}

export interface FocusAction {
  id: string;
  text: string;
  state: ActionState;
  refs: FocusRef[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface FocusDoc {
  version: number;
  sessionId: string;
  revision: number;
  focus: string;
  lifecycle: Lifecycle;
  /** Absent until someone sets one. */
  status?: Activity;
  /** Implementation order. The card partitions this for display; see `displayOrder`. */
  actions: FocusAction[];
  updatedAt: number;
  updatedBy: Writer;
}

const ACTION_STATES: readonly ActionState[] = ["todo", "doing", "done", "dropped"];
const LIFECYCLES: readonly Lifecycle[] = ["active", "done", "dropped"];

export const storePath = (sessionId: string): string => `${STORE_DIR}/${sessionId}.json`;

export const emptyDoc = (sessionId: string, now: number = Date.now()): FocusDoc => ({
  version: SCHEMA_VERSION,
  sessionId,
  revision: 0,
  focus: "",
  lifecycle: "active",
  actions: [],
  updatedAt: now,
  updatedBy: "user",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asText = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";

const asTime = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseRefs = (value: unknown): FocusRef[] => {
  if (!Array.isArray(value)) return [];
  const refs: FocusRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const label = asText(entry.label, 120);
    const url = asText(entry.url, 2000);
    if (label && url) refs.push({ label, url });
  }
  return refs;
};

const parseActions = (value: unknown): FocusAction[] => {
  if (!Array.isArray(value)) return [];
  const actions: FocusAction[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asText(entry.id, 64);
    const text = asText(entry.text, 500);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    const state = ACTION_STATES.includes(entry.state as ActionState)
      ? (entry.state as ActionState)
      : "todo";
    actions.push({
      id,
      text,
      state,
      refs: parseRefs(entry.refs),
      createdAt: asTime(entry.createdAt) ?? 0,
      ...(asTime(entry.startedAt) !== undefined ? { startedAt: asTime(entry.startedAt) } : {}),
      ...(asTime(entry.completedAt) !== undefined ? { completedAt: asTime(entry.completedAt) } : {}),
    });
  }
  return actions;
};

/** An activity is only read when its state is one we know; anything else is unset. */
const parseActivity = (value: unknown): Activity | undefined => {
  if (!isRecord(value)) return undefined;
  const state = value.state as ActivityState;
  if (!ACTIVITY_STATES.includes(state)) return undefined;
  return {
    state,
    detail: asText(value.detail, 200),
    since: asTime(value.since) ?? 0,
  };
};

/**
 * Tolerant read: a missing, malformed or foreign document yields an empty one
 * rather than throwing, because the card must always be able to draw something.
 */
export const parseDoc = (raw: string | undefined | null, sessionId: string, now: number = Date.now()): FocusDoc => {
  if (typeof raw !== "string" || !raw.trim()) return emptyDoc(sessionId, now);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyDoc(sessionId, now);
  }
  if (!isRecord(value)) return emptyDoc(sessionId, now);
  const actions = parseActions(value.actions);
  // A document can only ever describe one `doing` action; collapse any extra.
  let seenDoing = false;
  for (const action of actions) {
    if (action.state !== "doing") continue;
    if (seenDoing) action.state = "todo";
    seenDoing = true;
  }
  // v1 stored the task lifecycle in `status` as a string. Read it as the
  // lifecycle and leave the new `status` unset, so a task marked `done` under v1
  // does not silently revert to `active`.
  const legacyLifecycle =
    typeof value.status === "string" && LIFECYCLES.includes(value.status as Lifecycle)
      ? (value.status as Lifecycle)
      : undefined;
  const lifecycle = LIFECYCLES.includes(value.lifecycle as Lifecycle)
    ? (value.lifecycle as Lifecycle)
    : (legacyLifecycle ?? "active");
  const status = parseActivity(value.status);
  return {
    version: SCHEMA_VERSION,
    sessionId,
    revision: typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0,
    focus: asText(value.focus, 500),
    lifecycle,
    ...(status ? { status } : {}),
    actions,
    updatedAt: asTime(value.updatedAt) ?? now,
    updatedBy: value.updatedBy === "agent" ? "agent" : "user",
  };
};

/** Stable key order and a trailing newline, so the file diffs cleanly. */
export const serializeDoc = (doc: FocusDoc): string => {
  const payload = {
    version: SCHEMA_VERSION,
    sessionId: doc.sessionId,
    revision: doc.revision,
    focus: doc.focus,
    lifecycle: doc.lifecycle,
    ...(doc.status
      ? { status: { state: doc.status.state, detail: doc.status.detail, since: doc.status.since } }
      : {}),
    actions: doc.actions.map((action) => ({
      id: action.id,
      text: action.text,
      state: action.state,
      refs: action.refs,
      createdAt: action.createdAt,
      ...(action.startedAt !== undefined ? { startedAt: action.startedAt } : {}),
      ...(action.completedAt !== undefined ? { completedAt: action.completedAt } : {}),
    })),
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
};

export const isEmpty = (doc: FocusDoc): boolean => !doc.focus && doc.actions.length === 0;

/**
 * The card's display split: active items first in implementation order (next at
 * the top), then completed items, also in implementation order. A new action is
 * appended to `actions`, which puts it at the bottom of the active block — above
 * the completed ones.
 */
export const displayOrder = (doc: FocusDoc): { active: FocusAction[]; completed: FocusAction[] } => ({
  active: doc.actions.filter((action) => action.state === "todo" || action.state === "doing"),
  completed: doc.actions.filter((action) => action.state === "done" || action.state === "dropped"),
});

export const progress = (doc: FocusDoc): { done: number; total: number } => ({
  done: doc.actions.filter((action) => action.state === "done").length,
  total: doc.actions.filter((action) => action.state !== "dropped").length,
});

export const currentAction = (doc: FocusDoc): FocusAction | undefined =>
  doc.actions.find((action) => action.state === "doing");

/** "just now", "4m", "2h", "3d" — coarse on purpose; it is a staleness cue. */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const touch = (doc: FocusDoc, by: Writer, now: number): FocusDoc => ({
  ...doc,
  revision: doc.revision + 1,
  updatedAt: now,
  updatedBy: by,
});

const nextId = (doc: FocusDoc): string => {
  let highest = 0;
  for (const action of doc.actions) {
    const match = /^a(\d+)$/.exec(action.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `a${highest + 1}`;
};

const resolveTarget = (doc: FocusDoc, id?: string): FocusAction | undefined => {
  if (id) return doc.actions.find((action) => action.id === id);
  return doc.actions.find((action) => action.state === "doing")
    ?? doc.actions.find((action) => action.state === "todo");
};

export const setFocus = (
  doc: FocusDoc,
  input: { focus?: string; lifecycle?: Lifecycle },
  by: Writer,
  now: number = Date.now(),
): FocusDoc => {
  const next = { ...doc };
  if (input.focus !== undefined) next.focus = asText(input.focus, 500);
  if (input.lifecycle !== undefined) next.lifecycle = input.lifecycle;
  return touch(next, by, now);
};

/**
 * What is happening right now. Omitting `detail` leaves it alone, so the agent can
 * move between states without restating the specifics; `since` only moves when the
 * state itself changes, which is what makes a stuck status visible.
 */
export const setActivity = (
  doc: FocusDoc,
  input: { state: ActivityState; detail?: string },
  by: Writer,
  now: number = Date.now(),
): FocusDoc => {
  if (!ACTIVITY_STATES.includes(input.state)) return doc;
  const detail = input.detail === undefined ? (doc.status?.detail ?? "") : asText(input.detail, 200);
  const since = doc.status?.state === input.state ? doc.status.since : now;
  return touch({ ...doc, status: { state: input.state, detail, since } }, by, now);
};

export const clearActivity = (doc: FocusDoc, by: Writer, now: number = Date.now()): FocusDoc => {
  if (!doc.status) return doc;
  const next = { ...doc };
  delete next.status;
  return touch(next, by, now);
};

export const addAction = (
  doc: FocusDoc,
  input: { text: string; refs?: FocusRef[]; position?: "next" | "last" },
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action: FocusAction } => {
  const action: FocusAction = {
    id: nextId(doc),
    text: asText(input.text, 500),
    state: "todo",
    refs: parseRefs(input.refs),
    createdAt: now,
  };
  const actions = input.position === "next" ? [action, ...doc.actions] : [...doc.actions, action];
  return { doc: touch({ ...doc, actions }, by, now), action };
};

export const beginAction = (
  doc: FocusDoc,
  id: string | undefined,
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action?: FocusAction } => {
  const target = resolveTarget(doc, id);
  if (!target) return { doc };
  const actions = doc.actions.map((action) => {
    if (action.id === target.id) return { ...action, state: "doing" as ActionState, startedAt: action.startedAt ?? now };
    // Only one action is ever `doing`.
    return action.state === "doing" ? { ...action, state: "todo" as ActionState } : action;
  });
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === target.id),
  };
};

export const completeAction = (
  doc: FocusDoc,
  id: string | undefined,
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action?: FocusAction } => {
  const target = resolveTarget(doc, id);
  if (!target) return { doc };
  const actions = doc.actions.map((action) =>
    action.id === target.id
      ? { ...action, state: "done" as ActionState, startedAt: action.startedAt ?? now, completedAt: now }
      : action,
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === target.id),
  };
};

export const dropAction = (
  doc: FocusDoc,
  id: string,
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action?: FocusAction } => {
  const target = doc.actions.find((action) => action.id === id);
  if (!target) return { doc };
  const actions = doc.actions.map((action) =>
    action.id === id ? { ...action, state: "dropped" as ActionState, completedAt: now } : action,
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === id),
  };
};

export const linkRef = (
  doc: FocusDoc,
  id: string,
  ref: FocusRef,
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action?: FocusAction } => {
  const target = doc.actions.find((action) => action.id === id);
  if (!target) return { doc };
  const parsed = parseRefs([ref]);
  if (!parsed.length) return { doc };
  const actions = doc.actions.map((action) =>
    action.id === id ? { ...action, refs: [...action.refs, ...parsed] } : action,
  );
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === id),
  };
};

export const renameAction = (
  doc: FocusDoc,
  id: string,
  text: string,
  by: Writer,
  now: number = Date.now(),
): { doc: FocusDoc; action?: FocusAction } => {
  const value = asText(text, 500);
  if (!value) return { doc };
  const actions = doc.actions.map((action) => (action.id === id ? { ...action, text: value } : action));
  return {
    doc: touch({ ...doc, actions }, by, now),
    action: actions.find((action) => action.id === id),
  };
};

/**
 * Read-modify-write with a lost-update guard.
 *
 * `read` returns the current file contents and `mutate` is applied to the parsed
 * document. Two things keep a panel write and an agent write from eating each
 * other:
 *
 *   1. the file is re-read immediately before writing, and the write is skipped
 *      if it moved in the meantime; and
 *   2. the file is re-read immediately after writing, and only contents that
 *      came from this call count as a win — anything else means another writer
 *      landed on top, so the mutation is replayed against their copy.
 *
 * The mutation must be pure: it may run more than once, and callers that need
 * the affected action should capture it inside the mutator (the last run wins).
 *
 * What this cannot do is compare-and-swap: a write that lands in the gap
 * between the pre-write read and the write itself is invisible, and the later
 * of the two wins. That window is sub-millisecond and the panel only writes on
 * a human tick, so it is left to the file system rather than a lock.
 */
export const applyMutation = async (
  sessionId: string,
  read: () => Promise<string | undefined>,
  write: (content: string) => Promise<void>,
  mutate: (doc: FocusDoc) => FocusDoc,
  options: { retries?: number; now?: number } = {},
): Promise<FocusDoc> => {
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

/** Cheap change detector for callers that poll: the revision, or -1 when absent. */
export const revisionOf = (raw: string | undefined | null, sessionId: string): number =>
  parseDoc(raw, sessionId).revision;
