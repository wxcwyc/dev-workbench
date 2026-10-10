import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { FakeElement, FakeResponse, installFakeBrowser } from "./helpers/fake-browser.js";

test("the UI initializes explicit localization before rendering", async () => {
  const source = await fs.readFile(new URL("../apps/web/app.js", import.meta.url), "utf8");
  assert.ok(source.includes("localizeDocument(document)"));
});

test("browser language follows the first preference with English fallback", async () => {
  const { resolveLocale } = await import("../apps/web/i18n.js");
  assert.equal(resolveLocale(["zh-CN", "en"]), "zh-CN");
  assert.equal(resolveLocale(["zh-TW"]), "zh-CN");
  assert.equal(resolveLocale(["ZH-hk"]), "zh-CN");
  assert.equal(resolveLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveLocale(["fr-FR", "zh-CN"]), "en");
  assert.equal(resolveLocale([], "zh"), "zh-CN");
  assert.equal(resolveLocale([], "de"), "en");
  assert.equal(resolveLocale([], ""), "en");
});

test("translation preserves parameter content and falls back for unknown messages", async () => {
  const { translate } = await import("../apps/web/i18n.js");
  assert.equal(translate("Step {0} of {1}", [2, 5], "zh-CN"), "第 2 步，共 5 步");
  assert.equal(translate("Step {0} of {1}", [2, 5], "en"), "Step 2 of 5");
  assert.equal(translate("Unknown {0}", ["{1} <script>"], "zh-CN"), "Unknown {1} <script>");
  assert.equal(translate("Open local project", [], "zh-CN"), "打开本地项目");
});

test("static text and accessibility attributes use the same locale", async () => {
  const { localizeDocument } = await import("../apps/web/i18n.js");
  const browser = installFakeBrowser();
  try {
    const label = new FakeElement(browser.document);
    label.dataset.i18n = "Open local project";
    const input = new FakeElement(browser.document);
    input.dataset.i18nPlaceholder = "Search loaded diff";
    input.dataset.i18nAriaLabel = "Close project onboarding";
    browser.document.setQuerySelectorAll("[data-i18n]", [label]);
    browser.document.setQuerySelectorAll("[data-i18n-placeholder]", [input]);
    browser.document.setQuerySelectorAll("[data-i18n-aria-label]", [input]);
    const root = new FakeElement(browser.document);
    browser.document.documentElement = root;
    localizeDocument(browser.document, "zh-CN");
    assert.equal(root.lang, "zh-CN");
    assert.equal(label.textContent, "打开本地项目");
    assert.equal(input.getAttribute("placeholder"), "搜索已加载的差异");
    assert.equal(input.getAttribute("aria-label"), "关闭项目接入窗口");
    localizeDocument(browser.document, "en");
    assert.equal(root.lang, "en");
    assert.equal(label.textContent, "Open local project");
  } finally {
    browser.restore();
  }
});

test("Chinese controller renders UI labels while preserving project content and command payloads", async (t) => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["zh-CN"], language: "zh-CN" } });
  const sample = {
    id: "local", title: "Open local project", workbench: "migration", projectRoot: "/projects/local",
    status: "ready", cursor: -1, snapshots: [], annotations: [], metadata: {},
    steps: [{ id: "inspect", title: "Run", description: "User description", status: "pending", risk: "high", attempt: 0, dependsOn: [], action: { command: ["node", "inspect.js"], cwd: "." } }],
    workspace: { executionRoot: "/tmp/owned/local", currentCheckpointId: "initial", baseOid: "a".repeat(40) },
  };
  const browser = installFakeBrowser((path, options) => {
    if (path === "/api/health") return new FakeResponse({ allowedRoot: "/projects" });
    if (path === "/api/sessions" && !options.method) return new FakeResponse([sample]);
    if (path === "/api/projects/recent") return new FakeResponse([]);
    if (path.endsWith("/steps/0/run")) return new FakeResponse(sample);
    throw new Error(`Unexpected request: ${path}`);
  });
  t.after(() => {
    browser.restore();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  let confirmation;
  globalThis.confirm = (message) => { confirmation = message; return true; };
  const { __testing: controller } = await import("../apps/web/app.js?i18n-test=zh");
  controller.renderSession(sample);
  assert.equal(browser.element("health").textContent, "● 引擎在线");
  assert.equal(browser.element("session-title").textContent, "Open local project");
  assert.equal(browser.element("session-status").textContent, "就绪");
  assert.equal(browser.element("run-next").textContent, "运行第 1 步");
  assert.match(browser.element("migration-view").innerHTML, /迁移计划/);
  assert.match(browser.element("migration-view").innerHTML, /User description/);
  assert.match(browser.element("migration-view").innerHTML, /node inspect\.js/);
  assert.match(browser.element("migration-view").innerHTML, /data-preview-action="start"/);
  assert.match(browser.element("migration-view").innerHTML, /aria-label="启动源项目预览"/);
  assert.match(browser.element("migration-view").innerHTML, /class="step-pill pending">待执行/);
  controller.renderOnboardingPreview({ title: "Run", workbench: "migration", projectRoot: "/projects/local", steps: sample.steps });
  assert.match(browser.element("onboarding-preview").innerHTML, /共 1 项/);
  assert.match(browser.element("onboarding-preview").innerHTML, /修改项目/);
  controller.openPlanEditor();
  assert.match(browser.element("plan-editor-steps").innerHTML, /步骤 ID/);
  assert.match(browser.element("plan-editor-steps").innerHTML, /option value="high"[^>]*>高/);
  controller.state.planEditor.draft.steps[0].title = "";
  controller.renderPlanEditor();
  assert.match(browser.element("plan-editor-status").textContent, /必须是非空字符串/);
  controller.closePlanEditor();
  await browser.element("run-next").onclick();
  assert.match(confirmation, /高风险/);
  assert.match(confirmation, /node inspect\.js/);
  assert.match(confirmation, /\[inspect\]/);
  const run = browser.requests.find(({ path }) => path.endsWith("/steps/0/run"));
  assert.deepEqual(JSON.parse(run.options.body), { confirmed: true, confirmedRisk: true });
  assert.equal(sample.steps[0].status, "pending");
});
