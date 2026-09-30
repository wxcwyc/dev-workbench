import assert from "node:assert/strict";
import test from "node:test";

import { renderAnnotationMarkdown } from "../apps/web/annotation-markdown.js";

test("annotation Markdown renders the documented small subset", () => {
  const html = renderAnnotationMarkdown("**bold** and *emphasis* with `code`\n\n- first\n- 世界\n\n[safe](https://example.com/a?q=1)");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>first<\/li><li>世界<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example\.com\/a\?q=1"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("annotation Markdown escapes HTML and disables dangerous or malformed links", () => {
  const html = renderAnnotationMarkdown('<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [data](data:text/html,x) [broken](https://example.com');
  assert.doesNotMatch(html, /<img|href="javascript:|href="data:/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /bad/);
  assert.match(html, /\[broken\]/);
});
