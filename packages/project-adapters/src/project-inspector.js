import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

async function readProjectRootIdentity(projectRoot) {
  let entry;
  try {
    entry = await fs.lstat(projectRoot);
  } catch (error) {
    throw new Error(`Could not inspect project root ${projectRoot}: ${error.message}`, { cause: error });
  }
  if (entry.isSymbolicLink()) throw new Error(`Project root must not be a symbolic link: ${projectRoot}`);
  if (!entry.isDirectory()) throw new Error(`Project root must be a directory: ${projectRoot}`);
  return { device: entry.dev, inode: entry.ino };
}

export async function readBoundedFileHandle(handle, maximumSize) {
  const content = Buffer.alloc(maximumSize + 1);
  let totalBytesRead = 0;
  while (totalBytesRead < content.length) {
    const { bytesRead } = await handle.read(
      content,
      totalBytesRead,
      content.length - totalBytesRead,
      null,
    );
    if (bytesRead === 0) return content.subarray(0, totalBytesRead);
    totalBytesRead += bytesRead;
  }
  throw new Error(`File is too large (maximum ${maximumSize} bytes).`);
}

async function readPackageJson(projectRoot, initialEntry, warnings) {
  const packagePath = path.join(projectRoot, "package.json");
  let packageHandle;
  try {
    packageHandle = await fs.open(packagePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const openedEntry = await packageHandle.stat();
    if (!openedEntry.isFile()) {
      warnings.push("Ignored package.json: expected a regular file.");
      return null;
    }
    if (openedEntry.dev !== initialEntry.dev || openedEntry.ino !== initialEntry.ino) {
      warnings.push("Ignored package.json: file changed while being inspected.");
      return null;
    }
    if (openedEntry.size > maxPackageJsonSize) {
      warnings.push(`Ignored package.json: too large (maximum ${maxPackageJsonSize} bytes).`);
      return null;
    }
    return (await readBoundedFileHandle(packageHandle, maxPackageJsonSize)).toString("utf8");
  } catch (error) {
    warnings.push(`Could not read package.json: ${error.message}`);
    return null;
  } finally {
    if (packageHandle) {
      try {
        await packageHandle.close();
      } catch (error) {
        warnings.push(`Could not close package.json: ${error.message}`);
      }
    }
  }
}

export async function inspectProject(projectRoot) {
  const rootIdentity = await readProjectRootIdentity(projectRoot);
  const warnings = [];
  const { entries, truncated } = await captureFileTree(projectRoot, 2000, {
    hashFiles: false,
    onError: (relativePath, error) => warnings.push(`Could not inspect ${relativePath}: ${error.message}`),
  });
  const files = entries.filter((entry) => entry.type === "file");
  const evidence = new Set();
  if (truncated) warnings.push("Language scan truncated after 2000 file-tree entries.");

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
  } else if (packageJsonEntry) {
    const packageJson = await readPackageJson(projectRoot, packageJsonEntry, warnings);
    if (packageJson !== null) {
      evidence.add("package.json");
      try {
        packageManifest = JSON.parse(packageJson);
        if (packageManager === null) packageManager = "npm";
      } catch (error) {
        warnings.push(`Could not read package.json: ${error.message}`);
      }
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

  let finalRootIdentity;
  try {
    finalRootIdentity = await readProjectRootIdentity(projectRoot);
  } catch (error) {
    throw new Error(`Project root changed during inspection: ${error.message}`, { cause: error });
  }
  if (finalRootIdentity.device !== rootIdentity.device || finalRootIdentity.inode !== rootIdentity.inode) {
    throw new Error("Project root changed during inspection");
  }

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
