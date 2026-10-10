# Lightweight Chinese/English UI Implementation Plan

> Execute sequentially in the current workspace; the user authorized the progress update and implementation together.

**Goal:** Correct the stale progress record and localize the existing UI to Chinese/English with browser language detection.

**Architecture:** A zero-dependency frontend translation module uses English source messages and a Simplified Chinese dictionary. Read the browser's first preferred language at page initialization; `zh-*` selects `zh-CN`, all others select `en`. Explicitly translate static labels/attributes and dynamic UI messages, leaving user content and protocol payloads untouched. No language switcher or persisted preference is added.

**Tech Stack:** Existing vanilla browser JavaScript/HTML and Node test runner.

1. Update `progress.md` using the current main commits and `docs/DEVELOPMENT_PLAN.md`; preserve historical entries.
2. Add failing tests in `test/web-i18n.test.js` for detection, English fallback, interpolation, static labels/attributes, and Chinese controller behavior without changing command/restore payloads.
3. Add `apps/web/i18n.js`; localize `apps/web/index.html`, `apps/web/app.js`, `apps/web/onboarding.js`, and `apps/web/plan-editor.js` explicitly at UI boundaries.
4. Run focused Web suites, then `node --test`; inspect Chinese/English in a browser if the browser connection is available. Run `git diff --check` and document final evidence and limits in `progress.md`.

**Acceptance:** Chinese and English UI labels, validation/confirmation messages, status/risk labels, and accessibility attributes follow browser language; HTML `lang` matches; arbitrary project/user content and API enums remain unchanged; existing workflow tests pass.
