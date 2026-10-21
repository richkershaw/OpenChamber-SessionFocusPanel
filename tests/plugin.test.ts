/**
 * Drives the plugin's real `setup` against a stand-in OpenCode context, so the
 * tool registration, the executors and the system-prompt hook are exercised
 * end to end rather than only type-checked.
 *
 * The stand-in is deliberately narrow: `tool.transform` and `session.hook` are
 * the only two things the plugin asks the host for.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import plugin from "../agent/plugin/index.ts";
import { ACTIVITY_STATES, parseDoc, storePath } from "../shared/store.ts";

const SESSION = "ses_plugintest0000001";

interface RegisteredTool {
  name: string;
  description: string;
  input: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  options?: { namespace?: string; pinned?: boolean };
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content?: unknown }>;
}

interface RegisteredHook {
  name: string;
  callback: (event: { sessionID: string; system: Array<{ type: "text"; text: string }> }) => unknown;
}

const load = async (options: Record<string, unknown> = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-focus-"));
  const tools = new Map<string, RegisteredTool>();
  const hooks: RegisteredHook[] = [];
  const namespaces: Array<{ name: string; description: string }> = [];

  const context = {
    location: { directory },
    options,
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: (namespace: { name: string; description: string }) => namespaces.push(namespace),
          add: (tool: RegisteredTool) => tools.set(tool.name, tool),
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: RegisteredHook["callback"]) => {
        hooks.push({ name, callback });
        return { dispose: async () => {} };
      },
    },
  };

  await plugin.setup(context as never);

  const call = async (name: string, input: unknown = {}): Promise<string> => {
    const tool = tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.execute(input, { sessionID: SESSION });
    return String(result.content ?? "");
  };

  const readStore = async () =>
    parseDoc(await fs.readFile(path.join(directory, storePath(SESSION)), "utf8"), SESSION);

  return { directory, tools, hooks, namespaces, call, readStore };
};

test("registers the eight focus tools in one namespace", async () => {
  const { tools, namespaces } = await load();
  assert.deepEqual([...tools.keys()].sort(), [
    "add", "begin", "complete", "drop", "get", "link", "set", "status",
  ]);
  // The catalogue line is the only sentence always visible, so it has to read as
  // an instruction rather than as a label.
  assert.equal(namespaces.length, 1);
  assert.equal(namespaces[0].name, "focus");
  assert.match(namespaces[0].description, /^Maintain this session's focus card/);
  for (const tool of tools.values()) {
    assert.ok(tool.description.length > 20, `${tool.name} has a real description`);
    assert.equal(tool.input.type, "object");
    // Pinned keeps every description in the catalogue instead of summarising the
    // namespace as "8 tools, 1 shown" — which is what stopped the agent ever
    // reading them.
    assert.equal(tool.options?.pinned, true, `${tool.name} is pinned`);
  }
});

test("nothing is written until a tool is called", async () => {
  const { call, readStore } = await load();
  assert.match(await call("get"), /No focus card for this session yet/);
  await assert.rejects(readStore(), "the store is not created by merely loading the plugin");
});

test("a full round trip lands in the store", async () => {
  const { call, readStore } = await load();

  assert.match(await call("set", { focus: "Prove the round-trip." }), /Prove the round-trip/);
  assert.match(await call("add", { text: "Write the store" }), /a1/);
  assert.match(await call("add", { text: "Write the card", label: "#42", url: "https://example.com/42" }),
    /a2/);
  assert.match(await call("begin", {}), /a1/);
  assert.match(await call("complete", {}), /a1/);

  const doc = await readStore();
  assert.equal(doc.focus, "Prove the round-trip.");
  assert.equal(doc.updatedBy, "agent");
  assert.deepEqual(doc.actions.map((a) => a.state), ["done", "todo"]);
  assert.deepEqual(doc.actions[1].refs, [{ label: "#42", url: "https://example.com/42" }]);
  assert.ok(doc.actions[0].completedAt !== undefined);
});

test("completing with no id falls through to the action in flight, then the first outstanding", async () => {
  const { call, readStore } = await load();
  await call("add", { text: "one" });
  await call("add", { text: "two" });
  await call("begin", { id: "a1" });
  await call("complete", {});
  assert.equal((await readStore()).actions[0].state, "done");
  // a1 is done, so the next bare complete takes a2
  await call("complete", {});
  assert.deepEqual((await readStore()).actions.map((a) => a.state), ["done", "done"]);
});

test("an unknown id is reported, not thrown", async () => {
  const { call } = await load();
  assert.match(await call("complete", { id: "nope" }), /No action to complete/);
  assert.match(await call("link", { id: "nope", label: "#1", url: "https://x" }), /No action with id nope/);
});

test("the context hook appends the focus block to the system instructions", async () => {
  const { call, hooks } = await load();
  await call("set", { focus: "Keep the card current." });
  await call("add", { text: "Do the thing" });

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].name, "context");

  const event = { sessionID: SESSION, system: [] as Array<{ type: "text"; text: string }> };
  await hooks[0].callback(event);

  assert.equal(event.system.length, 1);
  assert.equal(event.system[0].type, "text");
  const block = event.system[0].text;
  assert.match(block, /## Focus/);
  assert.match(block, /Keep the card current\./);
  assert.match(block, /Do the thing/);
  // the events the agent is asked to track
  assert.match(block, /Exactly one action is in flight/);
  assert.match(block, /above the completed items/);
  assert.match(block, /Attach the ticket, ADR or PR link/);
});

test("the prompt block offers every state, generated from the vocabulary", async () => {
  const { call, hooks } = await load();
  await call("set", { focus: "Keep the card current." });
  await call("status", { state: "implementing", detail: "the status row" });

  const event = { sessionID: SESSION, system: [] as Array<{ type: "text"; text: string }> };
  await hooks[0].callback(event);
  const block = event.system[0].text;

  for (const state of ACTIVITY_STATES) {
    assert.ok(block.includes(state), `${state} is offered to the agent`);
  }
  assert.match(block, /focus_status/, "the tool that sets it is named");
  assert.match(block, /Status: Implementing: the status row/, "and the current one is shown");
});

test("focus_status records the current activity", async () => {
  const { call, readStore } = await load();
  await call("set", { focus: "Ship it" });
  const rendered = await call("status", { state: "waiting-decision", detail: "which naming?" });
  assert.match(rendered, /Waiting for a decision: which naming\?/);

  const doc = await readStore();
  assert.equal(doc.status?.state, "waiting-decision");
  assert.equal(doc.status?.detail, "which naming?");
});

test("focus_set moves the task lifecycle, not the activity", async () => {
  const { call, readStore } = await load();
  await call("set", { focus: "Ship it", lifecycle: "done" });
  const doc = await readStore();
  assert.equal(doc.lifecycle, "done");
  assert.equal(doc.status, undefined, "setting the lifecycle does not invent an activity");
});

test("the hook tells an untouched session what the card is for", async () => {
  // This used to assert the opposite — `system.length === 0`, on the reasoning
  // that an empty card was "not worth the tokens". That gate was a cold-start
  // hole: a fresh session got no instructions at all, so the agent saw only the
  // tool catalogue and the card went unused. The empty session is exactly the one
  // that needs telling.
  const { hooks } = await load();
  const event = { sessionID: SESSION, system: [] as Array<{ type: "text"; text: string }> };
  await hooks[0].callback(event);

  assert.equal(event.system.length, 1, "an untouched session is told about the card");
  const block = event.system[0].text;
  assert.match(block, /## Focus/);
  assert.match(block, /focus_set/);
  assert.match(block, /card is empty\. Start it now/, "and is asked to start one");
  assert.match(block, /Status: \(not set\)/, "with the empty state spelled out");
  for (const state of ACTIVITY_STATES) {
    assert.ok(block.includes(state), `${state} is offered even before a card exists`);
  }
});

test("focus_get teaches the workflow when there is no card yet", async () => {
  // The one tool whose description the catalogue always showed, so its answer has
  // to carry the instructions rather than point at descriptions nobody reads.
  const { call } = await load();
  const guide = await call("get");
  assert.match(guide, /No focus card for this session yet/);
  assert.match(guide, /focus_set/);
  assert.match(guide, /focus_add/);
  assert.match(guide, /focus_status/);
  for (const state of ACTIVITY_STATES) {
    assert.ok(guide.includes(state), `${state} is listed`);
  }
});

test("instructions: false leaves the tools and drops the hook", async () => {
  const { tools, hooks } = await load({ instructions: false });
  assert.equal(tools.size, 8);
  assert.equal(hooks.length, 0);
});

test("the card the tool renders marks the action in flight and the progress", async () => {
  const { call } = await load();
  await call("set", { focus: "Ship it" });
  await call("add", { text: "first" });
  await call("add", { text: "second" });
  await call("begin", { id: "a1" });
  await call("complete", { id: "a1" });
  await call("begin", { id: "a2" });

  const rendered = await call("get");
  assert.match(rendered, /Focus: Ship it  \[active\]  1\/2 done/);
  assert.match(rendered, /\[>\] a2 {2}second/);
  assert.match(rendered, /\[x\] a1 {2}first/);
});
