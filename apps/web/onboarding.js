const WORKBENCHES = new Set(["execution", "migration"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseSessionImport(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const position = error.message.match(/position\s+(\d+)/i);
    if (!position) throw new Error(`Invalid JSON: ${error.message}`);

    const offset = Number(position[1]);
    const preceding = text.slice(0, offset);
    const line = preceding.split("\n").length;
    const lastNewline = preceding.lastIndexOf("\n");
    const column = offset - lastNewline;
    throw new Error(`Invalid JSON at line ${line}, column ${column}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Imported session must be an object");
  }
  return parsed;
}

export function buildOnboardingInput({ inspection, workbench, title, imported } = {}) {
  if (!isNonEmptyString(inspection?.projectRoot)) {
    throw new Error("inspection.projectRoot must be a non-empty string");
  }
  if (!WORKBENCHES.has(workbench)) {
    throw new Error("workbench must be execution or migration");
  }
  if (!isNonEmptyString(title)) {
    throw new Error("title must be a non-empty string");
  }
  if (imported?.workbench !== undefined && imported.workbench !== workbench) {
    throw new Error(`Imported workbench ${imported.workbench} does not match selected workbench ${workbench}`);
  }

  if (imported === undefined || imported === null) {
    return { title, workbench, projectRoot: inspection.projectRoot, steps: [] };
  }
  if (typeof imported !== "object" || Array.isArray(imported)) {
    throw new Error("Imported session must be an object");
  }

  return {
    ...structuredClone(imported),
    title,
    workbench,
    projectRoot: inspection.projectRoot,
  };
}

export function summarizeOnboarding(input = {}) {
  const source = Array.isArray(input.trace)
    ? input.trace
    : Array.isArray(input.steps) ? input.steps : [];

  return {
    steps: source.map((step, index) => {
      const action = step?.action;
      return {
        title: isNonEmptyString(step?.title) ? step.title : `Step ${index + 1}`,
        command: Array.isArray(action?.command) ? action.command.join(" ") : "",
        cwd: isNonEmptyString(action?.cwd) ? action.cwd : ".",
        impact: action ? "project-changing" : "observation",
      };
    }),
  };
}

export function formatApiError(body) {
  const message = isNonEmptyString(body?.error) ? body.error : "Request failed";
  if (!Array.isArray(body?.details)) return message;

  const details = body.details
    .filter((detail) => isNonEmptyString(detail?.path) && isNonEmptyString(detail?.message))
    .map((detail) => `${detail.path}: ${detail.message}`);
  return [message, ...details].join("\n");
}
