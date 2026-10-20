/**
 * The Session Focus card — `contributes.statusSection` in the chat's Work Status
 * panel.
 *
 * It owns the human half of the store: read the session's focus file, draw it,
 * and write back on a tick, an edit or a new action. The agent's half is the
 * OpenCode plugin in `agent/plugin`, which writes the same file through
 * `shared/store.ts`.
 *
 * The host unloads this frame whenever the section is collapsed or hidden, so
 * nothing here is kept between mounts: every mount rebuilds from the file.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk";
import type { GuestStatusControlEvent, HostReadyContext, SessionSnapshot } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";

import {
  addAction,
  applyMutation,
  beginAction,
  completeAction,
  displayOrder,
  dropAction,
  linkRef,
  isEmpty,
  parseDoc,
  progress,
  serializeDoc,
  setFocus,
  storePath,
  type ActionState,
  type FocusAction,
  type FocusDoc,
  type Writer,
} from "../shared/store.ts";

const host = connectHost();
const root = document.querySelector<HTMLDivElement>("#root")!;

const POLL_MS = 2500;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 320;

let sessionId: string | null = null;
let doc: FocusDoc | null = null;
let failure: string | null = null;
let disposed = false;

/* ------------------------------------------------------------------ store */

const readStore = async (): Promise<string | undefined> => {
  if (!sessionId) return undefined;
  try {
    const { content } = await host.readFile(storePath(sessionId));
    return content;
  } catch (error) {
    if (error instanceof HostRequestError && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
};

const writeStore = async (content: string): Promise<void> => {
  if (!sessionId) return;
  await host.writeFile(storePath(sessionId), content);
};

/**
 * Every write goes through the shared stale-write guard, so an update from the
 * agent landing between our read and our write is not lost.
 */
const mutate = async (
  apply: (current: FocusDoc) => FocusDoc,
  writer: Writer = "user",
): Promise<void> => {
  if (!sessionId || disposed) return;
  try {
    const next = await applyMutation(sessionId, readStore, writeStore, (current) =>
      apply({ ...current, updatedBy: writer }));
    doc = next;
    failure = null;
  } catch (error) {
    failure = describe(error);
  }
  render();
};

const describe = (error: unknown): string => {
  if (error instanceof HostRequestError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/* ---------------------------------------------------------------- renderer */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const focusInput = el("textarea", "focus-input") as HTMLTextAreaElement;
focusInput.rows = 2;
focusInput.placeholder = "What is this session doing?";
focusInput.spellcheck = false;
let focusDirty = false;

focusInput.addEventListener("focus", () => { focusDirty = true; });
focusInput.addEventListener("blur", () => {
  focusDirty = false;
  void commitFocus();
});
focusInput.addEventListener("input", () => autoSizeFocus());
focusInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    focusInput.blur();
  }
});
focusInput.addEventListener("blur", () => { void renderLater(); });

const autoSizeFocus = (): void => {
  focusInput.style.height = "auto";
  focusInput.style.height = `${Math.min(focusInput.scrollHeight, 96)}px`;
};

let focusTimer: ReturnType<typeof setTimeout> | null = null;
const commitFocus = async (): Promise<void> => {
  const value = focusInput.value.trim();
  if (!doc || value === doc.focus) return;
  await mutate((current) => setFocus(current, { focus: value }, "user"));
  scheduleHeight();
};

focusInput.addEventListener("input", () => {
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { void commitFocus(); }, 700);
});

const addInput = el("input", "input") as HTMLInputElement;
addInput.type = "text";
addInput.placeholder = "Add an action, then Enter";

addInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const text = addInput.value.trim();
  if (!text) return;
  addInput.value = "";
  void mutate((current) => addAction(current, { text }, "user").doc);
});

const onTick = (action: FocusAction): void => {
  void mutate((current) => {
    const next: ActionState =
      action.state === "todo" ? "doing" : action.state === "doing" ? "done" : "todo";
    if (next === "doing") return beginAction(current, action.id, "user").doc;
    if (next === "done") return completeAction(current, action.id, "user").doc;
    return {
      ...current,
      actions: current.actions.map((entry) =>
        entry.id === action.id ? { ...entry, state: "todo" as ActionState, completedAt: undefined } : entry),
    };
  });
};

