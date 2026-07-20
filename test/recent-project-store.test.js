import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RecentProjectStore } from "../packages/execution-core/src/recent-project-store.js";

async function makeStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recent-project-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new RecentProjectStore(path.join(directory, "recent-projects.json"), options);
}

test("record keeps the latest workbench for a path and lists newest first", async (t) => {
  const store = await makeStore(t, { limit: 2 });

  await store.record({ projectRoot: "/projects/one", workbench: "execution" });
  await store.record({ projectRoot: "/projects/two", workbench: "migration" });
  const recent = await store.record({ projectRoot: "/projects/one", workbench: "migration" });

  assert.deepEqual(
    recent.map(({ projectRoot, workbench }) => ({ projectRoot, workbench })),
    [
      { projectRoot: "/projects/one", workbench: "migration" },
      { projectRoot: "/projects/two", workbench: "migration" },
    ],
  );
  assert.equal(recent.every(({ lastUsedAt }) => !Number.isNaN(Date.parse(lastUsedAt))), true);
  assert.deepEqual(await store.list(), recent);
});

test("record evicts the oldest entry when the limit is exceeded", async (t) => {
  const store = await makeStore(t, { limit: 2 });

  await store.record({ projectRoot: "/projects/oldest", workbench: "execution" });
  await store.record({ projectRoot: "/projects/middle", workbench: "execution" });
  await store.record({ projectRoot: "/projects/newest", workbench: "migration" });

  const recent = await store.list();
  assert.deepEqual(recent.map(({ projectRoot }) => projectRoot), [
    "/projects/newest",
    "/projects/middle",
  ]);
});

test("list returns an empty list and warns once for invalid JSON", async (t) => {
  const warnings = [];
  const store = await makeStore(t, { warn: (message) => warnings.push(message) });

  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, "not json", "utf8");

  assert.deepEqual(await store.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recent projects.*invalid JSON/i);
});

test("list rejects non-array state and filters malformed entries", async (t) => {
  const warnings = [];
  const store = await makeStore(t, { warn: (message) => warnings.push(message) });

  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, JSON.stringify({ projectRoot: "/projects/one" }), "utf8");
  assert.deepEqual(await store.list(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recent projects.*array/i);

  warnings.length = 0;
  const valid = {
    projectRoot: "/projects/valid",
    workbench: "execution",
    lastUsedAt: "2026-07-20T08:00:00.000Z",
  };
  const malformed = [
    { ...valid, projectRoot: "" },
    { ...valid, workbench: "other" },
    { ...valid, lastUsedAt: "" },
    { ...valid, lastUsedAt: "not-a-date" },
    null,
  ];
  await fs.writeFile(store.filePath, JSON.stringify([valid, ...malformed]), "utf8");

  assert.deepEqual(await store.list(), [valid]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recent projects.*malformed/i);
});

test("list and record keep only the recent-project schema fields", async (t) => {
  const store = await makeStore(t);
  const stored = {
    projectRoot: "/projects/existing",
    workbench: "execution",
    lastUsedAt: "2026-07-20T08:00:00.000Z",
    extra: "must not escape storage",
  };

  await fs.mkdir(path.dirname(store.filePath), { recursive: true });
  await fs.writeFile(store.filePath, JSON.stringify([stored]), "utf8");

  assert.deepEqual(await store.list(), [{
    projectRoot: stored.projectRoot,
    workbench: stored.workbench,
    lastUsedAt: stored.lastUsedAt,
  }]);

  await store.record({ projectRoot: "/projects/new", workbench: "migration" });
  const persisted = JSON.parse(await fs.readFile(store.filePath, "utf8"));
  assert.deepEqual(persisted[1], {
    projectRoot: stored.projectRoot,
    workbench: stored.workbench,
    lastUsedAt: stored.lastUsedAt,
  });
});
