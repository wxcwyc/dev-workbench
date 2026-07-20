import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { manifest, prologAdapter } from "../packages/prolog-adapter/src/index.js";
import { parseProgram, parseQuery } from "../packages/prolog-adapter/src/parser.js";

const collect = async (iterable) => {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
};

test("Prolog parser preserves clauses, variables and source lines", () => {
  const clauses = parseProgram("fact(a).\n\nparent(X, Y) :- fact(X), fact(Y).\n");
  const query = parseQuery("?- parent(X, Y).");
  assert.equal(clauses.length, 2);
  assert.equal(clauses[1].line, 3);
  assert.equal(clauses[1].body.length, 2);
  assert.deepEqual([...query.variables.keys()], ["X", "Y"]);
});

test("Prolog runtime derives solutions and explains branches and backtracking", async () => {
  const source = await fs.readFile(new URL("../examples/logic-trace/program.pl", import.meta.url), "utf8");
  const events = await collect(prologAdapter.run({
    sessionId: "prolog-test", source, sourcePath: "program.pl", query: "grandfather(X, Y)?"
  }));
  const solutions = events.filter((event) => event.kind === "solution").map((event) => event.state.result);

  assert.deepEqual(solutions, ["X = orville, Y = homer", "X = abe, Y = bart", "X = abe, Y = lisa"]);
  assert.ok(events.some((event) => event.kind === "branch" && event.state.choicePoint));
  assert.ok(events.some((event) => event.kind === "failure" && event.state.unification?.succeeded === false));
  assert.ok(events.some((event) => event.kind === "backtrack" && event.state.backtracking?.reason));
  assert.ok(events.some((event) => event.state.unification?.before && event.state.unification?.after));
  assert.ok(events.every((event, index) => event.sequence === index));
  assert.equal(events.find((event) => event.state.currentLine === 7)?.artifacts[0].uri, "program.pl#L7");
});

test("Prolog runtime emits an exhausted-search failure when no solution exists", async () => {
  const events = await collect(prologAdapter.run({ sessionId: "failed-query", source: "color(red).", query: "color(blue)." }));
  assert.equal(events.at(-1).kind, "failure");
  assert.equal(events.at(-1).state.failureReason, "search_exhausted");
});

test("Prolog adapter advertises trace and source location capabilities", () => {
  assert.equal(manifest.protocolVersion, "1.0");
  assert.deepEqual(manifest.capabilities, ["trace", "artifacts", "source-locations"]);
});
