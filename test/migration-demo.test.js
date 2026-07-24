import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { assertPlanInput } from "../packages/protocol/src/index.js";

test("migration demo session exposes stable ids, risk, and earlier-step dependencies", async () => {
  const session = JSON.parse(
    await fs.readFile(new URL("../examples/migration-demo/session.json", import.meta.url), "utf8"),
  );

  const planInput = { steps: session.steps };
  assert.equal(assertPlanInput(planInput), planInput);
  assert.deepEqual(session.steps.map(({ id, risk, dependsOn }) => ({ id, risk, dependsOn })), [
    { id: "reset-target-workspace", risk: "high", dependsOn: [] },
    { id: "create-application-shell", risk: "medium", dependsOn: ["reset-target-workspace"] },
    { id: "migrate-content", risk: "medium", dependsOn: ["create-application-shell"] },
    { id: "migrate-styles", risk: "low", dependsOn: ["migrate-content"] },
  ]);
});
