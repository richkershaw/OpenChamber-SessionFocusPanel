/**
 * The card's rendering.
 *
 * Everything that turns a `FocusDoc` into DOM lives here, so it can be driven
 * against a fixture document in a test without a host connection. `main.ts` owns
 * the other half: the host bridge, polling and writes.
 *
 * Nothing here talks to the host — the handlers are injected, and the view holds
 * no state beyond the two inputs it keeps across renders (so typing survives a
 * poll-driven repaint) and whether the status picker is open.
 */

import {
  ACTIVITY,
  ACTIVITY_STATES,
  displayOrder,
  formatElapsed,
  progress,
  type Activity,
  type ActivityState,
  type FocusAction,
  type FocusDoc,
  type FocusRef,
  type MotionClass,
} from "../shared/store.ts";

export interface CardHandlers {
  onFocus(text: string): void;
  onAddAction(text: string): void;
  onTick(action: FocusAction): void;
  onDrop(actionId: string): void;
  onAttachRef(actionId: string, ref: FocusRef): void;
  onOpenRef(ref: FocusRef): void;
  onSetStatus(state: ActivityState, detail: string): void;
  onClearStatus(): void;
}

export interface CardOptions {
  /** Live session state. A loop claims work is progressing, so it is gated on this. */
  busy: boolean;
  now: number;
}

export interface CardView {
  update(doc: FocusDoc | null, options: CardOptions): void;
  /** Draw a failure in place of the card, rather than throwing it away. */
  fail(message: string): void;
}

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* --------------------------------------------------------------- vocabulary */

/**
 * The motion actually applied.
 *
 * A `loop` is a claim that work is progressing. If the session is not busy, that
 * claim is false, so the state is drawn static instead — an animation that lies
 * is worse than none, and this is what stops a forgotten status from looking
 * alive.
 */
export const motionFor = (state: ActivityState, busy: boolean): MotionClass => {
  const motion = ACTIVITY[state].motion;
  return motion === "loop" && !busy ? "static" : motion;
};

export const statusText = (activity: Activity): string => {
  const { label } = ACTIVITY[activity.state];
  return activity.detail ? `${label}: ${activity.detail}` : label;
};

export const statusAge = (activity: Activity, now: number): string =>
  formatElapsed(now - activity.since);

/* -------------------------------------------------------------------- icons */

/**
 * Simple 16×16 stroked glyphs, drawn here rather than pulled from a dependency:
 * the SDK's `icon()` helper ships four primitives (`search`, `chevron`, `check`,
 * `close`) and nothing shaped like a flask or a warning triangle.
 *
 * The `loop` states are deliberately the more radially symmetric shapes, so a
 * rotating glyph reads as motion rather than as skew.
 */
