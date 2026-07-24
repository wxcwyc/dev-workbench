import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ProtocolValidationError,
  assertPlanInput,
} from '../packages/protocol/src/index.js';

import {
  createPlanDraft,
  addPlanStep,
  updatePlanStep,
  movePlanStep,
  removePlanStep,
  addCommandArgument,
  updateCommandArgument,
  removeCommandArgument,
  validatePlanDraft,
  toPlanInput,
} from '../apps/web/plan-editor.js';

const webHtml = readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8');
const webCss = readFileSync(new URL('../apps/web/styles.css', import.meta.url), 'utf8');

function migrationSession() {
  return {
    id: 'session-1',
    status: 'pending',
    cursor: -1,
    history: [{ type: 'session.created' }],
    steps: [
      {
        id: 'step-1',
        title: 'Inspect project',
        description: 'Read the manifest',
        expected: { scripts: ['test'] },
        risk: 'medium',
        dependsOn: [],
        attempt: 2,
        status: 'pending',
        review: { decision: 'reject' },
        action: {
          type: 'command',
          command: ['node', '-e', 'console.log("hello world")'],
          cwd: 'packages/app',
        },
      },
      {
        id: 'step-2',
        title: 'Record findings',
        description: '',
        expected: '  findings saved  ',
        risk: 'high',
        dependsOn: ['step-1'],
        attempt: 1,
        status: 'pending',
        error: 'previous failure',
      },
    ],
  };
}

function draftStep(overrides = {}) {
  return {
    id: 'step',
    title: 'Step',
    description: '',
    expected: '',
    risk: 'low',
    dependsOn: [],
    actionEnabled: false,
    command: [],
    cwd: '',
    ...overrides,
  };
}

function protocolRelationshipIssues(steps) {
  const input = {
    steps: steps.map(({ id, title, risk, dependsOn }) => ({
      id,
      title,
      risk,
      dependsOn,
    })),
  };
  try {
    assertPlanInput(input);
    return [];
  } catch (error) {
    assert.ok(error instanceof ProtocolValidationError);
    return error.issues;
  }
}

test('createPlanDraft deep-clones editable plan data without mutating the session', () => {
  const session = migrationSession();
  const original = structuredClone(session);

  const draft = createPlanDraft(session);

  assert.deepEqual(draft, {
    steps: [
      {
        id: 'step-1',
        title: 'Inspect project',
        description: 'Read the manifest',
        expected: '{\n  "scripts": [\n    "test"\n  ]\n}',
        risk: 'medium',
        dependsOn: [],
        actionEnabled: true,
        command: ['node', '-e', 'console.log("hello world")'],
        cwd: 'packages/app',
      },
      {
        id: 'step-2',
        title: 'Record findings',
        description: '',
        expected: '  findings saved  ',
        risk: 'high',
        dependsOn: ['step-1'],
        actionEnabled: false,
        command: [],
        cwd: '',
      },
    ],
  });
  draft.steps[0].command[0] = 'changed';
  draft.steps[1].dependsOn.push('changed');
  assert.deepEqual(session, original);
});

test('createPlanDraft supports an empty plan', () => {
  assert.deepEqual(createPlanDraft({ steps: [] }), { steps: [] });
});