const rowFor = (action: FocusAction): HTMLLIElement => {
  const row = el("li", "row");
  row.dataset.state = action.state;

  const tick = el("button", "tick") as HTMLButtonElement;
  tick.type = "button";
  tick.dataset.state = action.state;
  tick.setAttribute("role", "checkbox");
  tick.setAttribute("aria-checked", String(action.state === "done"));
  tick.title =
    action.state === "todo" ? "Mark as in flight"
      : action.state === "doing" ? "Mark as done"
        : "Reopen";
  tick.addEventListener("click", () => onTick(action));
  row.append(tick);

  const body = el("div", "body");
  body.append(el("div", "text", action.text));

  if (action.refs.length) {
    const refs = el("div", "refs");
    for (const ref of action.refs) {
      const chip = el("button", "ref", ref.label) as HTMLButtonElement;
      chip.type = "button";
      chip.title = ref.url;
      chip.addEventListener("click", () => { void host.openUrl(ref.url); });
      refs.append(chip);
    }
    body.append(refs);
  }

  row.append(body);

  const tools = el("div", "row-tools");
  const linkBtn = el("button", "icon-btn", "🔗") as HTMLButtonElement;
  linkBtn.type = "button";
  linkBtn.title = "Attach a ticket, ADR or PR";
  linkBtn.addEventListener("click", () => {
    row.after(refFormFor(action));
  });
  tools.append(linkBtn);

  if (action.state !== "dropped") {
    const dropBtn = el("button", "icon-btn", "✕") as HTMLButtonElement;
    dropBtn.type = "button";
    dropBtn.title = "Drop this action";
    dropBtn.addEventListener("click", () => {
      void mutate((current) => dropAction(current, action.id, "user").doc);
    });
    tools.append(dropBtn);
  }
  row.append(tools);

  return row;
};

const refFormFor = (action: FocusAction): HTMLDivElement => {
  const form = el("div", "ref-form");
  const label = el("input", "input") as HTMLInputElement;
  label.placeholder = "#42 or ADR-0007";
  const url = el("input", "input") as HTMLInputElement;
  url.placeholder = "https://…";
  const save = el("button", "save", "Attach") as HTMLButtonElement;
  save.type = "button";
  const submit = (): void => {
    const l = label.value.trim();
    const u = url.value.trim();
    if (!l || !u) return;
    form.remove();
    void mutate((current) => linkRef(current, action.id, { label: l, url: u }, "user").doc);
  };
  save.addEventListener("click", submit);
  for (const field of [label, url]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); submit(); }
      if (event.key === "Escape") form.remove();
    });
  }
  form.append(label, url, save);
  label.focus();
  return form;
};

const render = (): void => {
  if (disposed) return;
  if (!sessionId) {
    paintNotice("Open a session to use the focus card.");
    return;
  }
  if (!doc) {
    paintNotice("Reading the focus for this session…");
    return;
  }

  root.replaceChildren();

  if (failure) {
    const notice = el("div", "notice", failure);
    root.append(notice);
  }

  if (isEmpty(doc) && !focusInput.value) {
    root.append(el("div", "focus-label", "Focus"));
    root.append(focusInput);
    focusInput.value = "";
    focusInput.classList.add("is-empty");
    autoSizeFocus();
    root.append(addRow());
    root.append(el("div", "empty", "Set the focus and add the first action, or let the agent start it with the focus tools."));
    scheduleHeight();
    return;
  }

  root.append(el("div", "focus-label", "Focus"));
  if (document.activeElement !== focusInput) {
    focusInput.value = doc.focus;
    focusInput.classList.toggle("is-empty", !doc.focus);
  }
  autoSizeFocus();
  root.append(focusInput);

  const { done, total } = progress(doc);
  const bar = el("div", "bar");
  const track = el("div", "track");
  const fill = el("div", "fill");
  fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  track.append(fill);
  bar.append(track, el("span", "count", `${done} / ${total} done`));
  root.append(bar);

  const { active, completed } = displayOrder(doc);

  if (active.length) {
    const list = el("ul", "actions");
    for (const action of active) list.append(rowFor(action));
    root.append(list);
  }

  if (completed.length) {
    root.append(el("div", "divider", "done"));
    const list = el("ul", "actions");
    for (const action of completed) list.append(rowFor(action));
    root.append(list);
  }

  root.append(addRow());
  scheduleHeight();
};

