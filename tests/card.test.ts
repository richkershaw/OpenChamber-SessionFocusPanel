/**
 * The card's rendering, driven against a fixture document in happy-dom.
 *
 * This exists because the card is the one part of the project a type check cannot
 * vouch for: it is DOM construction, and the two bugs found by eye — an
 * auto-size measuring a detached element, and a lost-update guard that could not
 * see a rival — were both invisible to every other test.
 *
 * happy-dom supplies the globals that `card.ts` draws against; nothing here
 * touches the host.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Window } from "happy-dom";

import { createCard, motionFor, statusAge, statusText } from "../status/card.ts";
import {
  ACTIVITY,
  ACTIVITY_STATES,
  addAction,
  beginAction,
  completeAction,
  emptyDoc,
  linkRef,
  setActivity,
  setFocus,
  type ActivityState,
  type FocusDoc,
} from "../shared/store.ts";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSION = "ses_cardtest0000001";
const NOW = 1_800_000_000_000;

/* happy-dom has to be installed before the card builds anything. */
const install = () => {
  const win = new Window({ url: "https://localhost/" });
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  return win as unknown as {
    Event: new (type: string) => Event;
    document: {
      createElement(tag: string): any;
      body: { append(node: unknown): void };
    };
  };
};

const mount = () => {
  const win = install();
  const root = win.document.createElement("div");
  win.document.body.append(root);

  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };

  const card = createCard(root, {
    onFocus: record("focus"),
    onAddAction: record("add"),
    onTick: record("tick"),
    onDrop: record("drop"),
    onAttachRef: record("attach"),
    onOpenRef: record("open"),
    onSetStatus: record("setStatus"),
    onClearStatus: record("clearStatus"),
  });

  return { win, root, card, calls };
};

const withFocus = (): FocusDoc => {
  let doc = emptyDoc(SESSION, NOW - 5_000);
  doc = setFocus(doc, { focus: "Ship the status row." }, "agent", NOW - 4_000);
  return doc;
};

const withStatus = (state: ActivityState, detail = "", since = NOW - 4 * 60_000): FocusDoc =>
  setActivity(withFocus(), { state, detail }, "agent", since);

const row = (root: any) => root.querySelector(".status-row");

/* ----------------------------------------------------------- pure helpers */

test("motionFor gates a loop on the session actually being busy", () => {
  assert.equal(motionFor("implementing", true), "loop");
  assert.equal(motionFor("implementing", false), "static", "an idle session must not look busy");
  assert.equal(motionFor("planning", false), "static");
  // Waiting and terminal states are true either way, so they are never gated.
  assert.equal(motionFor("waiting-decision", false), "attention");
  assert.equal(motionFor("waiting-manual", false), "attention");
  assert.equal(motionFor("blocked", true), "static");
  assert.equal(motionFor("done", true), "static");
});

test("statusText and statusAge describe the row", () => {
  const doc = withStatus("implementing", "the status row");
  assert.equal(statusText(doc.status!), "Implementing: the status row");
  assert.equal(statusAge(doc.status!, NOW), "4m");
  assert.equal(statusText(withStatus("idle").status!), "Idle", "a bare state needs no colon");
});

/* ------------------------------------------------------------ the status row */

test("every state renders its own glyph, label, tone and motion", () => {
  for (const state of ACTIVITY_STATES) {
    const { root, card } = mount();
    card.update(withStatus(state, "the detail"), { busy: true, now: NOW });

    const element = row(root);
    assert.equal(element.dataset.state, state);
    assert.equal(element.dataset.tone, ACTIVITY[state].tone);
    assert.equal(element.dataset.motion, ACTIVITY[state].motion);

    const svg = element.querySelector("svg[data-icon]");
    assert.ok(svg, `${state} draws a glyph`);
    assert.equal(svg.getAttribute("data-icon"), state);
    assert.ok(svg.querySelectorAll("path").length > 0, `${state} glyph has a path`);

    const label = element.querySelector(".status-label").textContent;
    assert.ok(label.includes(ACTIVITY[state].label), `${state} shows its label`);
    assert.ok(label.includes("the detail"), `${state} shows the detail`);
    assert.equal(element.querySelector(".status-age").textContent, "4m");
  }
});

test("a looping state is drawn static once the session stops being busy", () => {
  const { root, card } = mount();
  card.update(withStatus("implementing"), { busy: true, now: NOW });
  assert.equal(row(root).dataset.motion, "loop");

  card.update(withStatus("implementing"), { busy: false, now: NOW });
  assert.equal(row(root).dataset.motion, "static", "the spinner must not outlive the work");
});

test("an unset status is an invitation, not a blank", () => {
  const { root, card } = mount();
  card.update(withFocus(), { busy: false, now: NOW });

  const element = row(root);
  assert.equal(element.dataset.empty, "true");
  assert.equal(element.querySelector(".status-label").textContent, "Set a status");
  assert.equal(element.dataset.motion, undefined, "nothing claims to be moving");
  assert.equal(element.querySelector("svg[data-icon]"), null);
});

test("an untouched card shows no status row at all", () => {
  const { root, card } = mount();
  card.update(emptyDoc(SESSION, NOW), { busy: false, now: NOW });
  assert.equal(row(root), null, "nothing to attach a status to");
  assert.match(root.textContent, /Set the focus and add the first action/);
});

/* ---------------------------------------------------------------- the picker */

