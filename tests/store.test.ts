import assert from "node:assert/strict";
import test from "node:test";

import {
  addAction,
  applyMutation,
  beginAction,
  completeAction,
  currentAction,
  displayOrder,
  dropAction,
  emptyDoc,
  isEmpty,
  linkRef,
  parseDoc,
  progress,
  serializeDoc,
  setFocus,
  storePath,
} from "../shared/store.ts";

const SESSION = "ses_test0123456789";

const build = () => {
  let doc = emptyDoc(SESSION, 1_000);
  doc = setFocus(doc, { focus: "Prove the round-trip." }, "agent", 1_001);
  doc = addAction(doc, { text: "First" }, "agent", 1_002).doc;
  doc = addAction(doc, { text: "Second" }, "agent", 1_003).doc;
  doc = addAction(doc, { text: "Third" }, "agent", 1_004).doc;
  return doc;
};

test("store path is project-relative and session-keyed", () => {
  assert.equal(storePath(SESSION), `.openchamber/session-focus/${SESSION}.json`);
});

test("round-trips through serialize and parse", () => {
  const doc = build();
  const parsed = parseDoc(serializeDoc(doc), SESSION, 9_999);
  assert.equal(parsed.focus, "Prove the round-trip.");
  assert.equal(parsed.revision, doc.revision);
  assert.deepEqual(parsed.actions.map((a) => a.text), ["First", "Second", "Third"]);
});

test("serialized output is stable and newline-terminated", () => {
  const doc = build();
  const once = serializeDoc(doc);
  assert.equal(once.endsWith("}\n"), true);
  assert.equal(serializeDoc(parseDoc(once, SESSION)), once);
});

test("a missing, malformed or foreign document yields an empty one", () => {
  for (const raw of [undefined, null, "", "   ", "{not json", "[]", '"text"']) {
    const doc = parseDoc(raw as string | undefined, SESSION, 500);
    assert.equal(doc.sessionId, SESSION);
    assert.equal(doc.actions.length, 0);
    assert.equal(isEmpty(doc), true);
  }
});

test("drops malformed actions and unknown states", () => {
  const raw = JSON.stringify({
    version: 1,
    revision: 4,
    focus: "x",
    actions: [
      { id: "a1", text: "keep", state: "nonsense" },
      { id: "", text: "no id" },
      { id: "a2", text: "" },
      { id: "a1", text: "duplicate id" },
      { id: "a3", text: "also keep", refs: [{ label: "ADR-1", url: "https://x" }, { label: "bad" }] },
    ],
  });
  const doc = parseDoc(raw, SESSION);
  assert.deepEqual(doc.actions.map((a) => a.id), ["a1", "a3"]);
  assert.equal(doc.actions[0].state, "todo");
  assert.deepEqual(doc.actions[1].refs, [{ label: "ADR-1", url: "https://x" }]);
});

test("display order puts active first and completed second, both in implementation order", () => {
  let doc = build();
  doc = completeAction(doc, "a1", "agent", 2_000).doc;
  doc = beginAction(doc, "a2", "agent", 2_001).doc;
  const { active, completed } = displayOrder(doc);
  assert.deepEqual(active.map((a) => a.id), ["a2", "a3"]);
  assert.deepEqual(completed.map((a) => a.id), ["a1"]);
});

test("a new action lands above the completed block", () => {
  let doc = build();
  doc = completeAction(doc, "a1", "agent", 2_000).doc;
  doc = addAction(doc, { text: "Fourth" }, "agent", 2_001).doc;
  const { active, completed } = displayOrder(doc);
  assert.deepEqual(active.map((a) => a.text), ["Second", "Third", "Fourth"]);
  assert.deepEqual(completed.map((a) => a.text), ["First"]);
  // and its position in the stored array is still last
  assert.equal(doc.actions[doc.actions.length - 1].text, "Fourth");
});

test("position 'next' inserts at the top of the active block", () => {
  let doc = build();
  doc = addAction(doc, { text: "Urgent", position: "next" }, "agent", 2_000).doc;
  assert.deepEqual(displayOrder(doc).active.map((a) => a.text), ["Urgent", "First", "Second", "Third"]);
});

test("only one action is ever doing", () => {
  let doc = build();
  doc = beginAction(doc, "a1", "agent", 2_000).doc;
  assert.equal(currentAction(doc)?.id, "a1");
  doc = beginAction(doc, "a2", "agent", 2_001).doc;
  assert.equal(currentAction(doc)?.id, "a2");
  assert.equal(doc.actions.filter((a) => a.state === "doing").length, 1);
  assert.equal(doc.actions[0].state, "todo");
});

