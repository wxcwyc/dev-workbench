const STEP_PATCH_FIELDS = [
  'title',
  'description',
  'expected',
  'actionEnabled',
  'command',
  'cwd',
];

function emptyStep() {
  return {
    title: '',
    description: '',
    expected: '',
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

function expectedText(expected) {
  if (expected == null) return '';
  if (typeof expected === 'string') return expected;
  return JSON.stringify(expected, null, 2) ?? '';
}

export function createPlanDraft(session) {
  const plan = structuredClone(Array.isArray(session?.steps) ? session.steps : []);
  return {
    steps: plan.map((step) => ({
      title: step.title,
      description: step.description ?? '',
      expected: expectedText(step.expected),
      actionEnabled: step.action != null,
      command: Array.isArray(step.action?.command) ? step.action.command : [],
      cwd: step.action?.cwd ?? '',
    })),
  };
}

export function addPlanStep(draft) {
  const next = cloneDraft(draft);
  next.steps.push(emptyStep());
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
    return [{ path: '/steps', message: 'must be an array' }];
  }

  draft.steps.forEach((step, stepIndex) => {
    const path = `/steps/${stepIndex}`;
    if (!step || typeof step !== 'object') {
      issues.push({ path, message: 'must be an object' });
      return;
    }
    if (typeof step.title !== 'string' || step.title.trim() === '') {
      issues.push({ path: `${path}/title`, message: 'must be a non-empty string' });
    }
    if (typeof step.description !== 'string') {
      issues.push({ path: `${path}/description`, message: 'must be a string' });
    }
    if (typeof step.expected !== 'string') {
      issues.push({ path: `${path}/expected`, message: 'must be a string' });
    }
    if (typeof step.actionEnabled !== 'boolean') {
      issues.push({ path: `${path}/actionEnabled`, message: 'must be a boolean' });
      return;
    }
    if (!step.actionEnabled) return;
    if (!Array.isArray(step.command) || step.command.length === 0) {
      issues.push({ path: `${path}/action/command`, message: 'must be a non-empty array' });
    } else {
      step.command.forEach((argument, argumentIndex) => {
        if (typeof argument !== 'string' || argument.trim() === '') {
          issues.push({
            path: `${path}/action/command/${argumentIndex}`,
            message: 'must be a non-empty string',
          });
        }
      });
    }
    if (typeof step.cwd !== 'string') {
      issues.push({ path: `${path}/action/cwd`, message: 'must be a string' });
    }
  });
  return issues;
}

export function toPlanInput(draft) {
  const issues = validatePlanDraft(draft);
  if (issues.length > 0) {
    throw new Error(`Invalid plan at ${issues[0].path}: ${issues[0].message}`);
  }

  return {
    steps: draft.steps.map((step) => {
      const input = {
        title: step.title.trim(),
        description: step.description.trim(),
        expected: step.expected.trim() || null,
      };
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
