import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureFileTree, compareTrees } from "../packages/project-adapters/src/file-tree.js";
import { runConfirmedCommand } from "../packages/project-adapters/src/command-runner.js";
import { resolveInsideProject, resolveProjectRoot } from "../packages/project-adapters/src/project-boundary.js";

test("file snapshots expose added and modified files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.txt"), "before");
  const before = await captureFileTree(root);
  await fs.writeFile(path.join(root, "one.txt"), "after");
  await fs.writeFile(path.join(root, "two.js"), "export default 2;");
  const after = await captureFileTree(root);
  assert.deepEqual(compareTrees(before, after), [
    { path: "one.txt", status: "modified" },
    { path: "two.js", status: "added" }
  ]);
});

test("captureFileTree can skip content hashes", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-no-hash-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "index.js"), "export default true;\n");

  const tree = await captureFileTree(root, 2000, { hashFiles: false });

  assert.equal(tree.entries.length, 1);
  assert.equal("hash" in tree.entries[0], false);
});

test("captureFileTree reports a nested scan error and continues", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-nested-error-"));
  const nested = path.join(root, "nested");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(nested);
  await fs.writeFile(path.join(root, "safe.txt"), "safe\n");
  const originalReaddir = fs.readdir.bind(fs);
  context.mock.method(fs, "readdir", async (target, options) => {
    if (path.resolve(target) === nested) {
      const error = new Error("nested directory denied");
      error.code = "EACCES";
      throw error;
    }
    return originalReaddir(target, options);
  });
  const scanErrors = [];

  const tree = await captureFileTree(root, 2000, {
    hashFiles: false,
    onError: (relativePath, error) => scanErrors.push({ relativePath, error }),
  });

  assert.ok(tree.entries.some((entry) => entry.path === "safe.txt"));
  assert.deepEqual(scanErrors.map(({ relativePath }) => relativePath), ["nested"]);
  assert.match(scanErrors[0].error.message, /nested directory denied/);
});

test("captureFileTree keeps root directory read failures fatal", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-root-error-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalReaddir = fs.readdir.bind(fs);
  context.mock.method(fs, "readdir", async (target, options) => {
    if (path.resolve(target) === root) throw new Error("root directory denied");
    return originalReaddir(target, options);
  });
  const scanErrors = [];

  await assert.rejects(
    captureFileTree(root, 2000, {
      onError: (relativePath, error) => scanErrors.push({ relativePath, error }),
    }),
    /root directory denied/,
  );
  assert.deepEqual(scanErrors, []);
});

test("captureFileTree reports a file stat error and continues", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-stat-error-"));
  const vanishedFile = path.join(root, "vanished.js");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "safe.txt"), "safe\n");
  await fs.writeFile(vanishedFile, "export default true;\n");
  const originalStat = fs.stat.bind(fs);
  context.mock.method(fs, "stat", async (target, ...args) => {
    if (path.resolve(target) === vanishedFile) throw new Error("file vanished");
    return originalStat(target, ...args);
  });
  const scanErrors = [];

  const tree = await captureFileTree(root, 2000, {
    hashFiles: false,
    onError: (relativePath, error) => scanErrors.push({ relativePath, error }),
  });

  assert.deepEqual(tree.entries.map((entry) => entry.path), ["safe.txt"]);
  assert.deepEqual(scanErrors.map(({ relativePath }) => relativePath), ["vanished.js"]);
});

test("captureFileTree keeps strict defaults but can degrade a hash read failure", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-hash-error-"));
  const sourceFile = path.join(root, "source.js");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(sourceFile, "export default true;\n");
  const originalReadFile = fs.readFile.bind(fs);
  context.mock.method(fs, "readFile", async (target, ...args) => {
    if (path.resolve(target) === sourceFile) throw new Error("hash read failed");
    return originalReadFile(target, ...args);
  });

  await assert.rejects(captureFileTree(root), /hash read failed/);

  const scanErrors = [];
  const tree = await captureFileTree(root, 2000, {
    onError: (relativePath, error) => scanErrors.push({ relativePath, error }),
  });
  assert.equal(tree.entries.length, 1);
  assert.equal(tree.entries[0].path, "source.js");
  assert.equal("hash" in tree.entries[0], false);
  assert.deepEqual(scanErrors.map(({ relativePath }) => relativePath), ["source.js"]);
});