test("the picker is closed until asked for, then offers every state", () => {
  const { root, card } = mount();
  card.update(withStatus("implementing", "the row"), { busy: true, now: NOW });
  assert.equal(root.querySelector(".status-picker"), null);

  root.querySelector(".status-open").click();
  const picker = root.querySelector(".status-picker");
  assert.ok(picker, "opens on click");

  const options = Array.from(picker.querySelectorAll(".status-option"));
  assert.deepEqual(options.map((option: any) => option.dataset.state), ACTIVITY_STATES);

  const pressed = Array.from(picker.querySelectorAll('.status-option[aria-pressed="true"]'));
  assert.equal(pressed.length, 1, "the current state is marked");
  assert.equal((pressed[0] as any).dataset.state, "implementing");
});

test("choosing a state reports it with the detail draft", () => {
  const { win, root, card, calls } = mount();
  card.update(withStatus("implementing"), { busy: true, now: NOW });
  root.querySelector(".status-open").click();

  const detail = root.querySelector(".status-picker .input");
  detail.value = "which naming?";
  detail.dispatchEvent(new win.Event("input"));
  root.querySelector('.status-option[data-state="waiting-decision"]').click();

  assert.deepEqual(calls.setStatus, [["waiting-decision", "which naming?"]]);
  assert.equal(root.querySelector(".status-picker"), null, "and closes behind itself");
});

test("clear reports a clear rather than a state", () => {
  const { root, card, calls } = mount();
  card.update(withStatus("blocked"), { busy: false, now: NOW });
  root.querySelector(".status-open").click();
  root.querySelector(".status-clear").click();
  assert.deepEqual(calls.clearStatus, [[]]);
  assert.equal(calls.setStatus, undefined);
});

test("Escape closes the picker without choosing", () => {
  const { win, root, card, calls } = mount();
  card.update(withStatus("blocked"), { busy: false, now: NOW });
  root.querySelector(".status-open").click();

  root.querySelector(".status-picker").dispatchEvent(new win.Event("keydown")); // no-op key
  assert.ok(root.querySelector(".status-picker"));

  const escape = new win.Event("keydown");
  (escape as unknown as { key: string }).key = "Escape";
  root.querySelector(".status-picker").dispatchEvent(escape);
  assert.equal(root.querySelector(".status-picker"), null);
  assert.equal(calls.setStatus, undefined);
  assert.equal(calls.clearStatus, undefined);
});

/* -------------------------------------------------------------- action rows */

test("actions render active first, then the done divider, then completed", () => {
  const { root, card } = mount();
  let doc = withStatus("implementing");
  doc = addAction(doc, { text: "alpha" }, "agent", NOW).doc;
  doc = addAction(doc, { text: "beta" }, "agent", NOW).doc;
  doc = addAction(doc, { text: "gamma" }, "agent", NOW).doc;
  doc = completeAction(doc, "a1", "agent", NOW).doc;
  card.update(doc, { busy: false, now: NOW });

  const texts = (ul: any) =>
    Array.from(ul.querySelectorAll(".text")).map((node: any) => node.textContent);

  const lists = Array.from(root.querySelectorAll("ul.actions")) as any[];
  assert.equal(lists.length, 2, "one list each side of the divider");
  assert.deepEqual(texts(lists[0]), ["beta", "gamma"], "outstanding work, in implementation order");
  assert.deepEqual(texts(lists[1]), ["alpha"], "completed work sinks below");

  const order = Array.from(root.children).map((node: any) => node.className);
  assert.ok(order.indexOf("actions") < order.indexOf("divider"), "active block first");
  assert.ok(order.indexOf("divider") < order.lastIndexOf("actions"), "divider between them");
  assert.equal(root.querySelector(".divider").textContent, "done");
});

test("the action in flight is marked, and ticking reports that action", () => {
  const { root, card, calls } = mount();
  let doc = withStatus("implementing");
  doc = addAction(doc, { text: "alpha" }, "agent", NOW).doc;
  doc = beginAction(doc, "a1", "agent", NOW).doc;
  card.update(doc, { busy: true, now: NOW });

  const tick = root.querySelector('li.row[data-state="doing"] .tick');
  assert.equal(tick.getAttribute("aria-checked"), "false");
  assert.equal(tick.getAttribute("role"), "checkbox");
  tick.click();

  assert.equal(calls.tick?.length, 1);
  assert.equal((calls.tick![0][0] as { id: string }).id, "a1");
});

test("a reference renders as a chip and opens on click", () => {
  const { root, card, calls } = mount();
  let doc = withStatus("implementing");
  doc = addAction(doc, { text: "alpha" }, "agent", NOW).doc;
  doc = linkRef(doc, "a1", { label: "ADR-0007", url: "https://example.com/7" }, "agent", NOW).doc;
  card.update(doc, { busy: false, now: NOW });

  const chip = root.querySelector(".ref");
  assert.equal(chip.textContent, "ADR-0007");
  chip.click();
  assert.deepEqual(calls.open, [[{ label: "ADR-0007", url: "https://example.com/7" }]]);
});

/* -------------------------------------------------------------- the styling */

test("the stylesheet carries both animations and honours reduced motion", () => {
  const html = fs.readFileSync(path.join(projectRoot, "status/index.html"), "utf8");
  assert.match(html, /@keyframes sf-spin/, "the loop animation");
  assert.match(html, /@keyframes sf-breathe/, "the attention animation");
  assert.match(html, /prefers-reduced-motion: reduce/, "and it can be turned off");
  assert.match(html, /\[data-motion="loop"\]/);
  assert.match(html, /\[data-motion="attention"\]/);
});
