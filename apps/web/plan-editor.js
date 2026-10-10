import { t } from "./i18n.js";
const STEP_PATCH_FIELDS = [
  'title',
  'description',
  'expected',
  'risk',
  'dependsOn',
  'actionEnabled',
  'command',
  'cwd',
];

const STEP_RISKS = ['low', 'medium', 'high'];

function emptyStep(id) {
  return {
    id,
    title: '',
    description: '',
    expected: '',
    risk: 'low',
    dependsOn: [],
    actionEnabled: false,
    command: [],
    cwd: '',
  };
}

function validIndex(items, index) {
  return Number.isInteger(index) && index >= 0 && index < items.length;
}

function cloneDraft(draft) {
  return structuredClone(draft);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectedText(expected) {
  if (expected == null) return '';
  if (typeof expected === 'string') return expected;
  return JSON.stringify(expected, null, 2) ?? '';
}

export function createPlanDraft(session) {
  const plan = structuredClone(Array.isArray(session?.steps) ? session.steps : []);
  return {
    steps: plan.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description ?? '',
      expected: expectedText(step.expected),
      risk: step.risk ?? 'low',
      dependsOn: step.dependsOn ?? [],
      actionEnabled: step.action != null,
      command: Array.isArray(step.action?.command) ? step.action.command : [],
      cwd: step.action?.cwd ?? '',
    })),
  };
}

export function addPlanStep(draft, idFactory = () => globalThis.crypto.randomUUID()) {
  const next = cloneDraft(draft);
  next.steps.push(emptyStep(idFactory()));
  return next;
}

export function updatePlanStep(draft, index, patch) {
  if (!validIndex(draft.steps, index) || patch == null || typeof patch !== 'object') {
    return draft;
  }

  const next = cloneDraft(draft);
  for (const field of STEP_PATCH_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      next.steps[index][field] = structuredClone(patch[field]);
    }
  }
  return next;
}

export function movePlanStep(draft, index, direction) {
  if (!validIndex(draft.steps, index) || ![-1, 1].includes(direction)) return draft;
  const destination = index + direction;
  if (!validIndex(draft.steps, destination)) return draft;

  const next = cloneDraft(draft);
  [next.steps[index], next.steps[destination]] = [
    next.steps[destination],
    next.steps[index],
  ];
  return next;
}

export function removePlanStep(draft, index) {
  if (!validIndex(draft.steps, index)) return draft;
  const next = cloneDraft(draft);
  next.steps.splice(index, 1);
  return next;
}

export function addCommandArgument(draft, stepIndex) {
  if (!validIndex(draft.steps, stepIndex) || !Array.isArray(draft.steps[stepIndex].command)) {
    return draft;
  }
  const next = cloneDraft(draft);
  next.steps[stepIndex].command.push('');
  return next;
}

export function updateCommandArgument(draft, stepIndex, argumentIndex, value) {
  if (
    !validIndex(draft.steps, stepIndex)
    || !Array.isArray(draft.steps[stepIndex].command)
    || !validIndex(draft.steps[stepIndex].command, argumentIndex)
  ) {
    return draft;
  }
  const next = cloneDraft(draft);
  next.steps[stepIndex].command[argumentIndex] = value;
  return next;
}

export function removeCommandArgument(draft, stepIndex, argumentIndex) {
  if (
    !validIndex(draft.steps, stepIndex)
    || !Array.isArray(draft.steps[stepIndex].command)
    || !validIndex(draft.steps[stepIndex].command, argumentIndex)
  ) {
    return draft;
  }
  const next = cloneDraft(draft);
  next.steps[stepIndex].command.splice(argumentIndex, 1);
  return next;
}