test("confirmed command runner uses argv without a shell and stays inside project", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = process.platform === "win32"
    ? [process.execPath, "-e", "process.stdout.write('safe')"]
    : ["printf", "%.4s", "safe;exit 99"];
  const result = await runConfirmedCommand(root, { command });
  assert.equal(result.stdout, "safe");
  assert.throws(() => resolveInsideProject(root, "../escape"), /escapes project root/);
  assert.equal(await resolveProjectRoot(root, os.tmpdir()), await fs.realpath(root));
});

test("command runner streams decoded stdout and stderr in arrival order", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-stream-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = [];
  const script = [
    "const bytes = Buffer.from('你');",
    "process.stdout.write(bytes.subarray(0, 2));",
    "setTimeout(() => process.stdout.write(bytes.subarray(2)), 20);",
    "setTimeout(() => process.stderr.write('error'), 40);",
  ].join("");

  const result = await runConfirmedCommand(root, {
    command: [process.execPath, "-e", script],
  }, {
    onOutput: (event) => output.push(event),
  });

  assert.deepEqual(output, [
    { stream: "stdout", text: "你" },
    { stream: "stderr", text: "error" },
  ]);
  assert.equal(result.stdout, "你");
  assert.equal(result.stderr, "error");
  assert.equal(result.exitCode, 0);
  assert.ok(Date.parse(result.startedAt) <= Date.parse(result.completedAt));
});

test("command runner reports spawn errors with a complete result", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-spawn-error-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = [path.join(root, "missing-executable")];

  await assert.rejects(
    runConfirmedCommand(root, { command }),
    (error) => {
      assert.equal(error.code, "ENOENT");
      assert.deepEqual(error.result.command, command);
      assert.equal(error.result.cwd, root);
      assert.equal(error.result.stdout, "");
      assert.equal(error.result.stderr, "");
      assert.equal(error.result.exitCode, null);
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
});

test("command runner reports non-zero exits with partial output", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-exit-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = [
    process.execPath,
    "-e",
    "process.stdout.write('out');process.stderr.write('err');process.exit(7)",
  ];

  await assert.rejects(
    runConfirmedCommand(root, { command }),
    (error) => {
      assert.equal(error.result.exitCode, 7);
      assert.equal(error.result.stdout, "out");
      assert.equal(error.result.stderr, "err");
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
});

test("command runner times out and waits for the child to exit", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-timeout-"));
  const stopped = path.join(root, "stopped");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});",
    "process.stdout.write('partial');",
    "setInterval(()=>{},1000);",
  ].join("");

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [process.execPath, "-e", script],
    }, {
      timeoutMs: 50,
    }),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.equal(error.result.stdout, "partial");
      assert.equal(error.result.exitCode, 0);
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
  assert.equal(await fs.readFile(stopped, "utf8"), "yes");
});

test("command runner escalates to SIGKILL when the child ignores SIGTERM", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-force-kill-"));
  const sigtermReceived = path.join(root, "sigterm-received");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>fs.writeFileSync('sigterm-received','yes'));",
    "setTimeout(()=>process.exit(0),1000);",
    "setInterval(()=>{},1000);",
  ].join("");
  const started = Date.now();

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [process.execPath, "-e", script],
    }, {
      timeoutMs: 200,
      terminationGraceMs: 50,
    }),
    (error) => {
      assert.match(error.message, /timed out/i);
      assert.equal(error.result.exitCode, null);
      assert.equal(error.result.signal, "SIGKILL");
      assert.ok(Date.now() - started < 750);
      return true;
    },
  );
  assert.equal(await fs.readFile(sigtermReceived, "utf8"), "yes");
});

test("command runner validates terminationGraceMs", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-grace-option-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const terminationGraceMs of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      runConfirmedCommand(root, {
        command: [process.execPath, "-e", ""],
      }, {
        terminationGraceMs,
      }),
      /terminationGraceMs.*non-negative integer/i,
    );
  }
});