test('addPlanStep uses an injectable ID factory and keeps generated IDs stable', () => {
  const initial = createPlanDraft(migrationSession());
  const added = addPlanStep(initial, () => 'generated-step');

  assert.deepEqual(added.steps[2], {
    id: 'generated-step',
    title: '',
    description: '',
    expected: '',
    risk: 'low',
    dependsOn: [],
    actionEnabled: false,
    command: [],
    cwd: '',
  });
  const edited = updatePlanStep(added, 2, { title: 'Generated step' });
  assert.equal(edited.steps[2].id, 'generated-step');
  assert.equal(toPlanInput(edited).steps[2].id, 'generated-step');

  const defaultAdded = addPlanStep(initial);
  assert.match(defaultAdded.steps[2].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('step operations allowlist metadata updates, reorder, and remove immutably', () => {
  const initial = createPlanDraft(migrationSession());
  const added = addPlanStep(initial, () => 'generated-step');
  const dependencies = ['step-1'];
  const updated = updatePlanStep(added, 2, {
    title: ' New step ',
    description: 'Description',
    expected: 'Expected',
    risk: 'high',
    dependsOn: dependencies,
    actionEnabled: true,
    command: ['npm', 'test'],
    cwd: ' app ',
    id: 'injected',
    attempt: 99,
    status: 'complete',
    review: { decision: 'accept' },
    error: 'injected',
    history: ['injected'],
  });
  const moved = movePlanStep(updated, 2, -1);
  const removed = removePlanStep(moved, 0);

  dependencies.push('step-2');
  assert.equal(updated.steps[2].title, ' New step ');
  assert.equal(updated.steps[2].risk, 'high');
  assert.deepEqual(updated.steps[2].dependsOn, ['step-1']);
  assert.equal(updated.steps[2].actionEnabled, true);
  assert.deepEqual(updated.steps[2].command, ['npm', 'test']);
  assert.equal(updated.steps[2].id, 'generated-step');
  assert.equal('attempt' in updated.steps[2], false);
  assert.equal('status' in updated.steps[2], false);
  assert.equal('review' in updated.steps[2], false);
  assert.equal('error' in updated.steps[2], false);
  assert.equal('history' in updated.steps[2], false);
  assert.equal(moved.steps[1].title, ' New step ');
  assert.equal(removed.steps.length, 2);
  assert.equal(initial.steps.length, 2);
  assert.equal(added.steps[2].title, '');
  assert.equal(updated.steps[2].title, ' New step ');
});

test('reordering reports the dependency that now targets a later step', () => {
  const draft = createPlanDraft(migrationSession());
  const reordered = movePlanStep(draft, 0, 1);

  assert.deepEqual(validatePlanDraft(reordered).filter(({ path }) => path.includes('/dependsOn/')), [
    { path: '/steps/0/dependsOn/0', message: 'must reference an earlier step' },
  ]);
});

test('relationship diagnostics match protocol paths, ambiguity, and invalid-ID rules', () => {
  const cases = [
    {
      name: 'duplicate step IDs',
      steps: [draftStep({ id: 'a' }), draftStep({ id: 'a' })],
      expectedIssues: [{ path: '/steps/1/id', message: 'must be unique' }],
    },
    {
      name: 'duplicate dependency',
      steps: [
        draftStep({ id: 'a' }),
        draftStep({ id: 'b', dependsOn: ['a', 'a'] }),
      ],
      expectedIssues: [{ path: '/steps/1/dependsOn/1', message: 'must be unique' }],
    },
    {
      name: 'missing target',
      steps: [draftStep({ id: 'a', dependsOn: ['missing'] })],
      expectedIssues: [
        { path: '/steps/0/dependsOn/0', message: 'must reference an existing step' },
      ],
    },
    {
      name: 'self target',
      steps: [draftStep({ id: 'a', dependsOn: ['a'] })],
      expectedIssues: [
        { path: '/steps/0/dependsOn/0', message: 'must not reference the same step' },
      ],
    },
    {
      name: 'later target',
      steps: [
        draftStep({ id: 'a', dependsOn: ['b'] }),
        draftStep({ id: 'b' }),
      ],
      expectedIssues: [
        { path: '/steps/0/dependsOn/0', message: 'must reference an earlier step' },
      ],
    },
    {
      name: 'ambiguous self target reports only duplicate ID',
      steps: [
        draftStep({ id: 'a' }),
        draftStep({ id: 'a', dependsOn: ['a'] }),
      ],
      expectedIssues: [{ path: '/steps/1/id', message: 'must be unique' }],
    },
    {
      name: 'all ambiguous targets later still reports later',
      steps: [
        draftStep({ id: 'source', dependsOn: ['a'] }),
        draftStep({ id: 'a' }),
        draftStep({ id: 'a' }),
      ],
      expectedIssues: [
        { path: '/steps/2/id', message: 'must be unique' },
        { path: '/steps/0/dependsOn/0', message: 'must reference an earlier step' },
      ],
    },
    {
      name: 'invalid source ID does not participate in self checks',
      steps: [draftStep({ id: '   ', dependsOn: ['   '] })],
      expectedIssues: [
        { path: '/steps/0/id', message: 'must be a non-empty string' },
        { path: '/steps/0/dependsOn/0', message: 'must reference an existing step' },
      ],
    },
  ];

  for (const { name, steps, expectedIssues } of cases) {
    assert.deepEqual(protocolRelationshipIssues(steps), expectedIssues, `protocol: ${name}`);
    assert.deepEqual(validatePlanDraft({ steps }), expectedIssues, `editor: ${name}`);
  }
});

test('removing a referenced step preserves the dependency and reports it missing', () => {
  const draft = createPlanDraft(migrationSession());
  const removed = removePlanStep(draft, 0);

  assert.deepEqual(removed.steps[0].dependsOn, ['step-1']);
  assert.deepEqual(validatePlanDraft(removed).filter(({ path }) => path.includes('/dependsOn/')), [
    { path: '/steps/0/dependsOn/0', message: 'must reference an existing step' },
  ]);
});

test('step operations safely no-op for invalid indices and boundary moves', () => {
  const draft = createPlanDraft(migrationSession());

  assert.deepEqual(updatePlanStep(draft, 99, { title: 'nope' }), draft);
  assert.deepEqual(removePlanStep(draft, -1), draft);
  assert.deepEqual(movePlanStep(draft, 0, -1), draft);
  assert.deepEqual(movePlanStep(draft, draft.steps.length - 1, 1), draft);
  assert.deepEqual(movePlanStep(draft, 0, 0), draft);
});

test('command argument operations preserve spaces and quotes and never mutate input', () => {
  const draft = createPlanDraft(migrationSession());
  const added = addCommandArgument(draft, 0);
  const quoted = updateCommandArgument(added, 0, 3, '  "two words"  ');
  const removed = removeCommandArgument(quoted, 0, 1);

  assert.deepEqual(draft.steps[0].command, ['node', '-e', 'console.log("hello world")']);
  assert.deepEqual(added.steps[0].command, ['node', '-e', 'console.log("hello world")', '']);
  assert.equal(quoted.steps[0].command[3], '  "two words"  ');
  assert.deepEqual(removed.steps[0].command, ['node', 'console.log("hello world")', '  "two words"  ']);
});

test('command argument operations safely no-op for invalid indices', () => {
  const draft = createPlanDraft(migrationSession());

  assert.deepEqual(addCommandArgument(draft, 99), draft);
  assert.deepEqual(updateCommandArgument(draft, 0, 99, 'x'), draft);
  assert.deepEqual(removeCommandArgument(draft, 0, -1), draft);
});

test('validatePlanDraft returns stable indexed paths for invalid fields', () => {
  const draft = {
    steps: [
      {
        title: '   ',
        description: 12,
        expected: null,
        actionEnabled: true,
        command: ['npm', '   ', 42],
        cwd: 7,
      },
    ],
  };

  assert.deepEqual(validatePlanDraft(draft), [
    { path: '/steps/0/title', message: 'must be a non-empty string' },
    { path: '/steps/0/description', message: 'must be a string' },
    { path: '/steps/0/expected', message: 'must be a string' },
    { path: '/steps/0/action/command/1', message: 'must be a non-empty string' },
    { path: '/steps/0/action/command/2', message: 'must be a non-empty string' },
    { path: '/steps/0/action/cwd', message: 'must be a string' },
  ]);
});

test('validatePlanDraft accepts an empty plan and ignores disabled action contents', () => {
  assert.deepEqual(validatePlanDraft({ steps: [] }), []);
  assert.deepEqual(validatePlanDraft({
    steps: [{
      title: 'Observe',
      description: '',
      expected: '',
      actionEnabled: false,
      command: ['', 3],
      cwd: 9,
    }],
  }), []);
});

test('validatePlanDraft reports invalid root shapes and action flags', () => {
  assert.deepEqual(validatePlanDraft(null), [
    { path: '/steps', message: 'must be an array' },
  ]);
  assert.deepEqual(validatePlanDraft({ steps: 'invalid' }), [
    { path: '/steps', message: 'must be an array' },
  ]);
  assert.deepEqual(validatePlanDraft({
    steps: [{
      title: 'Observe',
      description: '',
      expected: '',
      actionEnabled: 'yes',
      command: [],
      cwd: '',
    }],
  }), [
    { path: '/steps/0/actionEnabled', message: 'must be a boolean' },
  ]);
});

test('validatePlanDraft reports precise metadata field paths', () => {
  assert.deepEqual(validatePlanDraft({
    steps: [draftStep({
      risk: 'critical',
      dependsOn: [1],
    })],
  }), [
    { path: '/steps/0/risk', message: 'must be one of low, medium, high' },
    { path: '/steps/0/dependsOn/0', message: 'must be a string' },
  ]);
  assert.deepEqual(validatePlanDraft({
    steps: [draftStep({ dependsOn: 'step-1' })],
  }), [
    { path: '/steps/0/dependsOn', message: 'must be an array' },
  ]);
});

test('toPlanInput trims text, preserves argv boundaries, and emits only protocol fields', () => {
  const draft = createPlanDraft(migrationSession());
  const changed = updatePlanStep(draft, 0, {
    title: '  Inspect project  ',
    description: '  Read it  ',
    expected: '  done  ',
    command: ['node', '  two words  ', '"quoted"'],
    cwd: '  packages/app  ',
  });

  assert.deepEqual(toPlanInput(changed), {
    steps: [
      {
        id: 'step-1',
        title: 'Inspect project',
        description: 'Read it',
        expected: 'done',
        risk: 'medium',
        dependsOn: [],
        action: {
          command: ['node', '  two words  ', '"quoted"'],
          cwd: 'packages/app',
        },
      },
      {
        id: 'step-2',
        title: 'Record findings',
        description: '',
        expected: 'findings saved',
        risk: 'high',
        dependsOn: ['step-1'],
      },
    ],
  });
});

test('toPlanInput excludes every runtime-only field while preserving plan metadata', () => {
  const draft = createPlanDraft(migrationSession());
  Object.assign(draft.steps[0], {
    attempt: 8,
    status: 'awaiting_review',
    review: { decision: 'accept' },
    error: 'runtime error',
    history: [{ type: 'step.started' }],
    traceState: { internal: true },
  });

  assert.deepEqual(Object.keys(toPlanInput(draft).steps[0]).sort(), [
    'action',
    'dependsOn',
    'description',
    'expected',
    'id',
    'risk',
    'title',
  ]);
});

test('toPlanInput normalizes blank expected to null and rejects invalid drafts with first path', () => {
  const blankExpected = {
    steps: [{
      title: 'Observe',
      description: '  ',
      expected: '   ',
      actionEnabled: false,
      command: [],
      cwd: '',
    }],
  };

  assert.deepEqual(toPlanInput(blankExpected), {
    steps: [{ title: 'Observe', description: '', expected: null }],
  });
  assert.throws(
    () => toPlanInput({ steps: [{ ...blankExpected.steps[0], title: '' }] }),
    /Invalid plan at \/steps\/0\/title: must be a non-empty string/,
  );
});

test('plan editor shell exposes eligible controls and accessible dialog semantics', () => {
  assert.match(webHtml, /<button\s+id="edit-plan"[^>]*\btype="button"[^>]*\bhidden\b[^>]*\bdisabled\b[^>]*\baria-describedby="edit-plan-reason"/i);
  assert.match(webHtml, /<span\s+id="edit-plan-reason"[^>]*>[^<]*only before the migration starts[^<]*<\/span>/i);
  assert.match(webHtml, /<dialog\s+id="plan-editor"[^>]*\baria-labelledby="plan-editor-title"/i);
  assert.match(webHtml, /<h1\s+id="plan-editor-title"/i);
  assert.match(webHtml, /pristine[^<]*plan/i);
  assert.match(webHtml, /保存[^<]*不会执行命令|saving[^<]*does not execute commands/i);
  assert.match(webHtml, /<div\s+id="plan-editor-status"[^>]*\brole="status"[^>]*\baria-live="polite"/i);
});

test('plan editor shell provides an empty step mount and explicit typed actions', () => {
  const steps = webHtml.match(/<div\s+id="plan-editor-steps"[^>]*>([\s\S]*?)<\/div>/i);
  assert.ok(steps, 'plan editor steps mount exists');
  assert.equal(steps[1].trim(), '');

  assert.match(webHtml, /<button\s+id="plan-editor-add"[^>]*\btype="button"/i);
  assert.match(webHtml, /<button\s+id="plan-editor-cancel"[^>]*\btype="button"/i);
  assert.match(webHtml, /<button\s+id="plan-editor-save"[^>]*\btype="button"[^>]*\bdisabled\b/i);
});

test('plan editor styles define scoped responsive, focus, step, argument, and error states', () => {
  assert.match(webCss, /#plan-editor::backdrop\s*\{/);
  assert.match(webCss, /#plan-editor[^{}]*:focus-visible/);
  assert.match(webCss, /#plan-editor[^{}]*:disabled/);
  assert.match(webCss, /#plan-editor\s+\.plan-editor-body[^{}]*\{[^}]*overflow\s*:\s*auto/);
  assert.match(webCss, /#plan-editor\s+\.plan-step/);
  assert.match(webCss, /#plan-editor\s+\.plan-step[^{}]*summary/);
  assert.match(webCss, /#plan-editor\s+\.plan-step-actions/);
  assert.match(webCss, /#plan-editor\s+\.plan-field-grid/);
  assert.match(webCss, /#plan-editor\s+\.plan-action-toggle/);
  assert.match(webCss, /#plan-editor\s+\.plan-argv-list/);
  assert.match(webCss, /#plan-editor\s+\.plan-argv-row/);
  assert.match(webCss, /#plan-editor\s+\.plan-remove/);
  assert.match(webCss, /#plan-editor\s+\.inline-error/);
  assert.match(webCss, /@media\s*\(max-width\s*:\s*700px\)[^{]*\{[\s\S]*?#plan-editor\s+\.plan-field-grid[^{}]*\{[^}]*grid-template-columns\s*:\s*1fr/);
  assert.match(webCss, /@media\s*\(prefers-reduced-motion\s*:\s*reduce\)[^{]*\{[\s\S]*?#plan-editor/);
});
