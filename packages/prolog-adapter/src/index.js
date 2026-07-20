import { defineAdapter, createTraceEvent } from "../../adapter-sdk/src/index.js";
import { parseProgram, parseQuery, formatTerm } from "./parser.js";

export const manifest = Object.freeze({
  id: "dev-workbench.prolog",
  name: "Dev Workbench Prolog Runtime",
  version: "0.1.0",
  protocolVersion: "1.0",
  capabilities: ["trace", "artifacts", "source-locations"],
  description: "Trace adapter for pure Horn clauses with depth-first search and backtracking"
});

const signature = (term) => term.type === "term" ? `${term.functor}/${term.args.length}` : "variable";
const cloneBindings = (bindings) => new Map(bindings);
const dereference = (term, bindings) => term.type === "variable" && bindings.has(term.key) ? dereference(bindings.get(term.key), bindings) : term;

function freshTerm(term, variables) {
  if (term.type !== "variable") return { ...term, args: term.args.map((arg) => freshTerm(arg, variables)) };
  if (!variables.has(term.key)) variables.set(term.key, { ...term, key: Symbol(term.name) });
  return variables.get(term.key);
}

function freshClause(clause) {
  const variables = new Map();
  return { ...clause, head: freshTerm(clause.head, variables), body: clause.body.map((goal) => freshTerm(goal, variables)) };
}

function unify(left, right, bindings) {
  left = dereference(left, bindings);
  right = dereference(right, bindings);
  if (left.type === "variable") { if (right.type !== "variable" || left.key !== right.key) bindings.set(left.key, right); return true; }
  if (right.type === "variable") { bindings.set(right.key, left); return true; }
  if (left.functor !== right.functor || left.args.length !== right.args.length) return false;
  return left.args.every((argument, index) => unify(argument, right.args[index], bindings));
}

function resolvedTerm(term, bindings, seen = new Set()) {
  const resolved = dereference(term, bindings);
  if (resolved.type === "variable") return resolved.name;
  if (seen.has(resolved)) return formatTerm(resolved);
  seen.add(resolved);
  return resolved.args.length ? `${resolved.functor}(${resolved.args.map((arg) => resolvedTerm(arg, bindings, seen)).join(", ")})` : resolved.functor;
}

function visibleBindings(queryVariables, bindings) {
  return Object.fromEntries([...queryVariables].filter(([name]) => name !== "_").map(([name, variable]) => [name, resolvedTerm(variable, bindings)]));
}

function runtime({ source, query, sourcePath = "program.pl", sessionId }) {
  const clauses = parseProgram(source);
  const parsedQuery = parseQuery(query);
  const program = source.replace(/\r/g, "").split("\n");
  const sourceArtifact = (line) => [{ id: `source-${line}`, type: "source", label: `${sourcePath}:${line}`, uri: `${sourcePath}#L${line}` }];
  let sequence = 0;
  const makeEvent = (kind, title, explanation, state, artifacts = []) => createTraceEvent({
    sessionId, sequence: sequence++, kind, title, explanation, state: { program, query, ...state }, artifacts
  });
  const state = (goals, bindings, stack, extra = {}) => ({
    goals: goals.map((goal) => resolvedTerm(goal, bindings)),
    bindings: visibleBindings(parsedQuery.variables, bindings), stack, ...extra
  });

  async function* solve(goals, bindings, stack) {
    if (goals.length === 0) {
      const resultBindings = visibleBindings(parsedQuery.variables, bindings);
      yield makeEvent("solution", "Solution found", "All goals succeeded.", state([], bindings, stack, { result: Object.entries(resultBindings).map(([key, value]) => `${key} = ${value}`).join(", ") || "true" }));
      return true;
    }

    const [goal, ...remaining] = goals;
    const candidates = clauses.filter((clause) => signature(clause.head) === signature(dereference(goal, bindings)));
    if (candidates.length > 1) {
      yield makeEvent("branch", `Choice point for ${resolvedTerm(goal, bindings)}`, `${candidates.length} clauses can be tried.`, state(goals, bindings, stack, {
        choicePoint: { goal: resolvedTerm(goal, bindings), candidates: candidates.map((clause) => ({ rule: formatTerm(clause.head), line: clause.line })) }
      }));
    }
    if (candidates.length === 0) {
      yield makeEvent("failure", `No rule for ${resolvedTerm(goal, bindings)}`, "No clause has a matching predicate and arity.", state(goals, bindings, stack, { failureReason: "no_matching_rule" }));
      return false;
    }

    let solved = false;
    for (let index = 0; index < candidates.length; index += 1) {
      const clause = freshClause(candidates[index]);
      const nextBindings = cloneBindings(bindings);
      const before = visibleBindings(parsedQuery.variables, nextBindings);
      const rule = clause.body.length ? `${formatTerm(clause.head)} :- ${clause.body.map(formatTerm).join(", ")}` : formatTerm(clause.head);
      const unified = unify(goal, clause.head, nextBindings);
      if (!unified) {
        yield makeEvent("failure", `Reject rule ${rule}`, "The selected clause head does not unify with the current goal.", state(goals, bindings, stack, {
          currentLine: clause.line, unification: { goal: resolvedTerm(goal, bindings), head: formatTerm(clause.head), before, after: before, succeeded: false }
        }), sourceArtifact(clause.line));
        continue;
      }

      const nextGoals = [...clause.body, ...remaining];
      const nextStack = [{ rule, goals: nextGoals.map((item) => resolvedTerm(item, nextBindings)), bindings: visibleBindings(parsedQuery.variables, nextBindings) }, ...stack];
      yield makeEvent("evaluation", `Apply rule ${rule}`, "The clause head unified; its body goals were added to the goal list.", state(nextGoals, nextBindings, nextStack, {
        currentLine: clause.line, unification: { goal: resolvedTerm(goal, bindings), head: formatTerm(clause.head), before, after: visibleBindings(parsedQuery.variables, nextBindings), succeeded: true }
      }), sourceArtifact(clause.line));
      const branchSolved = yield* solve(nextGoals, nextBindings, nextStack);
      solved ||= branchSolved;
      if (index < candidates.length - 1) {
        yield makeEvent("backtrack", `Backtrack from ${rule}`, branchSolved ? "Search for another solution." : "A downstream goal failed; try the next clause.", state(goals, bindings, stack, {
          currentLine: clause.line, backtracking: { fromRule: rule, reason: branchSolved ? "next_solution" : "downstream_failure" }
        }), sourceArtifact(clause.line));
      }
    }
    return solved;
  }

  return (async function* () {
    const initialBindings = new Map();
    yield makeEvent("evaluation", "Start query", "Create the initial Prolog goal list.", state(parsedQuery.goals, initialBindings, [{ rule: "query", goals: parsedQuery.goals.map(formatTerm), bindings: {} }]));
    const solved = yield* solve(parsedQuery.goals, initialBindings, []);
    if (!solved) yield makeEvent("failure", "Query failed", "All matching clauses and choice points were exhausted.", state([], initialBindings, [], { failureReason: "search_exhausted" }));
  })();
}

export const prologAdapter = defineAdapter(manifest, runtime);