const addRow = (): HTMLDivElement => {
  const wrap = el("div", "add-row");
  wrap.append(addInput);
  return wrap;
};

const paintNotice = (message: string): void => {
  root.replaceChildren(el("div", "empty", message));
  scheduleHeight();
};

const renderLater = (): void => { render(); };

/* ------------------------------------------------------------------ height */

let heightTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleHeight = (): void => {
  if (heightTimer) clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    const measured = document.body.scrollHeight;
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(measured)));
    void host.setHeight(clamped).catch(() => undefined);
  }, 30);
};

/* --------------------------------------------------------- status controls */

const promptText = (current: FocusDoc): string => {
  const { active, completed } = displayOrder(current);
  const lines = [`Session focus: ${current.focus || "(not set)"}`, ""];
  if (active.length) {
    lines.push("Still to do:");
    for (const action of active) {
      lines.push(`- [${action.state === "doing" ? ">" : " "}] ${action.text}${refsSuffix(action)}`);
    }
    lines.push("");
  }
  if (completed.length) {
    lines.push("Done:");
    for (const action of completed) {
      lines.push(`- [x] ${action.text}${refsSuffix(action)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
};

const refsSuffix = (action: FocusAction): string =>
  action.refs.length ? ` (${action.refs.map((ref) => `${ref.label} ${ref.url}`).join(", ")})` : "";

const publishControls = (): void => {
  const controls = [
    { kind: "button" as const, id: "copy", label: "Copy as prompt" },
    { kind: "button" as const, id: "refresh", label: "Refresh" },
  ];
  void host.setStatusControls(controls).catch(() => undefined);
};

host.onStatusControl((event: GuestStatusControlEvent) => {
  if (event.id === "refresh") {
    void refresh(true);
    return;
  }
  if (event.id === "copy" && doc) {
    void host.writeClipboard(promptText(doc).slice(0, 32_000))
      .then(() => host.toast({ kind: "success", message: "Focus copied" }))
      .catch(() => undefined);
  }
});

/* ------------------------------------------------------------------ wiring */

const refresh = async (force = false): Promise<void> => {
  if (!sessionId) return;
  try {
    const raw = await readStore();
    const next = parseDoc(raw, sessionId);
    if (force || !doc || next.revision !== doc.revision) {
      doc = next;
      failure = null;
      render();
    }
  } catch (error) {
    failure = describe(error);
    render();
  }
};

let poll: ReturnType<typeof setInterval> | null = null;

const startPolling = (): void => {
  if (poll) clearInterval(poll);
  poll = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (document.activeElement === focusInput || focusDirty) return;
    void refresh();
  }, POLL_MS);
};

let lastSessionId: string | null = null;

const applySession = (session: SessionSnapshot | null): void => {
  const nextId = session?.id ?? null;
  if (nextId === lastSessionId && doc) return;
  lastSessionId = nextId;
  sessionId = nextId;
  doc = null;
  failure = null;
  render();
  void refresh(true);
};

host.onReady((ctx: HostReadyContext) => {
  applyHostReady(ctx, document.documentElement);
  applySession(ctx.session);
  if (ctx.surface === "status") publishControls();
});

host.onSession((session) => { applySession(session); });
host.onSessionLifecycle((event) => {
  if (event.phase === "completed") void refresh();
});
host.onDirectory((directory) => {
  if (!directory) {
    sessionId = null;
    doc = null;
    lastSessionId = null;
    render();
  }
});

startPolling();

const teardown = (): void => {
  disposed = true;
  if (poll) clearInterval(poll);
  if (heightTimer) clearTimeout(heightTimer);
  if (focusTimer) clearTimeout(focusTimer);
};
window.addEventListener("pagehide", teardown);

render();
export {};
