function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const push = (type, value) => tokens.push({ type, value, line });
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^(?:\s+|%[^\n]*(?:\n|$))/);
    if (whitespace) { line += (whitespace[0].match(/\n/g) ?? []).length; index += whitespace[0].length; continue; }
    const operator = rest.match(/^(?::-|\?-)/);
    if (operator) { push(operator[0], operator[0]); index += operator[0].length; continue; }
    const punctuation = rest.match(/^[(),.?]/);
    if (punctuation) { push(punctuation[0], punctuation[0]); index += 1; continue; }
    const quoted = rest.match(/^'((?:[^'\\]|\\.)*)'/);
    if (quoted) { push("atom", quoted[1].replace(/\\'/g, "'")); index += quoted[0].length; continue; }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      const value = identifier[0];
      push(/^[A-Z_]/.test(value) ? "variable" : "atom", value);
      index += value.length;
      continue;
    }
    const number = rest.match(/^-?\d+(?:\.\d+)?/);
    if (number) { push("atom", number[0]); index += number[0].length; continue; }
    throw new Error(`Unexpected Prolog token at character ${index + 1}`);
  }
  return tokens;
}

class Parser {
  constructor(source) { this.tokens = tokenize(source); this.position = 0; }
  peek(type) { return this.tokens[this.position]?.type === type; }
  take(type) {
    const token = this.tokens[this.position];
    if (!token || (type && token.type !== type)) throw new Error(`Expected ${type}, found ${token?.value ?? "end of input"}`);
    this.position += 1;
    return token;
  }
  term(variables) {
    if (this.peek("variable")) {
      const name = this.take().value;
      if (name === "_") return { type: "variable", name, key: Symbol("_") };
      if (!variables.has(name)) variables.set(name, { type: "variable", name, key: Symbol(name) });
      return variables.get(name);
    }
    const functor = this.take("atom").value;
    const args = [];
    if (this.peek("(")) {
      this.take("(");
      args.push(this.term(variables));
      while (this.peek(",")) { this.take(","); args.push(this.term(variables)); }
      this.take(")");
    }
    return { type: "term", functor, args };
  }
  goals(variables) {
    const goals = [this.term(variables)];
    while (this.peek(",")) { this.take(","); goals.push(this.term(variables)); }
    return goals;
  }
}

export function parseProgram(source) {
  const parser = new Parser(source);
  const clauses = [];
  while (parser.position < parser.tokens.length) {
    const line = parser.tokens[parser.position].line;
    const variables = new Map();
    const head = parser.term(variables);
    const body = parser.peek(":-") ? (parser.take(":-"), parser.goals(variables)) : [];
    parser.take(".");
    clauses.push({ head, body, line });
  }
  return clauses;
}

export function parseQuery(source) {
  const parser = new Parser(source.trim());
  if (parser.peek("?-")) parser.take("?-");
  const variables = new Map();
  const goals = parser.goals(variables);
  if (parser.peek(".") || parser.peek("?")) parser.take();
  if (parser.position !== parser.tokens.length) throw new Error(`Unexpected token ${parser.tokens[parser.position].value}`);
  return { goals, variables };
}

export function formatTerm(term) {
  if (term.type === "variable") return term.name;
  return term.args.length ? `${term.functor}(${term.args.map(formatTerm).join(", ")})` : term.functor;
}
