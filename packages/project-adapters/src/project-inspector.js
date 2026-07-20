import fs from "node:fs/promises";
import path from "node:path";
import { captureFileTree } from "./file-tree.js";

const maxPackageJsonSize = 1024 * 1024;

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

async function inspectOptionalEntry(projectRoot, name, warnings) {
  try {
    const entry = await fs.lstat(path.join(projectRoot, name));
    if (entry.isSymbolicLink()) {
      warnings.push(`Ignored ${name}: symbolic links are not allowed.`);
      return null;
    }
    return entry;
  } catch (error) {
    if (error.code !== "ENOENT") warnings.push(`Could not inspect ${name}: ${error.message}`);
    return null;
  }
}

export async function inspectProject(projectRoot) {
  const { entries, truncated } = await captureFileTree(projectRoot, 2000);
  const files = entries.filter((entry) => entry.type === "file");
  const evidence = new Set();
  const warnings = truncated ? ["Language scan truncated after 2000 file-tree entries."] : [];

  const gitEntry = await inspectOptionalEntry(projectRoot, ".git", warnings);
  const git = gitEntry?.isFile() || gitEntry?.isDirectory() || false;
  if (gitEntry && !git) {
    warnings.push("Ignored .git: expected a regular file or directory.");
  }

  let packageManager = null;
  for (const [lockfile, manager] of packageManagers) {
    const lockfileEntry = await inspectOptionalEntry(projectRoot, lockfile, warnings);
    if (!lockfileEntry) continue;
    if (!lockfileEntry.isFile()) {
      warnings.push(`Ignored ${lockfile}: expected a regular file.`);
      continue;
    }
    evidence.add(lockfile);
    if (packageManager === null) packageManager = manager;
  }

  let packageManifest = null;
  const packageJsonEntry = await inspectOptionalEntry(projectRoot, "package.json", warnings);
  if (packageJsonEntry && !packageJsonEntry.isFile()) {
    warnings.push("Ignored package.json: expected a regular file.");
  } else if (packageJsonEntry?.size > maxPackageJsonSize) {
    warnings.push(`Ignored package.json: too large (maximum ${maxPackageJsonSize} bytes).`);
  } else if (packageJsonEntry) {
    try {
      const packageJson = await fs.readFile(path.join(projectRoot, "package.json"), "utf8");
      evidence.add("package.json");
      try {
        packageManifest = JSON.parse(packageJson);
        if (packageManager === null) packageManager = "npm";
      } catch (error) {
        warnings.push(`Could not read package.json: ${error.message}`);
      }
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
