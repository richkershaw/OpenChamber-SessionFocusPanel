/**
 * The Session Focus card — `contributes.statusSection` in the chat's Work Status
 * panel.
 *
 * This is the wiring half: the host bridge, the store, polling and writes. All of
 * the rendering lives in `card.ts`, which knows nothing about the host and can be
 * driven against a fixture document in a test.
 *
 * The host unloads this frame whenever the section is collapsed or hidden, so
 * nothing here is kept between mounts: every mount rebuilds from the file.
 */

import { connectHost, HostRequestError } from "@openchamber/sdk";
import type { GuestStatusControlEvent, HostReadyContext, SessionSnapshot } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";

import { createCard, el } from "./card.ts";
import {
  ACTIVITY,
  addAction,
  applyMutation,
  beginAction,
  clearActivity,
  completeAction,
  displayOrder,
  dropAction,
  linkRef,
  parseDoc,
  setActivity,
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
let busy = false;
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

const describe = (error: unknown): string => {
  if (error instanceof HostRequestError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
};

/* ------------------------------------------------------------------- view */

const card = createCard(root, {
  onFocus(text: string) {
    void mutate((current) => setFocus(current, { focus: text }, "user"));
  },
  onAddAction(text: string) {
    void mutate((current) => addAction(current, { text }, "user").doc);
  },
  onTick(action: FocusAction) {
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
  },
  onDrop(actionId: string) {
    void mutate((current) => dropAction(current, actionId, "user").doc);
  },
  onAttachRef(actionId: string, ref) {
    void mutate((current) => linkRef(current, actionId, ref, "user").doc);
  },
  onOpenRef(ref) {
    void host.openUrl(ref.url);
  },
  onSetStatus(state, detail) {
    void mutate((current) => setActivity(current, { state, detail }, "user"));
  },
  onClearStatus() {
    void mutate((current) => clearActivity(current, "user"));
  },
});

const paint = (): void => {
  card.update(doc, { busy, now: Date.now() });
  scheduleHeight();
};

const paintNotice = (message: string): void => {
  root.replaceChildren(el("div", "empty", message));
  scheduleHeight();
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
    doc = await applyMutation(sessionId, readStore, writeStore, (current) =>
      apply({ ...current, updatedBy: writer }));
  } catch (error) {
    card.fail(describe(error));
    scheduleHeight();
    return;
  }
  paint();
};

/* ----------------------------------------------------------------- height */

let heightTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleHeight = (): void => {
  if (heightTimer) clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.ceil(document.body.scrollHeight)));
    void host.setHeight(clamped).catch(() => undefined);
  }, 30);
};

/* -------------------------------------------------------- status controls */

const refsSuffix = (action: FocusAction): string =>
  action.refs.length ? ` (${action.refs.map((ref) => `${ref.label} ${ref.url}`).join(", ")})` : "";

const promptText = (current: FocusDoc): string => {
  const { active, completed } = displayOrder(current);
  const lines: string[] = [`Focus: ${current.focus || "(not set)"}`];
  if (current.status) {
    const detail = current.status.detail ? `: ${current.status.detail}` : "";
    lines.push(`Status: ${ACTIVITY[current.status.state].label}${detail}`);
  }
  lines.push("");
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

const publishControls = (): void => {
  void host.setStatusControls([
    { kind: "button", id: "copy", label: "Copy as prompt" },
    { kind: "button", id: "refresh", label: "Refresh" },
  ]).catch(() => undefined);
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

/* ----------------------------------------------------------------- wiring */

const refresh = async (force = false): Promise<void> => {
  if (!sessionId) return;
  try {
    const next = parseDoc(await readStore(), sessionId);
    if (force || !doc || next.revision !== doc.revision) {
      doc = next;
      paint();
    }
  } catch (error) {
    card.fail(describe(error));
    scheduleHeight();
  }
};

let poll: ReturnType<typeof setInterval> | null = null;
poll = setInterval(() => {
  if (document.visibilityState === "hidden") return;
  if (document.activeElement instanceof HTMLInputElement) return;
  if (document.activeElement instanceof HTMLTextAreaElement) return;
  void refresh();
}, POLL_MS);

let lastSessionId: string | null = null;

const applySession = (session: SessionSnapshot | null): void => {
  busy = session?.busy ?? false;
  const nextId = session?.id ?? null;
  if (nextId === lastSessionId && doc) {
    paint();
    return;
  }
  lastSessionId = nextId;
  sessionId = nextId;
  doc = null;
  if (!sessionId) {
    paintNotice("Open a session to use the focus card.");
    return;
  }
  paintNotice("Reading the focus for this session…");
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
  if (directory) return;
  sessionId = null;
  doc = null;
  lastSessionId = null;
  paintNotice("Open a session to use the focus card.");
});

window.addEventListener("pagehide", () => {
  disposed = true;
  if (poll) clearInterval(poll);
  if (heightTimer) clearTimeout(heightTimer);
});

paintNotice("Reading the focus for this session…");

export {};