test("command runner caps combined output and terminates the child", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-overflow-"));
  const stopped = path.join(root, "stopped");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});",
    "process.stdout.write('你你');",
    "setInterval(()=>{},1000);",
  ].join("");

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [process.execPath, "-e", script],
    }, {
      maxOutputBytes: 4,
    }),
    (error) => {
      assert.match(error.message, /output.*exceeded/i);
      assert.ok(Buffer.byteLength(error.result.stdout) <= 4);
      assert.equal(error.result.stderr, "");
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
  assert.equal(await fs.readFile(stopped, "utf8"), "yes");
});

test("command runner aborts and waits for the child to exit", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-abort-"));
  const stopped = path.join(root, "stopped");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});",
    "process.stdout.write('partial');",
    "setInterval(()=>{},1000);",
  ].join("");

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [process.execPath, "-e", script],
    }, {
      signal: controller.signal,
      onOutput: () => controller.abort(),
    }),
    (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.result.stdout, "partial");
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
  assert.equal(await fs.readFile(stopped, "utf8"), "yes");
});

test("command runner does not spawn for an already-aborted signal", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-pre-abort-"));
  const marker = path.join(root, "spawned");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('spawned','unsafe')",
      ],
    }, {
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.result.exitCode, null);
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("command runner rejects onOutput errors after terminating the child", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-callback-"));
  const stopped = path.join(root, "stopped");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const callbackError = new Error("output callback failed");
  const script = [
    "const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});",
    "process.stdout.write('partial');",
    "setInterval(()=>{},1000);",
  ].join("");

  await assert.rejects(
    runConfirmedCommand(root, {
      command: [process.execPath, "-e", script],
    }, {
      onOutput: () => {
        throw callbackError;
      },
    }),
    (error) => {
      assert.equal(error, callbackError);
      assert.equal(error.result.stdout, "partial");
      assert.ok(Date.parse(error.result.startedAt) <= Date.parse(error.result.completedAt));
      return true;
    },
  );
  assert.equal(await fs.readFile(stopped, "utf8"), "yes");
});

test("command runner treats executable shell metacharacters as a literal filename", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-literal-executable-"));
  const marker = path.join(root, "preserve.txt");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(marker, "safe");

  await assert.rejects(
    runConfirmedCommand(root, { command: ["node;rm", marker] }),
    (error) => error.code === "ENOENT",
  );
  assert.equal(await fs.readFile(marker, "utf8"), "safe");
});

test("command runner accepts an executable path containing spaces", { skip: process.platform === "win32" }, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-spaced-executable-"));
  const executable = path.join(root, "node executable");
  const marker = path.join(root, "executed.txt");
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(process.execPath, executable, "file");

  await runConfirmedCommand(root, {
    command: [executable, "-e", "require('node:fs').writeFileSync('executed.txt', 'safe')"],
  });

  assert.equal(await fs.readFile(marker, "utf8"), "safe");
});

test("resolveInsideProject accepts an in-root name that starts with dots", () => {
  const root = path.join(os.tmpdir(), "dev-workbench-project-root");
  assert.equal(resolveInsideProject(root, "..valid"), path.join(root, "..valid"));
});

test("resolveProjectRoot rejects an in-boundary regular file", async (context) => {
  const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "project-boundary-file-"));
  context.after(() => fs.rm(allowedRoot, { recursive: true, force: true }));
  const projectFile = path.join(allowedRoot, "project.txt");
  await fs.writeFile(projectFile, "not a directory\n", "utf8");

  await assert.rejects(
    resolveProjectRoot(projectFile, allowedRoot),
    /project root must be a directory/i,
  );
});

test("command runner rejects a cwd symlink that escapes the project", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-cwd-boundary-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  const marker = path.join(outsideRoot, "executed.txt");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  await fs.symlink(outsideRoot, path.join(projectRoot, "link"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    runConfirmedCommand(projectRoot, {
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt', 'unsafe')"],
      cwd: "link",
    }),
    /project boundary/i,
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("command runner rejects a canonical project root replaced by a symlink", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-root-boundary-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "moved-project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  const marker = path.join(outsideRoot, "executed.txt");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  const canonicalRoot = await fs.realpath(projectRoot);
  await fs.rename(projectRoot, movedRoot);
  await fs.symlink(outsideRoot, projectRoot, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    runConfirmedCommand(canonicalRoot, {
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt', 'unsafe')"],
    }),
    /project root.*symbolic link/i,
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});