const ICON_PATHS: Record<ActivityState, string[]> = {
  planning: ["M13.2 8A5.2 5.2 0 1 1 9.5 3.1", "M8 8h.01"],
  implementing: ["M6 4.4L2.4 8 6 11.6", "M10 4.4L13.6 8 10 11.6"],
  testing: ["M6.4 2.2h3.2", "M7 2.2v3.9l-2.7 4.5a1.3 1.3 0 0 0 1.1 1.9h5.2a1.3 1.3 0 0 0 1.1-1.9L9 6.1V2.2"],
  reviewing: ["M10.6 10.6L14 14", "M11.6 7a4.6 4.6 0 1 1-9.2 0 4.6 4.6 0 0 1 9.2 0z"],
  "waiting-decision": ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M6.3 6.1a1.75 1.75 0 1 1 2.4 1.9c-.5.2-.7.6-.7 1v.3", "M8 11.6h.01"],
  "waiting-manual": ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M6.6 6.6l3.2 2.7-1.6.5.8 1.4", "M6.6 6.6v3.2"],
  "waiting-external": ["M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z", "M8 4.8V8l2.3 1.5"],
  blocked: ["M8 2.6l5.6 9.6H2.4z", "M8 6.6v2.6", "M8 11.2h.01"],
  idle: ["M6.2 3.6v8.8", "M9.8 3.6v8.8"],
  done: ["M3.6 8.4l3 3 5.8-6.4"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

export const iconFor = (state: ActivityState): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", state);
  for (const d of ICON_PATHS[state]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
};

/* --------------------------------------------------------------------- card */

export const createCard = (root: HTMLElement, handlers: CardHandlers): CardView => {
  let doc: FocusDoc | null = null;
  let options: CardOptions = { busy: false, now: Date.now() };
  let failure: string | null = null;
  let pickerOpen = false;
  let detailDraft = "";

  // Created once and re-appended, so typing survives a repaint.
  const focusInput = el("textarea", "focus-input") as HTMLTextAreaElement;
  focusInput.rows = 2;
  focusInput.placeholder = "What is this session doing?";
  focusInput.spellcheck = false;
  focusInput.setAttribute("aria-label", "Focus");

  const addInput = el("input", "input") as HTMLInputElement;
  addInput.type = "text";
  addInput.placeholder = "Add an action, then Enter";
  addInput.setAttribute("aria-label", "Add an action");

  const autoSizeFocus = (): void => {
    if (!focusInput.isConnected) return;
    focusInput.style.height = "auto";
    focusInput.style.height = `${focusInput.scrollHeight + 2}px`;
  };

  focusInput.addEventListener("input", autoSizeFocus);
  focusInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      focusInput.blur();
    }
  });
  focusInput.addEventListener("blur", () => handlers.onFocus(focusInput.value));

  addInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const text = addInput.value.trim();
    if (!text) return;
    addInput.value = "";
    handlers.onAddAction(text);
  });

  /* ------------------------------------------------------------- status row */

  const statusRow = (): HTMLElement => {
    const row = el("div", "status-row");
    const activity = doc?.status;

    if (!activity) {
      row.dataset.empty = "true";
      const button = el("button", "status-open") as HTMLButtonElement;
      button.type = "button";
      button.append(el("span", "status-blank", "◦"), el("span", "status-label", "Set a status"));
      button.addEventListener("click", () => {
        pickerOpen = true;
        detailDraft = "";
        repaint();
      });
      row.append(button);
      return row;
    }

    row.dataset.state = activity.state;
    row.dataset.motion = motionFor(activity.state, options.busy);
    row.dataset.tone = ACTIVITY[activity.state].tone;

    const button = el("button", "status-open") as HTMLButtonElement;
    button.type = "button";
    button.title = "Change status";
    button.append(iconFor(activity.state));
    button.append(el("span", "status-label", statusText(activity)));
    button.append(el("span", "status-age", statusAge(activity, options.now)));
    button.addEventListener("click", () => {
      pickerOpen = true;
      detailDraft = activity.detail;
      repaint();
    });
    row.append(button);
    return row;
  };

  const statusPicker = (): HTMLElement => {
    const panel = el("div", "status-picker");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Set the status");

    const detail = el("input", "input") as HTMLInputElement;
    detail.type = "text";
    detail.placeholder = "What are you doing in it? (optional)";
    detail.value = detailDraft;
    detail.addEventListener("input", () => { detailDraft = detail.value; });

    const commit = (state: ActivityState | null): void => {
      pickerOpen = false;
      if (state) handlers.onSetStatus(state, detailDraft.trim());
      else handlers.onClearStatus();
      repaint();
    };

    const list = el("div", "status-options");
    for (const state of ACTIVITY_STATES) {
      const option = el("button", "status-option") as HTMLButtonElement;
      option.type = "button";
      option.dataset.state = state;
      option.dataset.tone = ACTIVITY[state].tone;
      option.setAttribute("aria-pressed", String(doc?.status?.state === state));
      option.append(iconFor(state), el("span", "status-label", ACTIVITY[state].label));
      option.title = ACTIVITY[state].hint;
      option.addEventListener("click", () => commit(state));
      list.append(option);
    }

    panel.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      pickerOpen = false;
      repaint();
    });

    const clear = el("button", "status-clear", "Clear status") as HTMLButtonElement;
    clear.type = "button";
    clear.addEventListener("click", () => commit(null));

    panel.append(detail, list, clear);
    return panel;
  };

  /* -------------------------------------------------------------- action rows */

  const actionRow = (action: FocusAction): HTMLLIElement => {
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
    tick.addEventListener("click", () => handlers.onTick(action));
    row.append(tick);

    const body = el("div", "body");
    body.append(el("div", "text", action.text));

    if (action.refs.length) {
      const refs = el("div", "refs");
      for (const ref of action.refs) {
        const chip = el("button", "ref", ref.label) as HTMLButtonElement;
        chip.type = "button";
        chip.title = ref.url;
        chip.addEventListener("click", () => handlers.onOpenRef(ref));
        refs.append(chip);
      }
      body.append(refs);
    }
    row.append(body);

    const tools = el("div", "row-tools");
    const link = el("button", "icon-btn", "🔗") as HTMLButtonElement;
    link.type = "button";
    link.title = "Attach a ticket, ADR or PR";
    link.addEventListener("click", () => row.after(refForm(action)));
    tools.append(link);

    if (action.state !== "dropped") {
      const drop = el("button", "icon-btn", "✕") as HTMLButtonElement;
      drop.type = "button";
      drop.title = "Drop this action";
      drop.addEventListener("click", () => handlers.onDrop(action.id));
      tools.append(drop);
    }
    row.append(tools);
    return row;
  };

  const refForm = (action: FocusAction): HTMLDivElement => {
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
      handlers.onAttachRef(action.id, { label: l, url: u });
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

  const actionList = (actions: FocusAction[]): HTMLUListElement => {
    const ul = el("ul", "actions");
    for (const action of actions) ul.append(actionRow(action));
    return ul;
  };

  /* ------------------------------------------------------------------- paint */

  const repaint = (): void => {
    root.replaceChildren();

    if (failure) root.append(el("div", "notice", failure));

    if (!doc) {
      root.append(el("div", "empty", "Loading the focus…"));
      return;
    }

    // An untouched card has nothing to report a status against.
    if (!doc.focus && !doc.actions.length) {
      focusInput.value = "";
      focusInput.classList.add("is-empty");
      root.append(focusInput);
      autoSizeFocus();
      root.append(addInput);
      root.append(el("div", "empty", "Set the focus and add the first action, or let the agent start it with the focus tools."));
      return;
    }

    if (document.activeElement !== focusInput) {
      focusInput.value = doc.focus;
      focusInput.classList.toggle("is-empty", !doc.focus);
    }
    root.append(focusInput);
    autoSizeFocus();

    root.append(statusRow());
    if (pickerOpen) root.append(statusPicker());

    const { done, total } = progress(doc);
    const bar = el("div", "bar");
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
    track.append(fill);
    bar.append(track, el("span", "count", `${done} / ${total} done`));
    root.append(bar);

    const { active, completed } = displayOrder(doc);
    if (active.length) root.append(actionList(active));
    if (completed.length) {
      root.append(el("div", "divider", "done"));
      root.append(actionList(completed));
    }

    root.append(addInput);
  };

  return {
    update(next, nextOptions) {
      doc = next;
      options = nextOptions;
      failure = null;
      repaint();
    },
    fail(message) {
      failure = message;
      repaint();
    },
  };
};
