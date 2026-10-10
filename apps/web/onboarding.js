import { t } from "./i18n.js";
const WORKBENCHES = new Set(["execution", "migration"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function formatArgument(argument) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

export function safePreviewUrl(value) {
  if (value === "about:blank") return value;
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\//.test(value)) {
    return "about:blank";
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && parsed.hostname === "127.0.0.1"
      && parsed.username === ""
      && parsed.password === ""
      ? parsed.href
      : "about:blank";
  } catch {
    return "about:blank";
  }
}

export function parseSessionImport(text) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const position = error.message.match(/position\s+(\d+)/i);
    if (!position) throw new Error(t`Invalid JSON: ${error.message}`);

    const offset = Number(position[1]);
    const preceding = text.slice(0, offset);
    const lines = preceding.split(/\r\n|\r|\n/);
    const line = lines.length;
    const column = lines.at(-1).length + 1;
    throw new Error(t`Invalid JSON at line ${line}, column ${column}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("Imported session must be an object"));
  }
  return parsed;
}

export function buildOnboardingInput({ inspection, workbench, title, imported } = {}) {
  if (!isNonEmptyString(inspection?.projectRoot)) {
    throw new Error(t("inspection.projectRoot must be a non-empty string"));
  }
  if (!WORKBENCHES.has(workbench)) {
    throw new Error(t("workbench must be execution or migration"));
  }
  if (!isNonEmptyString(title)) {
    throw new Error(t("title must be a non-empty string"));
  }
  if (imported?.workbench !== undefined && imported.workbench !== workbench) {
    throw new Error(t`Imported workbench ${imported.workbench} does not match selected workbench ${workbench}`);
  }

  if (imported === undefined || imported === null) {
    return { title, workbench, projectRoot: inspection.projectRoot, steps: [] };
  }
  if (typeof imported !== "object" || Array.isArray(imported)) {
    throw new Error(t("Imported session must be an object"));
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
        title: isNonEmptyString(step?.title) ? step.title : t`Step ${index + 1}`,
        command: Array.isArray(action?.command) && action.command.every((argument) => typeof argument === "string")
          ? action.command.map(formatArgument).join(" ")
          : "",
        cwd: isNonEmptyString(action?.cwd) ? action.cwd : ".",
        impact: action ? "project-changing" : "observation",
      };
    }),
  };
}

export function formatApiError(body) {
  const message = isNonEmptyString(body?.error) ? t(body.error) : t("Request failed");
  if (!Array.isArray(body?.details)) return message;

  const details = body.details
    .filter((detail) => isNonEmptyString(detail?.path) && isNonEmptyString(detail?.message))
    .map((detail) => `${detail.path}: ${t(detail.message)}`);
  return [message, ...details].join("\n");
}
