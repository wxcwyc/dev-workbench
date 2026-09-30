import fs from "node:fs/promises";
import path from "node:path";

const stage = process.argv[2];
const target = path.join(import.meta.dirname, "target");
const resetPage = "<!doctype html><html><body><main><h1>Modern site preview</h1><p>Run the migration steps to build this target.</p></main></body></html>\n";

if (stage === "reset") {
  await fs.mkdir(target, { recursive: true });
  await Promise.all(
    [
      "package.json",
      "index.html",
      "content.json",
      "app.js",
      "styles.css",
      "verified.txt",
      "verification-in-progress.txt",
    ].map((file) =>
      fs.rm(path.join(target, file), { force: true })
    ),
  );
  await fs.writeFile(path.join(target, "index.html"), resetPage);
  console.log("Target workspace reset.");
} else if (stage === "shell") {
  await fs.mkdir(target, { recursive: true });
  try {
    await fs.access(path.join(target, "package.json"));
    throw new Error("Application shell baseline was not restored before retry");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
} else if (stage === "verify") {
  const inProgress = path.join(target, "verification-in-progress.txt");
  try {
    await fs.access(inProgress);
    throw new Error("Verification baseline was not restored before retry");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.writeFile(inProgress, "Verification is in progress.\n");
  console.log("Verification started.");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await fs.rm(inProgress);
  await fs.writeFile(path.join(target, "verified.txt"), "Migration verified.\n");
  console.log("Migration verified.");
} else {
  throw new Error(`Unknown migration stage: ${stage}`);
}