test("begin with no id takes the current doing action, else the first todo", () => {
  let doc = build();
  doc = beginAction(doc, undefined, "agent", 2_000).doc;
  assert.equal(currentAction(doc)?.id, "a1");
  doc = beginAction(doc, undefined, "agent", 2_001).doc;
  assert.equal(currentAction(doc)?.id, "a1", "still a1, because a1 is already doing");
  doc = completeAction(doc, undefined, "agent", 2_002).doc;
  assert.equal(doc.actions[0].state, "done");
  doc = beginAction(doc, undefined, "agent", 2_003).doc;
  assert.equal(currentAction(doc)?.id, "a2");
});

test("completing records both started and completed timestamps", () => {
  let doc = build();
  doc = completeAction(doc, "a2", "agent", 2_000).doc;
  const action = doc.actions.find((a) => a.id === "a2")!;
  assert.equal(action.state, "done");
  assert.equal(action.startedAt, 2_000);
  assert.equal(action.completedAt, 2_000);
});

test("progress counts done against everything not dropped", () => {
  let doc = build();
  doc = completeAction(doc, "a1", "agent", 2_000).doc;
  doc = dropAction(doc, "a2", "agent", 2_001).doc;
  assert.deepEqual(progress(doc), { done: 1, total: 2 });
  assert.deepEqual(displayOrder(doc).completed.map((a) => a.id), ["a1", "a2"]);
});

test("links accumulate and reject incomplete refs", () => {
  let doc = build();
  doc = linkRef(doc, "a1", { label: "#42", url: "https://example.com/42" }, "agent", 2_000).doc;
  doc = linkRef(doc, "a1", { label: "", url: "https://example.com/x" }, "agent", 2_001).doc;
  doc = linkRef(doc, "a1", { label: "ADR-7", url: "https://example.com/7" }, "user", 2_002).doc;
  assert.deepEqual(doc.actions[0].refs.map((r) => r.label), ["#42", "ADR-7"]);
  assert.equal(doc.actions[0].refs[0].url, "https://example.com/42");
});

test("mutations bump the revision and record the writer", () => {
  let doc = emptyDoc(SESSION, 1_000);
  assert.equal(doc.revision, 0);
  doc = setFocus(doc, { focus: "a" }, "user", 1_001);
  assert.equal(doc.revision, 1);
  assert.equal(doc.updatedBy, "user");
  assert.equal(doc.updatedAt, 1_001);
  doc = setFocus(doc, { focus: "b" }, "agent", 1_002);
  assert.equal(doc.revision, 2);
  assert.equal(doc.updatedBy, "agent");
});

test("unknown ids are no-ops rather than errors", () => {
  const doc = build();
  assert.equal(beginAction(doc, "nope", "agent").doc, doc);
  assert.equal(completeAction(doc, "nope", "agent").doc, doc);
  assert.equal(dropAction(doc, "nope", "agent").doc, doc);
  assert.equal(linkRef(doc, "nope", { label: "x", url: "y" }, "agent").doc, doc);
});

test("applyMutation performs a read-modify-write", async () => {
  let file = serializeDoc(emptyDoc(SESSION, 1_000));
  const read = async () => file;
  const write = async (content: string) => { file = content; };

  const result = await applyMutation(SESSION, read, write, (doc) =>
    addAction(doc, { text: "Added" }, "agent", 2_000).doc, { now: 2_000 });

  assert.equal(result.actions[0].text, "Added");
  assert.equal(parseDoc(file, SESSION).actions[0].text, "Added");
  assert.equal(parseDoc(file, SESSION).revision, 1);
});

test("applyMutation replays the change when a rival lands after it", async () => {
  let file = serializeDoc(emptyDoc(SESSION, 1_000));
  let rival = false;
  const read = async () => file;
  const write = async (content: string) => {
    file = content;
    // A competing writer lands on top of ours, exactly once.
    if (!rival) {
      rival = true;
      file = serializeDoc(setFocus(parseDoc(file, SESSION), { focus: "from the panel" }, "user", 1_500));
    }
  };

  const result = await applyMutation(SESSION, read, write, (doc) =>
    addAction(doc, { text: "Mine" }, "agent", 2_000).doc, { now: 2_000 });

  const final = parseDoc(file, SESSION);
  assert.equal(final.focus, "from the panel", "the competing write survives");
  assert.equal(final.actions.some((a) => a.text === "Mine"), true, "ours was replayed on top");
  assert.equal(result.actions.some((a) => a.text === "Mine"), true);
});

test("applyMutation leaves the document alone when it cannot win", async () => {
  const file = serializeDoc(emptyDoc(SESSION, 1_000));
  const read = async () => file;
  // Every write is immediately undone by a rival, so no write ever sticks.
  const write = async () => {};

  const result = await applyMutation(SESSION, read, write, (doc) =>
    addAction(doc, { text: "Mine" }, "agent", 2_000).doc, { now: 2_000, retries: 1 });

  assert.equal(result.actions.length, 0);
});
