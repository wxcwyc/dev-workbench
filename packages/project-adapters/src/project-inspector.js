import fs from "node:fs/promises";
import path from "node:path";
import { captureFileTree } from "./file-tree.js";

const packageManagers = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"]
];

const languagesByExtension = new Map([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".vue", "Vue"],
  [".svelte", "Svelte"],
  [".py", "Python"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".java", "Java"],
  [".rb", "Ruby"],
  [".php", "PHP"],
  [".pl", "Prolog"]
]);

const frameworksByDependency = new Map([
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["nuxt", "Nuxt"],
  ["astro", "Astro"],
  ["svelte", "Svelte"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@angular/core", "Angular"],
  ["vite", "Vite"],
  ["express", "Express"]
]);

export async function inspectProject(projectRoot) {
  const { entries } = await captureFileTree(projectRoot, 2000);
  const files = entries.filter((entry) => entry.type === "file");
  const filePaths = new Set(files.map((entry) => entry.path));
  const evidence = new Set();
  const warnings = [];

  let git = false;
  try {
    git = (await fs.stat(path.join(projectRoot, ".git"))).isDirectory();
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`Could not inspect .git: ${error.message}`);
  }

  let packageManager = null;
  for (const [lockfile, manager] of packageManagers) {
    if (!filePaths.has(lockfile)) continue;
    evidence.add(lockfile);
    if (packageManager === null) packageManager = manager;
  }

  let packageManifest = null;
  if (filePaths.has("package.json")) {
    evidence.add("package.json");
    try {
      packageManifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
      if (packageManager === null) packageManager = "npm";
    } catch (error) {
      warnings.push(`Could not read package.json: ${error.message}`);
    }
  }

  const languageCounts = new Map();
  for (const file of files) {
    const language = languagesByExtension.get(path.extname(file.path).toLowerCase());
    if (!language) continue;
    evidence.add(file.path);
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .map(([name]) => name);

  const dependencies = {
    ...(packageManifest?.dependencies ?? {}),
    ...(packageManifest?.devDependencies ?? {})
  };
  const frameworks = [...new Set(
    Object.keys(dependencies)
      .map((dependency) => frameworksByDependency.get(dependency))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));

  return {
    projectRoot,
    git,
    packageManager,
    languages,
    frameworks,
    evidence: [...evidence].sort((left, right) => left.localeCompare(right)),
    warnings
  };
}
