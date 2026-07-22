import test from 'node:test';
import assert from 'node:assert/strict';

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
        status: 'pending',
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
        status: 'pending',
      },
    ],
  };
}

test('createPlanDraft deep-clones editable plan data without mutating the session', () => {
  const session = migrationSession();
  const original = structuredClone(session);

  const draft = createPlanDraft(session);

  assert.deepEqual(draft, {
    steps: [
      {
        title: 'Inspect project',
        description: 'Read the manifest',
        expected: '{\n  "scripts": [\n    "test"\n  ]\n}',
        actionEnabled: true,
        command: ['node', '-e', 'console.log("hello world")'],
        cwd: 'packages/app',
      },
      {
        title: 'Record findings',
        description: '',
        expected: '  findings saved  ',
        actionEnabled: false,
        command: [],
        cwd: '',
      },
    ],
  });
  draft.steps[0].command[0] = 'changed';
  assert.deepEqual(session, original);
});

test('createPlanDraft supports an empty plan', () => {
  assert.deepEqual(createPlanDraft({ steps: [] }), { steps: [] });
});

test('step operations add, allowlisted-update, reorder, and remove immutably', () => {
  const initial = createPlanDraft(migrationSession());
  const added = addPlanStep(initial);
  const updated = updatePlanStep(added, 2, {
    title: ' New step ',
    description: 'Description',
    expected: 'Expected',
    actionEnabled: true,
    command: ['npm', 'test'],
    cwd: ' app ',
    id: 'injected',
    status: 'complete',
    history: ['injected'],
  });
  const moved = movePlanStep(updated, 2, -1);
  const removed = removePlanStep(moved, 0);

  assert.deepEqual(added.steps[2], {
    title: '',
    description: '',
    expected: '',
    actionEnabled: false,
    command: [],
    cwd: '',
  });
  assert.equal(updated.steps[2].title, ' New step ');
  assert.equal(updated.steps[2].actionEnabled, true);
  assert.deepEqual(updated.steps[2].command, ['npm', 'test']);
  assert.equal('id' in updated.steps[2], false);
  assert.equal('status' in updated.steps[2], false);
  assert.equal('history' in updated.steps[2], false);
  assert.equal(moved.steps[1].title, ' New step ');
  assert.equal(removed.steps.length, 2);
  assert.equal(initial.steps.length, 2);
  assert.equal(added.steps[2].title, '');
  assert.equal(updated.steps[2].title, ' New step ');
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
        title: 'Inspect project',
        description: 'Read it',
        expected: 'done',
        action: {
          command: ['node', '  two words  ', '"quoted"'],
          cwd: 'packages/app',
        },
      },
      {
        title: 'Record findings',
        description: '',
        expected: 'findings saved',
      },
    ],
  });
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
