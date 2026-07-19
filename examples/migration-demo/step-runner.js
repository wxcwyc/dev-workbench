import fs from "node:fs/promises";
import path from "node:path";

const stage = process.argv[2];
const root = path.join(import.meta.dirname, ".generated");
const target = path.join(root, "target");

if (stage === "reset") {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  console.log("Target workspace reset.");
} else if (stage === "shell") {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "package.json"), `${JSON.stringify({ name: "modern-site", private: true, scripts: { dev: "node server.js" } }, null, 2)}\n`);
  await fs.writeFile(path.join(target, "index.html"), "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main id=\"app\"></main><script type=\"module\" src=\"app.js\"></script></body></html>\n");
  console.log("Application shell created.");
} else if (stage === "content") {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "content.json"), `${JSON.stringify({ title: "Legacy Notes", body: "A small site now expressed as structured content." }, null, 2)}\n`);
  await fs.writeFile(path.join(target, "app.js"), "import content from './content.json' with { type: 'json' }; document.querySelector('#app').innerHTML = `<h1>${content.title}</h1><p>${content.body}</p>`;\n");
  console.log("Content transformed.");
} else if (stage === "styles") {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "styles.css"), "body{font-family:system-ui;background:#fff7d6;color:#2c2517}main{max-width:760px;margin:10vh auto;padding:2rem;border-left:6px solid #ff4d32}\n");
  console.log("Styles migrated.");
} else {
  throw new Error(`Unknown migration stage: ${stage}`);
}