export function validatePlanDraft(draft) {
  const issues = [];
  if (!draft || !Array.isArray(draft.steps)) {
    return [{ path: '/steps', message: t('must be an array') }];
  }

  draft.steps.forEach((step, stepIndex) => {
    const path = `/steps/${stepIndex}`;
    if (!isObject(step)) {
      issues.push({ path, message: t('must be an object') });
      return;
    }
    if (step.id !== undefined && (typeof step.id !== 'string' || step.id.trim() === '')) {
      issues.push({ path: `${path}/id`, message: t('must be a non-empty string') });
    }
    if (typeof step.title !== 'string' || step.title.trim() === '') {
      issues.push({ path: `${path}/title`, message: t('must be a non-empty string') });
    }
    if (typeof step.description !== 'string') {
      issues.push({ path: `${path}/description`, message: t('must be a string') });
    }
    if (typeof step.expected !== 'string') {
      issues.push({ path: `${path}/expected`, message: t('must be a string') });
    }
    if (step.risk !== undefined && !STEP_RISKS.includes(step.risk)) {
      issues.push({
        path: `${path}/risk`,
        message: t`must be one of ${STEP_RISKS.join(', ')}`,
      });
    }
    if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
      issues.push({ path: `${path}/dependsOn`, message: t('must be an array') });
    } else {
      step.dependsOn?.forEach((dependency, dependencyIndex) => {
        if (typeof dependency !== 'string') {
          issues.push({
            path: `${path}/dependsOn/${dependencyIndex}`,
            message: t('must be a string'),
          });
        }
      });
    }
    if (typeof step.actionEnabled !== 'boolean') {
      issues.push({ path: `${path}/actionEnabled`, message: t('must be a boolean') });
      return;
    }
    if (!step.actionEnabled) return;
    if (!Array.isArray(step.command) || step.command.length === 0) {
      issues.push({ path: `${path}/action/command`, message: t('must be a non-empty array') });
    } else {
      step.command.forEach((argument, argumentIndex) => {
        if (typeof argument !== 'string' || argument.trim() === '') {
          issues.push({
            path: `${path}/action/command/${argumentIndex}`,
            message: t('must be a non-empty string'),
          });
        }
      });
    }
    if (typeof step.cwd !== 'string') {
      issues.push({ path: `${path}/action/cwd`, message: t('must be a string') });
    }
  });

  const stepIndexesById = new Map();
  draft.steps.forEach((step, stepIndex) => {
    if (!isObject(step) || typeof step.id !== 'string' || !step.id.trim()) return;
    const indexes = stepIndexesById.get(step.id);
    if (indexes) {
      indexes.push(stepIndex);
      issues.push({ path: `/steps/${stepIndex}/id`, message: t('must be unique') });
    } else {
      stepIndexesById.set(step.id, [stepIndex]);
    }
  });

  draft.steps.forEach((step, stepIndex) => {
    if (!isObject(step) || !Array.isArray(step.dependsOn)) return;
    const seen = new Set();
    step.dependsOn.forEach((dependency, dependencyIndex) => {
      if (typeof dependency !== 'string') return;
      const path = `/steps/${stepIndex}/dependsOn/${dependencyIndex}`;
      if (seen.has(dependency)) {
        issues.push({ path, message: t('must be unique') });
        return;
      }
      seen.add(dependency);
      const targetIndexes = stepIndexesById.get(dependency);
      if (
        typeof step.id === 'string'
        && step.id.trim()
        && dependency === step.id
        && targetIndexes?.length === 1
      ) {
        issues.push({ path, message: t('must not reference the same step') });
        return;
      }
      if (targetIndexes === undefined) {
        issues.push({ path, message: t('must reference an existing step') });
      } else if (targetIndexes.every((targetIndex) => targetIndex > stepIndex)) {
        issues.push({ path, message: t('must reference an earlier step') });
      }
    });
  });

  return issues;
}

export function toPlanInput(draft) {
  const issues = validatePlanDraft(draft);
  if (issues.length > 0) {
    throw new Error(t`Invalid plan at ${issues[0].path}: ${issues[0].message}`);
  }

  return {
    steps: draft.steps.map((step) => {
      const input = {
        title: step.title.trim(),
        description: step.description.trim(),
        expected: step.expected.trim() || null,
      };
      if (step.id !== undefined) input.id = step.id;
      if (step.risk !== undefined) input.risk = step.risk;
      if (step.dependsOn !== undefined) input.dependsOn = structuredClone(step.dependsOn);
      if (step.actionEnabled) {
        input.action = {
          command: [...step.command],
          cwd: step.cwd.trim(),
        };
      }
      return input;
    }),
  };
}
