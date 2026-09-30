const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[character]);

function safeHref(value) {
  const href = value.trim();
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^(?:\/[^/]|#)/.test(href)) return href;
  return null;
}

function renderInline(source) {
  let html = "";
  let rest = String(source ?? "");
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s()]+\))/;
  while (rest) {
    const match = rest.match(token);
    if (!match) return html + escapeHtml(rest);
    html += escapeHtml(rest.slice(0, match.index));
    const value = match[0];
    if (value.startsWith("`")) html += `<code>${escapeHtml(value.slice(1, -1))}</code>`;
    else if (value.startsWith("**")) html += `<strong>${renderInline(value.slice(2, -2))}</strong>`;
    else if (value.startsWith("*")) html += `<em>${renderInline(value.slice(1, -1))}</em>`;
    else {
      const parts = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = safeHref(parts[2]);
      html += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${renderInline(parts[1])}</a>`
        : renderInline(parts[1]);
    }
    rest = rest.slice(match.index + value.length);
  }
  return html;
}

export function renderAnnotationMarkdown(source) {
  const lines = String(source ?? "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index += 1; continue; }
    if (/^\s*-\s+/.test(lines[index])) {
      const items = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*-\s+/, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^\s*-\s+/.test(lines[index])) {
      paragraph.push(renderInline(lines[index]));
      index += 1;
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return blocks.join("");
}
